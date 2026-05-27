# 讨论 code-reviewer 跨项目上下文工具

## Implementation Checklist

- [x] 在 worktree 中从 `main` 创建开发分支。
- [x] 阅读 `flower-code-reviewer` 相关 spec、工具定义、GitLab 工具实现和测试。
- [x] 确认现有 agent 工具注册机制与 GitLab token 注入方式。
- [x] 确认不新增 `gitlab_search_project_blobs`，避免实现偏离本地 `rg` 搜索方案。
- [x] 设计并实现 `gitlab_list_group_projects`。
- [x] 设计并实现 `gitlab_list_project_branches`。
- [x] 设计并实现 `gitlab_prepare_project_workspace`。
- [x] 更新 reviewer prompt/规则，明确 harness 文档优先级和当前项目 `doc/` 的降权策略。
- [x] 为 prompt 新增测试，覆盖跨项目上下文段、3 个工具名、`rg` 搜索引导、明确禁止 `gitlab_search_project_blobs`。
- [x] 增加单元测试或集成测试，覆盖白名单、ref、缓存、错误和 token 隐藏。

## Validation

- `npm run build`
- `npm --workspace @flower-ai/flower-tools-gitlab test`
- `npm --workspace @flower-ai/flower-code-reviewer test`
- `npm run check -- --no-errors-on-unmatched`
- 真实 helper 验证：`prepareProjectWorkspace('digital-biz-projects/iqs/iqs-harness', 'v1.4')` 成功 checkout 到 commit `79507fe7`

## Check-All Notes

- 三件套对照：3 个 MVP 工具已实现并注册；未实现 `gitlab_search_project_blobs`；prompt 已加入跨项目上下文引导。
- 假设验证：GitLab group/projects、branches API URL 编码和响应映射有单测；真实 Git smart HTTP 使用 `PRIVATE-TOKEN` header 可访问 harness。
- 安全边界：project/group 白名单、alias/ref 校验、固定上下文目录、token 不返回、缓存仓库 reset + clean 已覆盖。
- 已知外部 warning：`npm run check` 仍报告既有 `intro.html` specificity/`!important` warning 和 `flower-ops-bot` 既有 `any` warning；本次改动无 Biome error。

## Review Gates

- 开始实现前确认 MVP 工具清单保持 3 个工具，且不实现 `gitlab_search_project_blobs`。
- 若现有 GitLab 工具体系不支持本地 clone/fetch，需要回到设计讨论再决定是否拆为外部脚本。
- 实现完成后必须验证不会输出 token。
