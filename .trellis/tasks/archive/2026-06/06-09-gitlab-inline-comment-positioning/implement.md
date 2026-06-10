# 优化 GitLab MR 行内评论定位

## Implementation Checklist

- [x] 阅读 `flower-tools-gitlab` 和 `flower-code-reviewer` 相关 spec 明细，确认注释、错误处理、日志约束。
- [x] 在 `client.ts` 增加 diff hunk 行号解析 / 标注 helper，并保留 `collectCommentableNewLines` 兼容导出。
- [x] 调整 `getMrDiff` 输出，把 MR diff hunk 行渲染为带 `add/ctx/del` 和新文件行号的文本。
- [x] 增强 `postMrLineComment`：
  - [x] exact match 仍按原逻辑发送行内 discussion。
  - [x] 目标行不可评论时计算最近候选行。
  - [x] 无 suggestion 且距离阈值内时自动重定位。
  - [x] 含 suggestion 或距离过远时 fallback，并写清原因和候选行。
  - [x] 返回 `LineCommentResult` 的重定位诊断字段。
- [x] 更新 `prompts.ts`，明确行内评论行号只能来自 MR diff 可评论标记，文件行窗行号仅供上下文。
- [x] 更新 `client.test.ts`：
  - [x] 标注 diff 输出包含新文件行号和 `add/ctx/del`。
  - [x] 可评论 exact match 行为保持不变。
  - [x] 近邻不可评论行自动重定位。
  - [x] 距离过远 fallback。
  - [x] suggestion 不重定位且 fallback 文案说明安全原因。
  - [x] fallback 候选行稳定。
- [x] 更新 `prompts.test.ts` 覆盖新约束。
- [x] 运行验证命令。

## Validation

- `npm test --workspace @flower-ai/flower-tools-gitlab`
- `npm test --workspace @flower-ai/flower-code-reviewer`
- `npm run build --workspace @flower-ai/flower-tools-gitlab`
- `npm run build --workspace @flower-ai/flower-code-reviewer`
- `npx biome check --write packages/flower-tools-gitlab/src/client.ts packages/flower-tools-gitlab/src/index.ts packages/flower-tools-gitlab/src/__tests__/client.test.ts packages/flower-code-reviewer/src/prompts.ts packages/flower-code-reviewer/src/__tests__/prompts.test.ts`
- `npm run typecheck`

## Review Gates

- 实现前：确认 PRD / design / implement 三件套与用户期望一致。
- 检查时：走 Trellis check 路由，不直接跳过质量检查。

## Rollback Points

- 若 diff 标注影响模型理解，可只回退 `getMrDiff` 渲染，保留工具侧重定位。
- 若重定位出现误挂，可关闭或删除重定位分支，恢复 exact match + 诊断 fallback。
