# @flower-ai/flower-telemetry

观测事件管道:pi 事件归一化 + 可插拔 sink。

为评审质量迭代(回放评估集、评论采纳率指标)提供数据基座;同时承载 SIEM 安全审计上报
(自 `@flower-ai/flower-compliance` 收编,payload 兼容)。

## 架构

```
pi 原始事件(ExtensionAPI)
    │
    ▼
registerTelemetry(pi, { product, sinks })      ← pi-adapter:唯一的 pi 耦合点
    │
    ▼
TelemetryPipeline                              ← 唯一的归一化层:
    │   信封注入(traceId/seq/ts) → 脱敏(secret 正则) → 截断 → fanout
    ▼
    ├─ jsonlSink(path)         JSONL 文件(CI artifact,数据基座)
    ├─ consoleSink({format})   stdout 打印(pretty 人读 / json 机器检索)
    ├─ httpSink({url})         批量 NDJSON 实时推送(常驻观测服务 flower-observer)
    └─ siemSink()  [critical]  SIEM 审计(metadata-only,不受总开关影响)
```

与 `@flower-ai/flower-compliance`(纯策略包)平级、互不依赖。compliance 拦截事件经其
`onBlock` 回调由产品层接到本包 `recordSecurityEvent`,作为 `security_block` outcome 进
trace 并上报 SIEM(`tool_blocked`)— 这同时修复了旧架构"被拦截的 tool_call 因事件链
短路漏审计"的缺陷(telemetry 的 tool_call 监听必须**先于** compliance 注册)。

## 事件模型(三层)

一次 run = 一条 trace,JSONL 一行一事件,`seq` 单调递增:

| kind | 说明 |
|------|------|
| `trace_start` | run 开始;含关联键 `correlation`(project / mrIid / commitSha / pipelineId,取自 CI env,缺省 "unknown") |
| `span` | 过程事件(完成时刻发出):`agent` / `turn`(含计时分解)/ `llm_call` / `tool_call`(调用意图,含脱敏 input)/ `tool_result` |
| `outcome` | 结果真值:`line_comment` / `self_check` / `security_block` / `run_summary` |
| `trace_end` | run 结束;含 totals(turns / toolCalls / durationMs) |
| `stream` | 流式显示信号(thinking/text 增量等),**仅供 consoleSink,不落盘不上报不推送** |

## 内置 sink

| sink | 内容 | 去向 | 开关 |
|------|------|------|------|
| `jsonlSink(path)` | 全量(已脱敏截断) | 本地 JSONL 文件 | `FLOWER_TELEMETRY=0` 关 |
| `consoleSink({format:"pretty"\|"json"})` | pretty:人读 CI 日志;json:一行一事件带 traceId | stdout | 同上(产品层一般再叠 `FLOWER_VERBOSE`) |
| `httpSink({url, token?})` | 全量(与 jsonlSink **同一行格式**) | 批量 NDJSON POST 到观测服务 | `FLOWER_TELEMETRY=0` 关 |
| `siemSink()` | **metadata-only**(工具名/字段名/成败,绝无入参值) | POST `SIEM_INGEST_URL` | **critical,不可关** |

`siemSink` payload 与旧 `flower-compliance` 的 `sendAudit` 完全兼容
(`session_start` / `tool_call`+`inputKeys` / `tool_result`+`isError` / user / host),
新增 `tool_blocked` kind(拦截事件)与 `traceId` 字段(关联全量 trace)。

### httpSink 线协议(即观测服务的 ingest 契约)

- `POST <url>`(URL 即完整端点,语义对齐 `SIEM_INGEST_URL`,不额外拼路径),
  `Content-Type: application/x-ndjson`,body 每事件一行 `JSON.stringify`
  —— **与 JSONL 文件逐字节同格式**,服务端一个解析器吃 HTTP 推送与 artifact 文件两种来源
- 配置 `token` 时附 `Authorization: Bearer <token>`
- `2xx` 为成功;其余(含超时/网络错误)整批留缓冲随下次触发重试 —— 超时场景请求可能已被
  服务端写入,**服务端必须按 `(traceId, seq)` 幂等去重**
- 批量与可靠性:攒批发送(默认 50 条 / 2s 触发间隔),缓冲有界(默认 2000 条,超出丢最旧),
  失败 fail-open 静默(`DEBUG_TELEMETRY=1` 才 warn);跨 run 不持久化(artifact 是备份通道)

## 用法(code-reviewer 实例)

```typescript
import { consoleSink, jsonlSink, recordSecurityEvent, registerTelemetry, siemSink } from "@flower-ai/flower-telemetry";

export default function (pi: ExtensionAPI) {
	// 顺序契约:telemetry 必须先于 compliance 注册(被拦截的调用意图才会进 trace)
	registerTelemetry(pi, {
		product: "code-reviewer",
		sinks: [consoleSink({ format: "pretty" }), jsonlSink("flower-review-trace.jsonl"), siemSink()],
	});
	registerCompliance(pi, {
		mode: "ci-readonly",
		product: "code-reviewer",
		onBlock: (e) => recordSecurityEvent({ tool: e.toolName, mode: e.mode, reason: e.reason }),
	});
}
```

run 主流程收尾(写业务 outcome + 冲刷):

```typescript
import { finishTelemetryTrace, flushTelemetry, getTelemetryPipeline } from "@flower-ai/flower-telemetry";

getTelemetryPipeline()?.emit({ kind: "outcome", outcomeType: "run_summary", runSummary: { ... } });
finishTelemetryTrace();      // trace_end(累计 totals)
await flushTelemetry();      // JSONL 落盘 + 在途 SIEM 上报收尾
```

## 脱敏(defense-in-depth)

pipeline 对 `span.input` / `span.result` / `securityBlock.reason` 等字段统一执行
**先 redact 后 truncate**(截断可能把 secret 切半逃过正则):

- 覆盖:GitLab PAT(`glpat-`)、`Bearer` 头、PEM 私钥块、阿里云/AWS AK、JWT、URL 内嵌凭证、`token=/api_key=` 赋值形态
- 纯流式增量(`text_delta` 等)不脱敏(逐片正则必然漏),与 CI stdout 直出行为一致;且 stream 事件不落盘

## 环境变量

| 变量 | 必填 | 含义 |
|------|:----:|------|
| `FLOWER_TELEMETRY` | | `0/false/off/no` 关闭非 critical sink;默认开 |
| `SIEM_INGEST_URL` | | 审计端点;留空不上报(critical 语义只保证"不被总开关关闭") |
| `DEBUG_AUDIT` | | `=1` 时本地打印审计记录 / 上报失败 warn(与旧 compliance 行为一致) |
| `DEBUG_TELEMETRY` | | `=1` 时打印 sink 故障 warn(默认静默) |
| `CI_PROJECT_PATH` / `CI_MERGE_REQUEST_IID` / `CI_COMMIT_SHA` / `CI_PIPELINE_ID` | | 关联键来源(GitLab CI 自动注入;缺省 "unknown") |

## 后续规划(Out of Scope,见任务 PRD)

- flower-observer 常驻观测服务(httpSink 的接收端:幂等 ingest / 存储 / UI / artifact 补拉)
- ops-bot 接入:需 pi-agent-core adapter(本包内核已与 pi ExtensionAPI 解耦,sink 全部可复用)
- GitLab 回流信号离线 job(评论 resolve 率)与回放评估工具链
