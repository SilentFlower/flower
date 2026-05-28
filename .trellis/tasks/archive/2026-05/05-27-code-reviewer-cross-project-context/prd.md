# 讨论 code-reviewer 跨项目上下文工具

## Goal

为 `flower-code-reviewer` 设计受控的跨项目上下文能力，让 MR reviewer 在需要业务/需求依据时可以按需读取同组权威仓库（例如 `digital-biz-projects/iqs/iqs-harness`），同时继续用本地 `rg` 做可靠搜索，避免把当前项目内可能过期的 `doc/` 当成权威来源。

## Background / Known Context

- 当前 code-review job 会在 GitLab Runner 中 checkout 当前 MR 项目，然后 agent 可通过 `bash` 调用 `rg` 搜索本地工作目录。
- 已观察到 job `11286` 中的 `rg "AI 推荐|AI推荐" -n --glob '!*.xlsx'` 命中了 `xhgj-iqs-boot/doc/` 和 CSV 文档；这些文档可能不是维护源，会误导 review。
- `digital-biz-projects/iqs` group 当前可见项目包括 `iqs-harness`、`xhgj-iqs-boot`、`xhgj-iqs-ui`。
- `iqs-harness` 当前存在 `master`、`v1.4`、`dev-cct`、`dev-mcw` 等分支，部分任务可能需要读取单独分支上的文档。
- 用户倾向于给 agent 工具按需准备跨项目本地工作区，而不是容器启动时固定 clone，也不倾向使用 GitLab blob search 作为主要搜索方式。
- 已确认 MVP 不实现 `gitlab_search_project_blobs`；跨项目搜索统一通过 prepare workspace 后的本地 `rg` 完成。

## Requirements

- 新增或设计 agent 工具，使 reviewer 可以列出同组项目。
- 新增或设计 agent 工具，使 reviewer 可以列出指定项目分支。
- 新增或设计 agent 工具，使 reviewer 可以按需将白名单项目的指定 ref 浅 clone/fetch 到固定本地目录，并返回可用于 `rg` 的路径与实际 commit。
- MVP 工具清单固定为 `gitlab_list_group_projects`、`gitlab_list_project_branches`、`gitlab_prepare_project_workspace`。
- reviewer 规则需要明确：当前 MR 项目用于代码事实；权威业务/需求文档优先来自配置的 harness 仓库；当前项目 `doc/`、`*.md`、`*.csv` 默认不作为权威业务依据。
- reviewer prompt 必须新增跨项目上下文引导，明确何时使用 harness、如何选择 ref、如何在 prepare workspace 后用 `rg` 搜索。
- 工具必须避免 token 出现在日志、模型上下文或命令输出中。
- 工具必须限制可访问项目范围，不能开放任意 Git URL clone。
- 跨项目仓库必须按需准备并可复用缓存，不能让每个 job 无条件 clone 所有相关仓库。

## Acceptance Criteria

- [ ] 形成明确的工具清单、参数、返回结构和错误处理策略。
- [ ] 形成 reviewer 使用流程：发现需要权威文档 -> 确认项目/分支 -> prepare workspace -> 使用 `rg` 搜索。
- [ ] prompt 中包含跨项目上下文段，且测试覆盖该段包含 3 个工具名、明确禁止使用 `gitlab_search_project_blobs`。
- [ ] 形成安全边界：项目白名单、token 隐藏、固定 clone 目录、ref/alias 校验。
- [ ] 形成分支选择策略：显式 ref 优先，其次版本映射，最后默认分支。
- [ ] 若进入实现，新增/更新测试覆盖成功 clone、缓存复用、分支不存在、项目不在白名单、token 不泄露等场景。

## Definition of Done

- Tests added/updated where behavior changes.
- Lint/typecheck/test commands green for touched package.
- reviewer prompt/tool 说明更新，明确跨项目文档优先级。
- 保留从 `main` 派生的独立 worktree 开发方式，避免污染当前脏工作区。

## Out of Scope

- 不实现 GitLab blob search 作为主要搜索方案。
- 不新增 `gitlab_search_project_blobs`。
- 不在 job 启动阶段无条件 clone harness。
- 不开放 agent 任意 clone 同组所有项目或任意外部 Git URL。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
