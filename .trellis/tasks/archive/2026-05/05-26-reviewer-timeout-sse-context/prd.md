# reviewer 稳定性:软超时、SSE 重试、上下文收敛

## Goal

让 `flower-code-reviewer` 在 GitLab CI 中具备可控的失败边界:LLM / SSE 卡住时不能等到 10 分钟 job 硬超时才失败,接口失败或空 SSE 应有限重试,大 MR 不能因为 prompt 要求「每个文件拉全文」而无脑灌入上下文。

## Background / Known Context

- 用户反馈 `xhgj-iqs-ui` job `10391` 10 分钟超时后被 GitLab 标成 failed,不合理。
- 已用 `GLAB_NEW_TOKEN` 拉取 job 10391:job `code-review`,`failure_reason=job_execution_timeout`,`duration=600`,`allow_failure=true`,pipeline 为 success。
- trace 显示 runner 设置 `activeDeadlineSeconds=10m0s`;reviewer 在第 3 轮进入模型生成后无新 tool call,直到 GitLab 10 分钟硬杀。
- 同一 trace 中 LLM 先读 `gitlab_get_mr_diff` 得到约 60KB diff,随后并发调用 10 个 `gitlab_get_file_content`,多个文件结果在 10KB 到 50KB 级别。
- 当前 `prompts.ts` 明确要求「每个变更文件必须调用 `gitlab_get_file_content` 拉完整内容」,这是无脑拉上下文的直接诱因。
- `devops-infra-harness` 的 `templates/projects/application.yml` 中 `.flower-code-review` 写死 `timeout: 10 minutes`,这是 GitLab Runner trace 中 `activeDeadlineSeconds=10m0s` 的来源。
- 内网 GitLab `18.10.1` 项目级 CI lint 已验证:`timeout: $FLOWER_REVIEW_JOB_TIMEOUT` 会报 `jobs:job:timeout config should be a duration`,因此 job timeout 不能按 CI/CD 变量动态展开。
- `pi-coding-agent` 已有 auto-retry:错误信息命中 `timeout` / `fetch failed` / `502` / `504` / `ended without` 等时默认最多重试 3 次。
- `pi-ai` provider 支持 `timeoutMs` / `maxRetries`,但 `code-reviewer` 走 `piMain` CLI 路径,没有显式传 provider timeout;未配置时可能落到 SDK 默认 10 分钟级等待。
- `pi` auto-compaction 默认开启,但只能压缩多轮历史,不能阻止单轮 tool result 或单次 provider 请求把 CI 时间吃完。
- 用户已选择方案 1:infra-harness 默认 CI hard timeout 调到 `20 minutes`;reviewer 默认 soft timeout 最初讨论为 `8 minutes`,后续认为偏短,调整为 `18 minutes`,给 warning 评论收尾预留约 2 分钟。
- 用户进一步明确上下文收敛方向:不应只按文件数限制,而是给 `gitlab_get_file_content` 增加 `startLine` / `endLine` 入参,默认读取 `500` 行有限行窗;如果模型没拿到想要的数据,再按相邻行段续读。

## Requirements

- R1:infra-harness 的 `.flower-code-review` 默认 GitLab job timeout 从 `10 minutes` 调整为 `20 minutes`,容纳 reviewer 软超时、有限重试和 warning 评论收尾。
- R2:reviewer 必须有总评审软超时,默认早于 GitLab job 硬超时触发。
- R3:软超时触发后,reviewer 应尽力发表一条整体 warning 评论,提示自动评审未完成、需手工 review,然后 `exitCode=0` fail open。
- R4:LLM provider 单次请求必须配置明确超时,不能依赖 SDK 默认 10 分钟。
- R5:SSE 空响应、无 finish、网络失败、429/5xx 等 transient 错误应有限重试;重试耗尽后走现有 LLM fail open,不能无限等待。
- R6:`gitlab_get_file_content` 必须支持按行窗读取(`startLine` / `endLine`),默认不要整文件返回。
- R7:上下文读取策略要从「每个变更文件拉全文」改为「基于 diff 先判断,优先读取变更行附近有限行窗;需要更多上下文时再续读相邻行段」。
- R8:仍保留「发某文件行内评论前必须读过该文件」的真实性约束,避免无依据评论。
- R9:读取预算必须可配置,默认限制单次读取行数和每轮批量拉文件数量,避免一次性并发读取十几个大文件或大段代码。
- R10:所有新增配置必须有合理默认值,并可通过 `FLOWER_*` 环境变量覆盖。

## Acceptance Criteria

- [ ] AC1:模拟 `piMain` 长时间不 resolve,`runReview` 在软超时内返回 `exitCode=0`,并调用 `postMrComment(..., "minor")`。
- [ ] AC2:软超时 warning 文案包含「自动评审超时」「请手工 review」。
- [ ] AC3:provider 请求超时配置能通过 reviewer 启动期注入到 pi settings,不污染用户全局 `~/.pi/agent/settings.json`。
- [ ] AC4:默认 provider 单次超时短于 reviewer 总软超时;总软超时短于 infra-harness 默认 CI hard timeout。
- [ ] AC5:`isLlmFailure` 明确覆盖空 SSE / 无 finish / stream ended / timeout 类错误。
- [ ] AC6:`gitlab_get_file_content` schema 支持 `startLine` / `endLine` 可选参数,传入后只返回该闭区间行内容。
- [ ] AC7:未传行号时,工具默认返回文件开头有限行窗,并在返回内容中提示可用下一段行号续读,而不是返回整文件。
- [ ] AC8:prompt 不再要求「每个变更文件必须拉完整内容」。
- [ ] AC9:prompt 明确要求「基于 diff 初筛,优先读取变更行附近有限行窗;只有需要更多上下文时才续读相邻行段」。
- [ ] AC10:prompt 明确要求批量读取每轮不超过预算,优先按风险/疑点读取。
- [ ] AC11:现有「未读文件直接发该文件行内评论 → 无依据评论 blocker」逻辑保持有效。
- [ ] AC12:单元测试覆盖超时 fail open、provider settings 注入、prompt 上下文策略变化、行窗读取截断/续读提示。
- [ ] AC13:`devops-infra-harness/templates/projects/application.yml` 的 `.flower-code-review` 默认 timeout 更新为明确固定时长,并在文档说明业务方如需特殊值可同名 job override。

## Decision (ADR-lite)

**Context**:GitLab CI job `timeout` 不能使用 CI/CD 变量动态展开,而当前 `10 minutes` hard timeout 会让 runner 在 reviewer 还没来得及 fail open 前直接杀进程。

**Decision**:采用“保守稳定”默认值:infra-harness `.flower-code-review timeout: 20 minutes`;reviewer 业务软超时默认 `FLOWER_REVIEW_TIMEOUT_MS=1080000`(18 分钟)。

**Consequences**:默认链路能在 LLM 卡住时由 reviewer 自己发 warning 并 `exitCode=0`;极端底层请求不可取消时,GitLab 仍保留 20 分钟最终硬上限。特殊业务仓如果需要更严格或更宽松时长,通过同名 `code-review` job override `timeout`。

## Definition of Done

- 单元测试更新并通过。
- `npm test --workspace @flower-ai/flower-code-reviewer` 通过。
- 涉及共享配置或行为变更时更新 `.trellis/spec/`。
- 不改业务方 GitLab 项目的 `.gitlab-ci.yml`。
- 跨仓修改 `devops-infra-harness` 时,单独说明 diff、验证方式与提交边界。

## Out of Scope

- 不尝试用 CI/CD 变量动态展开 GitLab job `timeout`(GitLab lint 已验证不支持)。
- 不重写 pi / pi-ai 上游源码。
- 不改 GitLab runner / Kubernetes 配置。
- 不引入新的 LLM SDK。

## Research References

- 本任务内联调研:job 10391 API 元数据与 trace。
- 本地源码:`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` auto-retry。
- 本地源码:`node_modules/@earendil-works/pi-ai/dist/types.d.ts` provider `timeoutMs` / `maxRetries`。
- 内网 GitLab 18.10.1 项目级 `ci/lint`:验证 `timeout: $FLOWER_REVIEW_JOB_TIMEOUT` 非法。
