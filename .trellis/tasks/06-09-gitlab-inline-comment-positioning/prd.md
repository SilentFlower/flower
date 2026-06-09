# 优化 GitLab MR 行内评论定位

## Goal

降低 code-reviewer 因行号不在 GitLab MR diff 可评论范围内而降级为普通评论的概率，并在无法行内评论时给出可诊断的原因，避免用户看到“原计划行内评论位置不可用”却不知道是模型行号选择问题、GitLab diff 限制，还是接口异常。

## Background / Known Context

- 真实问题来自 MR 47：`http://gitlab.xhgjdev.com/digital-biz-projects/iqs/xhgj-iqs-ui/-/merge_requests/47`。
- 机器人评论 note `4492` 在 `2026-06-03 09:17:35 +0800` 发出，`position: null`、`resolvable: false`，说明它是普通 MR note，不是行内 discussion。
- 原计划位置为 `src/pages/procurement/shared/taskExportFields.ts:295`。
- GitLab API `/changes` 显示该文件可评论的新行主要在 `20-25`、`175-176`、`307-315`，第 `295` 行不在可评论 hunk 中。
- 第 `295` 行是已存在函数 `normalizeTaskExportSelectedFields` 的完整文件行号；评论内容实际针对新增的图片字段规范化逻辑，合理行内位置更接近 `307-315`。
- 当前 `flower-tools-gitlab/src/client.ts` 的 `postMrLineComment` 只做 exact match：`collectCommentableNewLines(changedFile.diff).has(input.line)`，不满足时直接降级整体评论。
- 当前 `gitlab_get_mr_diff` 返回普通 unified diff，模型容易混用 `gitlab_get_file_content` 的完整文件行号和 GitLab diff 可评论行号。

## Requirements

- R1：`gitlab_get_mr_diff` 返回内容必须让模型明确看到 MR diff 中每个 hunk 的新文件行号，以及哪些行是新增行、上下文行或删除行。
- R2：prompt 必须明确要求 `gitlab_post_line_comment.line` 优先使用 MR diff 中标记出的可评论新文件行号，不能把文件行窗里的完整文件行号直接当作可评论位置。
- R3：`gitlab_post_line_comment` 在目标行不可评论时，应尝试在同文件同 diff 的近邻范围内找到更合适的可评论行，减少普通评论降级。
- R4：自动重定位必须保守，不能把评论挂到明显无关的 hunk 上。
- R5：含 GitLab `suggestion` 代码块的评论不能因自动重定位导致错误 patch 应用；如果无法安全重定位，应保留降级或去除 suggestion 语义后再行内评论。
- R6：降级为普通评论时，fallback 文案必须包含不可用原因和候选可评论行，便于用户诊断。
- R7：行为变化必须有单元测试覆盖，包括行号标注、近邻重定位、距离过远不重定位、suggestion 安全策略和 fallback 诊断文案。

## Acceptance Criteria

- [ ] 对 MR diff 中的新增行和上下文行，`gitlab_get_mr_diff` 输出可读的新文件行号标记。
- [ ] prompt 明确区分“文件行窗行号”和“MR diff 可评论行号”。
- [ ] 当目标行距离同文件可评论 hunk 很近且评论不含 `suggestion` 时，工具自动改挂到最近可评论行，并在评论正文中说明原目标行和实际挂载行。
- [ ] 当目标行距离可评论 hunk 过远时，工具仍降级为普通评论，并说明最近候选行。
- [ ] 当评论包含 `suggestion` 且目标行不可评论时，不产生可能应用到错误行的 GitLab suggestion。
- [ ] `LineCommentResult` 能反映实际是否重定位，便于日志和后续 trace 诊断。
- [ ] `npm test --workspace @flower-ai/flower-tools-gitlab` 通过。
- [ ] `npm test --workspace @flower-ai/flower-code-reviewer` 中相关 prompt 测试通过。

## Definition of Done

- Tests added/updated（至少覆盖 GitLab 工具客户端和 prompt）。
- TypeScript 类型检查通过。
- 不新增重型 GitLab SDK 或额外运行时依赖。
- 不输出 token、完整评论正文或大段 diff 到日志。
- 需要更新的 Trellis spec 已记录或确认无需更新。

## Out of Scope

- 不修复 MR 47 业务代码本身。
- 不实现跨文件语义定位或 AST 级别评论定位。
- 不修改 GitLab 已存在的历史评论。
- 不新增删除 / 编辑 GitLab 评论的 API。
- 不改变 reviewer 的 blocker 判定逻辑。

## Research References

- 真实 MR API 排查记录：本任务对话中已确认 MR 47 `/changes` 与 note `4492` 事实。
