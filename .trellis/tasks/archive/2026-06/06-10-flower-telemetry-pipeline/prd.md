# flower-telemetry 管道与 sink 体系（compliance 瘦身 + 打印消费者 + SIEM 收编）

## Goal

新建共享包 `@flower-ai/flower-telemetry`，作为两产品统一的**观测事件管道**（pi 事件归一化 + 可插拔 sink），
为后续 code-reviewer 评审质量迭代（回放评估集、评论采纳率指标）打数据基座。
同时完成三项配套改造：compliance 瘦身为纯策略包、observability.ts 降级为 console 打印 sink、SIEM 上报收编为 metadata-only 的 siemSink。

## Background / Known Context

现状三条"观测相关"链路并存、各自为政：

| 机制 | 内容 | 形态 | 问题 |
|------|------|------|------|
| `flower-compliance` 审计（`sendAudit`） | 元数据（工具名/inputKeys/成败） | POST `SIEM_INGEST_URL` | 从未配置过接收端 = 死代码；**被 ci-readonly 拦截的 tool_call 因事件链短路反而不上报**（`docs/intro.html:3910` 已记录待修复） |
| `flower-code-reviewer/src/observability.ts`（374 行） | 思考/输出/工具 IO（截断 400 字符）+ turn 计时 | CI stdout | 自带一套 pi 事件理解层，telemetry 出现后必然与之漂移 |
| `flower-code-reviewer/src/review-trace.ts` | readFiles / lineComments / workspacePrepareCount | 进程内存，run 后即弃 | 自检产物（无依据评论等）没有持久化，无法用于离线分析 |

关键架构事实（仓库侦察确认）：

* pi `ExtensionAPI` 事件面充足：`before_agent_start`（prompt + systemPrompt）、`turn_start/end`、`message_start/update/end`、`tool_call/tool_result`、`before_provider_request` / `after_provider_response`、`agent_start/end`（全量 messages）。
* pi 的 `tool_call` handler 按**注册顺序**执行且 `{block:true}` 会短路后续 handler —— telemetry 的监听必须注册在 compliance 拦截**之前**才能看到全部调用意图。
* **ops-bot 不是 pi 扩展模型**：`packages/flower-ops-bot/src/agent-factory.ts` 直接用 `@earendil-works/pi-agent-core` 的 `Agent` + `streamSimple`，无 `ExtensionAPI`。README 中"ops-bot 加载 compliance（production-readonly）"是规划性描述，当前架构挂不进去。→ telemetry 内核必须与 pi ExtensionAPI 解耦（adapter 分层），ops-bot 接入留待后续写 pi-agent-core adapter。
* code-reviewer 注册顺序（`extension.ts`）：providers → compliance → tools → reviewer-self-tools → review-trace 监听 → observability。
* run.ts finalize 阶段（`run.ts:394`）读 review-trace 算 `unsupportedFiles` / `scanForBlockers` → 决定 exitCode，是 outcome 事件的天然挂载点。
* monorepo：npm workspaces + tsc project references（根 `tsconfig.json` references 列表）+ biome + vitest，新包需同步加入。
* 既有测试：`flower-compliance/src/__tests__/audit.test.ts`（110 行，随 sendAudit 迁往 telemetry）、`index.test.ts`（368 行，拦截部分保留）。

## Decision (ADR-lite)

**Context**: 审计(安全)与观测(产品迭代)的设计约束相反（内容最小化 vs 内容全量、不可关 vs 可配置）；同时三套 pi 事件理解层并存会持续漂移。

**Decision**:
1. **compliance = 纯策略包**：只做"判定 + 拦截"，新增 `onBlock` 回调把拦截事件交给产品层；删除 `sendAudit`/audit.ts。
2. **telemetry = 管道**：唯一的事件归一化层（trace_id 注入、脱敏、截断、计时），下游全部是 sink（`{ onEvent, flush? }`）。
3. **SIEM = 特殊 sink**：`siemSink`，content policy 固定 metadata-only，`critical: true` 不受总开关/采样影响；沿用 `SIEM_INGEST_URL` 环境变量与 fail-open + 2s 超时姿态。
4. **打印 = 特殊 sink**：`consoleSink({ format: "pretty" | "json" })`，observability.ts 的格式化/计时逻辑搬入；json 格式每行带 traceId，为 ops-bot 多会话并发预留。
5. **互不依赖**：compliance 与 telemetry 平级，耦合点上提到产品 extension.ts（`onBlock → telemetry.recordSecurityEvent`）。
6. **内核与 pi 解耦**：TelemetryEvent 类型 + pipeline/sink 调度独立于 `registerTelemetry(pi, opts)`（pi-extension adapter），将来 ops-bot 写 pi-agent-core adapter 复用全部 sink。

**Consequences**:
* `registerCompliance` 公共 API 破坏性变更（去掉审计行为，新增 `onBlock`），compliance bump minor 版本。
* "拦截事件漏审计"缺陷在本次架构中顺带修复（telemetry 先于 compliance 注册 + onBlock 双保险）。
* ops-bot 本期不接入（架构不通），接受 README 规划与现实的暂时差距。

## Requirements

### R1 新包 `@flower-ai/flower-telemetry`

* 三层数据模型：`trace`（一次 run：trace_id、product、关联键、模型、汇总）/ `span`（过程：llm_call、tool_call、turn）/ `outcome`（结果：评论、自检、安全事件）。
* 关联键：`trace_id` + `project` + `mr_iid` + `commit_sha` + `pipeline_id`（CI env 取值，缺省容忍）。
* `TelemetrySink` 接口：`onEvent(event)` + 可选 `flush()`；事件经统一脱敏/截断后才进 sink。
* 内置 sink：`jsonlSink`（写本地 JSONL 文件，CI artifact 用）、`consoleSink`（pretty/json）、`siemSink`（metadata-only + critical）。
* pi-extension adapter：`registerTelemetry(pi, { product, traceId?, sinks })`，订阅 pi 事件并归一化。
* 总开关/采样仅作用于非 critical sink；siemSink 不受影响。

### R2 compliance 瘦身

* 保留 ci-readonly 拦截全部行为（白名单、命令链拆分、建议文案）。
* `registerCompliance(pi, { mode, product, onBlock? })`：拦截发生时回调 `onBlock(blockEvent)`。
* 删除 `sendAudit` / `audit.ts` / 审计注册；`audit.test.ts` 逻辑迁移为 telemetry `siemSink` 测试。

### R3 code-reviewer 接线

* extension.ts 注册顺序调整：providers → **telemetry**（先注册才能看到被拦截的调用）→ compliance（onBlock 接 telemetry）→ tools → review-trace → （observability 移除，由 consoleSink 接替）。
* `FLOWER_VERBOSE` 语义保留：默认开、`0/false/off/no` 关（控制 consoleSink）。
* run.ts finalize 把 review-trace 产物写为 outcome 事件（评论列表、unsupportedFiles、blockerCount、exitCode）并 `flush()`。
* `.gitlab-ci.example.yml` 增加 JSONL artifact 示例注释。

### R4 文档同步

* 三个包 README 更新（compliance 职责变化、telemetry 新包、code-reviewer 环境变量表）。
* 根 README 包清单 + 路线图条目同步（"接通审计"措辞改为 sink 体系表述）。

## Open Questions

（无 —— 全部收敛）

## Resolved Questions

* Q1（2026-06-10 用户确认）：review-trace outcome 灌入**纳入本期**（已体现在 R3）。
* Q2（2026-06-10 用户确认）：脱敏采用 **secret 正则 + 长度截断**——归一化层统一跑常见 secret 模式（GitLab token、Bearer、AKID/AKSK、PRIVATE KEY 块、URL 内嵌凭证等）替换为 `[REDACTED]`，再做截断；单测覆盖正则集（已体现在 R1）。

## Acceptance Criteria

* [ ] 新包通过 build/typecheck/biome/vitest，并纳入根 tsconfig references 与 workspaces。
* [ ] `splitCommandChain` 等拦截行为测试全部保留通过；compliance 不再发任何 HTTP。
* [ ] 被 ci-readonly 拦截的 bash 调用：telemetry trace 中可见对应 tool_call span（调用意图），且有 toolCallId 可关联的 security_block outcome；siemSink 收到 metadata-only 的 `tool_blocked` 记录（修复漏报缺陷的回归测试）。
* [ ] code-reviewer 跑一次评审产出合法 JSONL trace：含 trace 头、span 流、outcome 事件，关联键齐全。
* [ ] consoleSink pretty 输出与原 observability.ts 关键信息对齐（思考/文本/工具 IO 截断/turn 计时）；json 格式每行含 traceId。
* [ ] `SIEM_INGEST_URL` 未配置时 siemSink 静默；配置时收到的 payload 仅含元数据字段（断言无 input 值）。
* [ ] `FLOWER_VERBOSE=0` 关闭打印的行为与现状一致。

## Definition of Done (team quality bar)

* 单测覆盖：sink 三件、归一化层、onBlock 接线、脱敏函数。
* Lint / typecheck / 全仓 vitest 绿。
* 三包 README + 根 README 同步。
* compliance / telemetry changeset（minor）。

## Out of Scope (explicit)

* ops-bot 接入（需 pi-agent-core adapter，另立任务）；钉钉流式回复 UI 与 telemetry 无关。
* `TELEMETRY_INGEST_URL` HTTP 上报 sink（第二阶段）。
* GitLab 回流信号离线 job（评论 resolve 率等）与指标看板。
* 回放评估集工具链（消费 JSONL 的下游，另立任务）。
* OTLP / OpenTelemetry 协议对接。

## Research References

* 设计讨论已在本会话收敛（2026-06-10），核心结论入 ADR-lite；pi 事件面与 ops-bot 架构事实经仓库侦察确认，无需外部研究。
