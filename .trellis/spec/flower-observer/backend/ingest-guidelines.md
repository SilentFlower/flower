# Ingest Guidelines

> httpSink 线协议**服务端**实现要点:幂等、禁 3xx、坏行容忍、跨通道计数去重。
> 客户端(发送侧)语义见 [flower-telemetry sink 指南](../../flower-telemetry/backend/sink-guidelines.md)。

---

## 线协议总览

- 请求体 NDJSON:每行一个 `JSON.stringify(TelemetryEvent)`,**与 JSONL artifact 逐字节一致**
  → `ingestNdjson` 同时消费 HTTP 推送与文件导入两种来源,一个解析器两个入口
- 响应码契约(`routes/ingest.ts`):**2xx = 成功,其余客户端整批重试;绝不返回 3xx**
  (重定向会被客户端 fetch 跟随或判失败,语义混乱)。
  注意契约只约束 `/v1/*`;页面路由 `GET /` 302 跳 `/traces` 不受限(`routes/pages.ts`)
- 响应体原样回 `IngestResult` 计数器:`{accepted, skipped, badLines}`
- 鉴权可选:配置 token 时校验 `Authorization: Bearer`,失败 401(客户端 fail-open 不受影响);
  未配置 = 内网裸跑

## 幂等(超时重发不重计)

- 客户端超时场景请求**可能已被服务端写入**,会重发同批 → 服务端按 `(trace_id, seq)` 主键冲突跳过(`skipped` 计数)
- **聚合增量(touchTrace / materialize)只在事件「实际插入」后执行**——这是幂等不重计的全部机制,
  依赖 `insertEventIfAbsent` 的 `changes > 0` 返回值(见 [database 指南](./database-guidelines.md))
- 整批单事务:幂等 upsert + 聚合物化 + 收尾状态重判一起提交;失败回滚后客户端整批重试,不会半批落库
- payload 存**行原文**(非 re-stringify),保证落库内容与来源逐字节一致

## 坏行容忍(单行失败不拒整批)

```typescript
const event = parseEventLine(trimmed);
if (event === undefined) {
	result.badLines += 1;   // 计数跳过,继续下一行
	continue;
}
```

- 坏行判定(`parseEventLine`):JSON parse 失败 / 非对象行 / 信封五字段(traceId / product / kind / seq / ts)
  缺失或类型不符 / `kind === "stream"`(契约上不会推送的显示信号,且 delta 不脱敏,出现即坏行)
- **未知 kind 容忍入库**(schema 演进零迁移,仅不参与聚合)——坏行是"信封坏",不是"kind 新"
- 诊断输出默认静默,`DEBUG_OBSERVER=1` 才单行 warn 且原文截断 200 字符(避免坏源刷爆日志)
- 字段防御:已过信封校验的事件,业务字段仍以 `??` 兜底缺省值(correlation 缺失回退 `"unknown"`、
  totals 非数值回退 0),坏数据不致崩批

## 批末收尾状态重判

```typescript
// 放在批末而非逐事件,覆盖「trace_end 先到、缺口事件后到补齐」的重发翻转场景
for (const traceId of touched) {
	const row = db.getTrace(traceId);
	if (row !== undefined && row.ended_at !== null) {
		db.setTraceStatus(traceId, deriveEndedStatus(row));
	}
}
```

事件可乱序、可重发,任何"先到事件时算好的状态"都可能被后到事件翻转——
状态推导必须放在批末对本批触达的全部 trace 重算,且仍在同一事务内。

## 跨通道计数去重(security_block × tool_blocked)

同一次工具拦截可能经**两个通道**各到达一次:

| 通道 | 事件 | 入库表 |
|------|------|--------|
| events(httpSink 推送) | `outcome/security_block` | events + traces.block_count |
| SIEM 审计(`POST /v1/audit`) | `tool_blocked` 投影 | security_events + traces.block_count |

**去重依据**:投影与源事件共享 `(traceId, tool, ts)` 自然键(投影生成时复制源事件 ts)。
两侧入库前都查对方通道是否已计数,**后到方不再 ++**:

- events 侧(`materializeOutcome`):`db.hasToolBlockedAudit(traceId, tool, ts)` 已有 → 跳过 `applySecurityBlock`
- audit 侧(`ingestAudit`):`hasMatchingSecurityBlockOutcome`(查同 ts 的 outcome 事件并 parse 判定子类型 + tool)
  已有 → 跳过

**只去重计数,不去重明细**:两表都保留各自记录(详情页拦截表读 events 全量),`block_count` 仅供列表 / 指标列。
audit 侧的 trace 行尚不存在时容忍(仅存审计,不计数)。

## Common Mistakes

- ❌ ingest 端点返回 3xx(客户端 fetch 跟随或判失败;`/v1/*` 只许 2xx/4xx/5xx)
- ❌ 坏行直接 4xx 拒整批(一行坏数据毒死整批好数据;必须计数跳过)
- ❌ 拒收未知 kind(schema 演进需要零迁移容忍;只拒"信封坏")
- ❌ 逐事件判定收尾状态(乱序 / 重发会留下错误终态;必须批末重判)
- ❌ 聚合与插入拆成两个事务(中间崩溃 = 计数与事件不一致;整批一事务)
- ❌ 跨通道去重时连明细一起丢(audit 明细与 events 明细职责不同,只去重计数)
- ❌ 坏行 warn 不截断原文、默认常开(坏源会刷爆日志;默认静默 + 200 字符截断)
