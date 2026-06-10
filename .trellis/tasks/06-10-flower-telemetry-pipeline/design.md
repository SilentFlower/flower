# design.md — flower-telemetry 管道与 sink 体系

## Technical Design

### 总体架构（事件流向）

```
pi 原始事件 (ExtensionAPI)
    │
    ▼
[pi-adapter] registerTelemetry(pi, {product, traceId?, sinks})
    │   订阅:session_start / agent_start / turn_start / before_provider_request
    │        / after_provider_response / message_update / tool_call
    │        / tool_execution_start / tool_execution_end / turn_end / agent_end
    │   注:不订阅 before_agent_start(prompt/systemPrompt 不落 trace,见下方决策记录)
    ▼
[pipeline] 归一化核心(与 pi 解耦,纯 TS)
    │   职责:补 traceId/seq/ts → redact(secret 正则) → truncate → fanout
    │   容错:每个 sink.onEvent 包 try-catch,单 sink 故障不影响其余 sink 与主流程
    ▼
    ├─ jsonlSink(path)                     → 本地 JSONL 文件(CI artifact)
    ├─ consoleSink({format:"pretty"|"json"}) → stdout(原 observability.ts 逻辑迁入)
    └─ siemSink({url})  [critical]          → POST SIEM_INGEST_URL(metadata-only)

flower-compliance(平级,互不 import)
    │   tool_call 拦截(ci-readonly) → 返回 {block:true}
    └─ onBlock(blockEvent) 回调 ──→ 产品层接线 ──→ telemetry.recordSecurityEvent()
```

依赖方向:`code-reviewer → {telemetry, compliance}`;telemetry 与 compliance 互不依赖,
耦合点(onBlock → recordSecurityEvent)上提到 `extension.ts`。

### 包结构(新包 packages/flower-telemetry)

```
src/
├── types.ts        # TelemetryEvent 三层模型 + TelemetrySink 接口
├── redact.ts       # secret 正则集 + redactText() + truncate()
├── pipeline.ts     # TelemetryPipeline:seq 管理、redact/truncate、sink fanout、flush
├── pi-adapter.ts   # registerTelemetry(pi, opts):pi 事件 → 归一化事件
├── sinks/
│   ├── console.ts  # consoleSink(pretty/json;turn 计时逻辑自 observability.ts 迁入)
│   ├── jsonl.ts    # jsonlSink(append-only 行写;坏路径降级停写,无需 flush)
│   └── siem.ts     # siemSink(metadata-only 投影 + fail-open POST,自 audit.ts 迁入)
└── index.ts        # 公共导出
```

### 事件模型(types.ts)

```typescript
/** 所有事件共有的信封字段 */
interface TelemetryEventBase {
	traceId: string;   // 一次 run 的唯一 id(优先 CI_PIPELINE_ID+mrIid,否则随机)
	product: string;   // "code-reviewer" | "ops-bot"
	seq: number;       // trace 内单调递增,JSONL 重放排序依据
	ts: number;
}

/** kind 判别联合(每行 JSONL 一个事件) */
type TelemetryEvent =
	| TraceStartEvent   // kind:"trace_start"  关联键 correlation{project,mrIid,commitSha,pipelineId} + model
	| SpanEvent         // kind:"span"         spanType:"turn"|"llm_call"|"tool_call"(含全量 IO,已脱敏) ;blocked?:{reason}
	| OutcomeEvent      // kind:"outcome"      outcomeType:"line_comment"|"self_check"|"security_block"|"run_summary"
	| TraceEndEvent;    // kind:"trace_end"    totals{turns,toolCalls,durationMs} + exitCode
```

要点:
- `SpanEvent(tool_call)` 含 `input`/`result`(脱敏+截断后);拦截结论以独立的 `security_block` outcome 表达(JSONL append-only,不回改已写 span),经 `toolCallId` 与 tool_call span 关联。
- 实现细化:span 在**完成时刻**发出(agent/turn/llm_call/tool_result 带耗时;tool_call 是调用意图);另有 `stream` kind(生命周期瞬间 + thinking/text 增量)仅供 consoleSink,不落盘不上报;turn 计时分解(原 observability 字段语义)归一化进 `span(turn).timing`。
- `correlation` 字段从 CI env 读取(`CI_PROJECT_PATH`/`CI_MERGE_REQUEST_IID`/`CI_COMMIT_SHA`/`CI_PIPELINE_ID`),缺省容忍(本地跑值为 "unknown")。
- 事件结构开放(`[key: string]: unknown` 不使用;字段显式声明,保证 JSONL 消费端可依赖 schema)。

### sink 接口与 critical 语义(pipeline.ts)

```typescript
interface TelemetrySink {
	name: string;
	/** critical sink 不受总开关/采样影响(SIEM 审计的"不可关"属性) */
	critical?: boolean;
	onEvent(event: TelemetryEvent): void;   // 同步签名;内部自行异步(fire-and-forget)
	flush?(): Promise<void>;                 // run 结束时调用(jsonl fsync / siem 在途请求收尾)
}
```

- 总开关:`FLOWER_TELEMETRY=0` 时非 critical sink 全部不挂载;siemSink 照常。
- pipeline 对每个 `sink.onEvent` 包 try-catch + 计数,故障 sink 静默(DEBUG_AUDIT=1 时 warn),绝不抛向 pi 主流程。

### siemSink:与现 sendAudit 的 payload 兼容

迁移 `audit.ts` 逻辑,**字段保持兼容**(kind/product/tool/inputKeys/isError/ts/user/host),
SIEM 端(若将来接入)无需区分新旧格式:

- `span(tool_call)` → `{kind:"tool_call", tool, inputKeys:Object.keys(input), ...}`(只投影字段名,丢弃值)
- `span(tool_call).blocked` → 额外发 `{kind:"tool_blocked", tool, reason}` —— **修复"拦截不上报"缺陷的新增类型**
- `trace_start` → `{kind:"session_start", reason:"startup", ...}`
- fail-open + `AbortSignal.timeout(2000)` + 失败静默(DEBUG_AUDIT=1 时 warn)姿态原样保留。

### consoleSink:observability.ts 逻辑迁移

- `pretty` 格式:迁移现有"思考/文本/工具调用/工具结果 + 截断 400 + turn 计时(首 token 延迟等)"输出,CI 日志视觉不变。
- `json` 格式:一行一事件 `JSON.stringify`,行内自带 traceId/seq —— ops-bot 多会话并发场景的预留(本期不接 ops-bot,仅保证格式可用 + 单测)。
- `FLOWER_VERBOSE` 语义保留:默认开,`0/false/off/no` 关(只作用于 consoleSink 挂载与否,在 code-reviewer 接线层判断)。
- turn 计时所需的 message_update/provider 事件聚合状态,从 observability.ts 原样迁入 console.ts(状态属打印展示层,不进事件模型)。

### compliance 瘦身(R2)

```typescript
/** 拦截事件(传给 onBlock;字段与 siem "tool_blocked" 投影对齐) */
interface BlockEvent {
	toolName: string;
	mode: ComplianceMode;
	reason: string;       // buildBashBlockReason 产物
	command?: string;     // bash 时的原始命令(由 telemetry 脱敏后落盘)
}

registerCompliance(pi, { mode, product, onBlock?: (evt: BlockEvent) => void });
```

- 删除:`src/audit.ts`、`registerAudit`、`sendAudit` 导出、`__tests__/audit.test.ts`(逻辑迁往 telemetry siem 测试)。
- 保留:拦截全部行为与测试(白名单、splitCommandChain、SUGGESTION_BY_CMD)。
- `index.test.ts` 中审计相关断言移除,新增 onBlock 回调断言(拦截时回调一次、不拦截不回调、回调抛错不影响拦截)。

### code-reviewer 接线(R3)

`extension.ts` 注册顺序(关键:telemetry 的 tool_call 监听必须先于 compliance,pi 按注册顺序短路):

```
1. registerHavefunProviders
2. registerTelemetry(pi, { product:"code-reviewer", sinks })   ← 先注册,看得到全部调用意图
3. registerCompliance(pi, { mode:"ci-readonly", product, onBlock: telemetryRecordSecurityEvent })
4. registerCommonTools / registerGitlabTools / registerReviewerSelfTools
5. registerReviewTrace(不动)
6. (registerObservability 删除 —— consoleSink 接替)
```

sinks 装配(新增 `telemetry-setup.ts` 或并入 extension.ts):
- `consoleSink({format:"pretty"})` —— FLOWER_VERBOSE 非关时挂载
- `jsonlSink(FLOWER_TELEMETRY_FILE ?? "flower-review-trace.jsonl")` —— 默认挂载
- `siemSink({url: SIEM_INGEST_URL})` —— critical,始终挂载(无 url 时内部 no-op,与现状一致)

run.ts finalize(`run.ts:394` 附近):
- 取 `getTrace()` 产物 → 逐条 `outcome(line_comment)` + 一条 `outcome(self_check)`(unsupportedFiles/blockerCount)
- 评审结束 → `outcome(run_summary)`(exitCode/skillUsed) + `trace_end` → `await pipeline.flush()`
- extension.ts(模块级注册)与 run.ts(主流程)共享 pipeline 实例:模块级单例,与 review-trace.ts 现行做法一致。

### redact.ts 正则集(Q2 已确认)

覆盖模式(每条配单测正反例):GitLab PAT(`glpat-…`)、`Bearer <token>`、AWS/阿里云 AKID+AKSK、
`-----BEGIN … PRIVATE KEY-----` 块、URL 内嵌凭证(`scheme://user:pass@`)、常见 `xxx_token=/api_key=` 赋值。
策略:替换为 `[REDACTED:<类别>]`;先 redact 后 truncate(避免截断把 secret 切半逃过正则)。

## 决策记录补充(2026-06-10 check-all 后)

**不采集 prompt/systemPrompt(不订阅 before_agent_start)**:回放评估时 prompt 可由
代码版本(镜像 tag / commit)+ `run_summary.skillUsed` 确定性重建;全量 prompt 每条 trace
增大几十 KB 且含大段 diff 内容(脱敏负担),YAGNI。若后续回放工具链确需原始 prompt,
在该任务中追加 `span(prompt)` 采集即可(adapter 分层已预留)。

## 兼容性清单

| 面 | 兼容策略 |
|----|----------|
| `SIEM_INGEST_URL` / `DEBUG_AUDIT` | 变量名与 payload 字段不变(新增 `tool_blocked` kind 为增量) |
| `FLOWER_VERBOSE` | 语义不变(默认开;0/false/off/no 关) |
| CI pretty 日志 | 关键信息(思考/文本/工具 IO/计时)对齐原 observability.ts 输出 |
| `registerCompliance` | **breaking**:不再有审计副作用 + options 新增 onBlock → compliance bump 0.2.0(changeset minor) |
| `@flower-ai/flower-compliance` 导出 | 移除 `sendAudit`(grep 确认仓库内无其他引用) |

## Rollout / Rollback

- 单 PR 合入(包间改动有原子性:compliance 删 audit 与 telemetry 提供 siemSink 必须同批)。
- 回滚 = revert 整个 PR;JSONL artifact 为新增产物,回滚无数据迁移负担。
- 风险点:consoleSink 迁移导致 CI 日志格式 drift → AC 中以"关键信息对齐"验收,逐项对照原 observability.ts 输出。
