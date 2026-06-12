# design.md — flower-telemetry httpSink

## Technical Design

### 定位与事件流

```
TelemetryPipeline(进程内,已有)
    ├─ consoleSink / jsonlSink / siemSink      (全部不动)
    └─ httpSink({url, token?})                 [本任务新增]
         │  忽略 stream;序列化即 JSONL 行格式
         │  攒批 → POST NDJSON(单飞行请求,失败留缓冲重试,有界丢最旧)
         ▼
flower-observer  POST <FLOWER_TELEMETRY_URL>   [服务本体单独立项]
         └─ 按 (traceId, seq) 幂等 upsert(httpSink 超时重发不写重)
```

### 线协议(同时是 observer 立项时的 ingest 契约)

| 项 | 约定 |
|----|------|
| 请求 | `POST <url>`(URL 即完整端点,对齐 `SIEM_INGEST_URL` 语义,不拼路径) |
| Content-Type | `application/x-ndjson` |
| Body | 每事件一行 `JSON.stringify(event)`,**与 jsonlSink 行格式逐字节一致**(服务端一个解析器吃 HTTP 推送与 artifact 文件两种来源) |
| 鉴权 | 配置 `token` 时附 `Authorization: Bearer <token>` |
| 成功判定 | `response.ok`(2xx);其余(含网络错误/超时)= 失败,整批留缓冲重试 |
| 幂等 | 超时场景请求可能已被服务端写入 → 重发同批;服务端按 `(traceId, seq)` 去重,客户端不感知 |

### httpSink 内部机制(src/sinks/http.ts)

```typescript
export interface HttpSinkOptions {
	url: string;
	token?: string;
	batchSize?: number;          // 默认 50:缓冲达到即尝试发送
	flushIntervalMs?: number;    // 默认 2000:距上次发送超过此值时,下一事件触发发送
	maxBufferedEvents?: number;  // 默认 2000:缓冲上限,超出丢最旧(整批丢弃计数,DEBUG 时 warn 一次)
	requestTimeoutMs?: number;   // 默认 2000:AbortSignal.timeout,对齐 siemSink 姿态
}
```

- **入队即序列化**:`onEvent` 把 `JSON.stringify(event)` 字符串推入缓冲
  (保证行格式与 jsonlSink 一致,且后续无对象可变性问题);`kind === "stream"` 直接丢弃。
- **无定时器**:发送只由事件到达触发(`缓冲 ≥ batchSize` 或 `now - lastSendAt ≥ flushIntervalMs`)。
  评审过程中事件密集,尾部由 `flush()` 收口;不引入 `setInterval`(避免挂住进程退出 / unref 兼容问题)。
- **单飞行请求**:同一时刻最多一个 POST 在途(天然保序、简单);在途期间事件继续入缓冲。
- **失败语义**:发送中的批**成功才从缓冲移除**,失败原样留下随下批重试;
  不做退避计算(批间隔天然限频)。
- **有界**:缓冲超 `maxBufferedEvents` 丢最旧;丢弃数累计,`DEBUG_TELEMETRY=1` 时首次丢弃 warn 一行。
- **fail-open**:所有 fetch 异常吞掉(`DEBUG_TELEMETRY=1` 单行 warn,复用 pipeline 的姿态约定);
  `onEvent` 永不抛错。
- **flush()**:等待在途请求 → 把剩余缓冲做最后一次发送(同一超时)→ 失败放弃。
  pipeline 已对 sink.flush 有 allSettled 兜底。
- **非 critical**:不设 `critical`,受 `FLOWER_TELEMETRY=0` 总开关控制(观测语义,非审计)。

### R4:siemSink 审计记录加 traceId(src/sinks/siem.ts)

`projectAuditRecord` 四类投影(session_start / tool_call / tool_result / tool_blocked)
统一补 `traceId: event.traceId`。payload 加字段向后兼容,SIEM / observer 端无需改解析;
观测服务由此可把实时安全事件精确关联到全量 trace。

### 接线(flower-code-reviewer/src/telemetry-setup.ts)

```
FLOWER_TELEMETRY_URL 已配置 → sinks.push(httpSink({ url, token: FLOWER_TELEMETRY_TOKEN }))
```

未配置 = 不挂载(与 consoleSink 受 FLOWER_VERBOSE 控制同一模式);模块 doc 注释同步装配规则。

### 配套修改清单

| 文件 | 改动 |
|------|------|
| `flower-telemetry/src/sinks/http.ts` | 新增 |
| `flower-telemetry/src/index.ts` | 导出 `httpSink` / `HttpSinkOptions` |
| `flower-telemetry/src/types.ts` | 第 7 行注释"jsonlSink / siemSink 必须忽略"补 httpSink |
| `flower-telemetry/src/sinks/siem.ts` | R4 traceId |
| `flower-code-reviewer/src/telemetry-setup.ts` | 挂载逻辑 |
| `.env.example` | `FLOWER_TELEMETRY_URL` / `FLOWER_TELEMETRY_TOKEN`(注释说明默认不配) |
| README ×2(telemetry / code-reviewer) | sink 清单与环境变量表 |
| changeset ×2 | flower-telemetry minor(新 sink + 审计加字段);flower-code-reviewer patch(接线) |

## 兼容性

| 面 | 策略 |
|----|------|
| 未配 `FLOWER_TELEMETRY_URL` | httpSink 完全不挂载,行为与现状逐字节一致(默认零影响) |
| SIEM payload | 仅新增 `traceId` 字段,旧消费端不受影响 |
| `FLOWER_TELEMETRY=0` | httpSink 同 console/jsonl 一并关闭(非 critical) |
| jsonlSink / artifact | 不动,继续作为备份与对账通道 |

## Rollout / Rollback

- 合入后默认无行为变化(env 未配即关);observer 服务就绪后只需在 CI/CD Variables
  配 `FLOWER_TELEMETRY_URL`(+token)即灰度开启,出问题删变量即回滚,无需回退代码。
- 风险点:批量缓冲实现缺陷导致内存增长 → 以"缓冲上限丢最旧"单测钉死;
  超时重发导致服务端重复 → 契约规定 (traceId, seq) 幂等,且 jsonlSink 留有对账基准。
