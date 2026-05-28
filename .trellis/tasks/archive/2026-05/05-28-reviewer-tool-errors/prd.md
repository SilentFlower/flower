# flower-code-reviewer:处理 CI tool error 三类问题

## Goal

减少 flower-code-reviewer 在 GitLab CI 日志中的可恢复 `tool ✗ error` 噪音，并让三类已确认问题具备稳定处理路径：跨项目工作区 clone 鉴权失败、只读 CI 中需要用 Python 读取 Excel / Word 模板、行内评论落到不可评论行导致 GitLab 400。

## Background / Known Context

- 真实 job：`http://gitlab.xhgjdev.com/digital-biz-projects/iqs/xhgj-iqs-boot/-/jobs/11851`。
- job 最终结果是 `Job succeeded`，问题是中途出现 3 条 `tool ✗ error`。
- `gitlab_prepare_project_workspace` 调 `git fetch` 失败：`fatal: could not read Username for 'http://gitlab.xhgjdev.com': No such device or address`。
- `bash` 调 `python3` 失败：`CI 只读模式:bash 命令 "python3" 不在白名单内`。
- `gitlab_post_line_comment` 评论 `scripts/build_v140_task_export_template.py:91` 失败：GitLab 返回 `400 Bad request - Note {:line_code=>["不能为空字符", "must be a valid line code"]}`；后续改评同文件 `line=72` 成功。
- 源码中 `tool ✗ error` 由 `packages/flower-code-reviewer/src/observability.ts` 打印，表示某个工具返回错误，不等同于 job 失败。

## Requirements

- R1：`gitlab_prepare_project_workspace` 在使用 `GITLAB_TOKEN` 访问同一 GitLab 实例的 HTTP 仓库时，应能完成只读 shallow fetch，不应因 Git 无法交互输入用户名而失败。
- R2：跨项目 workspace 鉴权不得把 token 写入 remote URL、日志、返回结果或异常信息。
- R3：reviewer 在 CI 只读模式下允许调用镜像内置 `python3`，用于通过 `openpyxl` / `python-docx` 等库读取 Excel / Word 模板结构信息。
- R4：放行 `python3` 后仍保留现有写操作和网络外发边界：`write` / `edit` 禁止，`curl` / `wget` / 包管理 / 写文件类 bash 命令仍禁止；`python3` 调用由现有 tool 审计覆盖。
- R5：`gitlab_post_line_comment` 在目标行不是 GitLab MR diff 的合法可评论 `new_line` 时，不应产生 GitLab 400 tool error；应给 LLM 一个可恢复结果，或自动降级为整体评论。
- R6：保留主要安全边界：CI 只读模式仍禁止 `write` / `edit`，不放开 `node` / `curl` 等其它通用执行或网络外发命令。
- R7：新增或调整行为需要覆盖单元测试，避免认证、只读边界和行号合法性回归。

## Acceptance Criteria

- [ ] 使用 token 调 `gitlab_prepare_project_workspace` 时，`git fetch` 通过非交互鉴权完成；单测断言 Git 进程环境不泄漏明文 token 到命令参数或 remote URL。
- [ ] CI 只读合规允许 `bash python3`，reviewer 可借助镜像内置 Python 库读取 Excel / Word 模板结构。
- [ ] CI 只读合规仍拦截 `write` / `edit`、网络外发、包管理和常见写文件命令，相关测试覆盖不变或新增断言。
- [ ] 行内评论工具遇到不可评论行时不抛 GitLab 400；行为可预测，并在返回内容中说明已降级或无法发到行内。
- [ ] 可评论行仍按原路径成功发表行内评论。
- [ ] 运行目标包相关测试通过。

## Definition of Done

- Tests added/updated.
- Lint / typecheck / relevant tests pass.
- 代码注释、JSDoc 使用中文。
- 如行为影响 reviewer 能力或 CI 配置，更新对应 README / docs。

## Out of Scope

- 不处理 LLM 评审质量本身，例如是否应该指出 MR 中的具体业务问题。
- 不放开 `node` / `curl` 等其它通用执行、网络外发或包管理命令。
- 不改 GitLab runner、外部项目权限或 token 发放策略。
- 不重构整个 reviewer tool 调度框架。
