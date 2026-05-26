# reviewer 稳定性实现计划

## Implementation Checklist

- [x] 0. 更新 infra-harness hard timeout
  - [x] 修改 `devops-infra-harness/devops-infra/templates/projects/application.yml` 的 `.flower-code-review timeout`
  - [x] 更新 `docs/sop-onboard-code-review.md` / `docs/code-review-design.md` 中 10min 行为说明
  - [x] 记录 GitLab lint 验证:变量化 timeout 不支持
- [x] 1. 加 reviewer 运行配置解析
  - [x] `resolveReviewTimeoutMs`
  - [x] `resolveLlmRequestTimeoutMs`
  - [x] `resolveLlmProviderMaxRetries`
  - [x] `resolveLlmAgentMaxRetries`
  - [x] `resolveContextReadBatchSize`
  - [x] `resolveContextReadDefaultLines`
  - [x] `resolveContextReadMaxLines`
- [x] 2. 加隔离 pi settings 注入
  - [x] 写入 `retry.enabled/maxRetries/baseDelayMs/provider.timeoutMs/provider.maxRetries/provider.maxRetryDelayMs`
  - [x] 设置 `PI_CODING_AGENT_DIR`
  - [x] 单测验证不写用户全局路径
- [x] 3. `runReview` 包装 `piMain`
  - [x] `runPiMainWithSoftTimeout`
  - [x] `ReviewSoftTimeoutError`
  - [x] 超时走 fail open warning + exit 0
- [x] 4. 补强 LLM 失败识别
  - [x] SSE 空响应 / no data / finish_reason / message_stop / stream ended
  - [x] timeout / aborted / terminated 保持覆盖
- [x] 5. 改 `gitlab_get_file_content` 行窗读取
  - [x] schema 增加 `startLine` / `endLine`
  - [x] `safeReadFile` 支持按 1-based 闭区间切片
  - [x] 未传行号默认只返回文件开头有限行窗
  - [x] 返回内容带总行数、当前行段、续读提示
- [x] 6. 改 prompt 上下文策略
  - [x] 删除「每个变更文件必读全文」措辞
  - [x] 改为「评论前必须读取该文件相关行窗」
  - [x] 加每轮读取预算、单次行窗预算与续读规则
- [x] 7. 更新单元测试
  - [x] fail-open 超时测试
  - [x] settings 注入测试
  - [x] prompt 策略测试
  - [x] safe-read 行窗读取测试
- [x] 8. 必要时更新 spec

## Validation

- `npm test --workspace @flower-ai/flower-code-reviewer`
- `npm test --workspace @flower-ai/flower-tools-gitlab`
- `npm test --workspace @flower-ai/flower-providers`
- `devops-infra-harness`:静态检查 `application.yml` 片段,必要时用项目级 `/ci/lint` 验证 timeout 字面量合法

## Review Gates

- 开始实现前:确认 PRD/design/implement 已记录用户新增要求。
- 完成后:确认软超时不把 GitLab API/Auth 错误误判为 LLM fail open。
- 跨仓提交前:分别展示 flower 仓与 devops-infra-harness 仓的 git diff/status。
