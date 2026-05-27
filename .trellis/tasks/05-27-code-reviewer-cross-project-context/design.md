# 讨论 code-reviewer 跨项目上下文工具

## Technical Design

MVP 只新增 3 个 GitLab 相关 agent 工具，不新增 `gitlab_search_project_blobs`。跨项目内容定位统一依赖 `gitlab_prepare_project_workspace` 后的本地 `rg`，保持搜索语义、分支和文件过滤可控。

1. `gitlab_list_group_projects`
   - 输入：`group`、`include_subgroups`、可选 `search`。
   - 输出：项目 id、`path_with_namespace`、默认分支、web URL。
   - 用途：让 reviewer 发现同组内可用的 harness/UI/服务项目。

2. `gitlab_list_project_branches`
   - 输入：`project`、可选 `search`、分页参数。
   - 输出：分支名、默认分支标记、保护状态、commit short id、提交时间、标题。
   - 用途：选择 harness 的版本分支，例如 `v1.4`。

3. `gitlab_prepare_project_workspace`
   - 输入：`project`、`ref`、`alias`、可选 `depth`。
   - 输出：本地路径、项目、ref、实际 commit、是否复用缓存。
   - 行为：在固定根目录（例如 `/tmp/review-context/repos`）下按需 shallow clone/fetch 白名单项目；已有缓存时 fetch 指定 ref 并 checkout 到 detached HEAD。
   - 用途：返回路径后，reviewer 继续用已有 `bash` 工具调用 `rg` 做精确搜索。

## Security / Boundaries

- 项目必须通过白名单或同组允许列表校验，禁止任意 Git URL。
- token 只在工具内部用于 GitLab API/git 认证，不能打印到日志或返回给模型。
- `alias` 只能包含安全字符，避免路径穿越。
- clone 根目录固定，避免污染 MR 项目工作区。
- 返回实际 commit，便于 review 依据可追踪。

## Reviewer Flow

1. 在当前 MR 项目中用 `rg` 查代码事实。
2. 当需要业务/需求依据时，优先查配置的 harness 项目。
3. 先用 `gitlab_list_project_branches` 确认目标 ref。
4. 用 `gitlab_prepare_project_workspace` 准备本地目录。
5. 在返回目录中使用 `rg` 搜索文档，并读取命中文件上下文。

## Prompt Guidance

需要在 `flower-code-reviewer` 的主 prompt 中新增一个独立段落，建议放在现有“工具优先级”附近，内容包括：

- **来源优先级**：当前 MR 项目是代码事实来源；业务/需求事实优先查配置的 harness 仓库；当前 MR 项目的 `doc/`、`*.md`、`*.csv` 默认只能作历史线索，不能作为权威依据。
- **触发条件**：当 diff 涉及字段含义、权限规则、导入导出模板、业务状态机、跨端约定、版本需求时，才准备 harness；不要为了普通代码风格问题拉跨项目仓库。
- **分支选择**：优先使用显式配置/用户提供的 ref；其次根据 MR 版本、目标分支或文件名推导版本分支；无法判断时使用 harness 默认分支，并在评论/总结中说明依据来自哪个 ref。
- **工具顺序**：`gitlab_list_group_projects`（必要时发现项目） -> `gitlab_list_project_branches`（确认 ref） -> `gitlab_prepare_project_workspace`（返回本地路径） -> `bash` + `rg` 搜索该路径。
- **搜索约束**：跨项目内容定位只用 prepare workspace 后的本地 `rg`；不要使用或幻想 `gitlab_search_project_blobs`。
- **证据要求**：如果依据来自 harness，评论中应简短说明文档路径和 ref/commit；如果 prepare 失败，不要用当前项目旧 `doc/` 代替权威文档下结论。

建议 prompt 示例：

```markdown
## 跨项目上下文(按需)

- 当前 MR 项目只作为代码事实来源；业务/需求事实优先查配置的 harness 仓库。
- 当前 MR 项目的 `doc/`、`*.md`、`*.csv` 默认不是权威依据，只能作为线索。
- 需要业务依据时，先确认 harness 项目和分支，再调用 `gitlab_prepare_project_workspace`，随后用 `rg` 搜返回目录。
- 不使用 `gitlab_search_project_blobs`；跨项目搜索统一走本地 `rg`。
- 发表基于 harness 的评论时，说明依据文件路径和 ref/commit。
```

## Rollout / Rollback

- 先以配置开关启用跨项目工具。
- 如果跨项目 prepare 失败，reviewer 应降级为仅审当前 MR 代码，并在最终结论中说明未能读取权威文档。
- 回滚时关闭工具配置，不影响当前 MR 项目已有 review 能力。
