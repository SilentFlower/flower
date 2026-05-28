# design.md

## Technical Design

### 1. 跨项目 workspace 鉴权

受影响文件：`packages/flower-tools-gitlab/src/workspace.ts`。

当前实现通过 `http.extraHeader=PRIVATE-TOKEN: <token>` 传给 `git fetch`。GitLab REST API 支持 `PRIVATE-TOKEN`，但 Git smart HTTP 对仓库 clone/fetch 更稳定的方式是 Basic Auth。实现上改为给 git 进程注入：

```text
http.extraHeader=Authorization: Basic <base64("oauth2:<token>")>
```

远程 URL 继续保持不含 token 的 `http(s)://host/group/project.git`。异常脱敏继续保留，并补充 Basic header 脱敏，避免 token 或编码后的 header 出现在错误消息。

### 2. CI 只读模式放行 Python 文档解析

受影响包：`packages/flower-compliance`。

本任务原先考虑新增受限 `.xlsx` inspect 工具；最终根据用户决策改为放行 `bash python3`，让 reviewer 可直接使用镜像内置 Python 库读取 Excel / Word 模板：

- Excel：`openpyxl` / `pandas` 等已有库。
- Word：`python-docx` 等已有库。
- XML/压缩包：Python 标准库 `zipfile` / `xml.etree.ElementTree`。

安全边界调整：

- `python3` 加入 CI bash 白名单。
- `write` / `edit` 仍禁用。
- `curl` / `wget` / `npm` / `pip` / `apt` / `tee` / `mv` / `rm` 等网络、包管理和写文件类命令仍禁用。
- `tool_call` / `tool_result` 审计继续覆盖 Python 调用。

### 3. 行内评论合法行处理

受影响文件：`packages/flower-tools-gitlab/src/client.ts`、`packages/flower-tools-gitlab/src/index.ts`。

GitLab 行内评论要求 position 对应 MR diff 中合法 `new_line`。当前工具直接 POST `/discussions`，非法行会返回 HTTP 400。

设计选项：

- 首选：工具执行前读取 `/changes` diff，解析目标文件可评论的 `new_line` 集合；若目标行不合法，自动调用整体评论工具内容，说明原目标 `file:line` 不可行内评论。
- 备选：不自动发整体评论，只返回结构化错误让 LLM 重试。

本任务采用首选，原因是用户目标是减少 `tool ✗ error` 并稳定落评审结论；自动降级能避免模型反复试错，同时不丢评论内容。

实现细节：

- 在 client 层增加只读 helper 判断 `file + line` 是否出现在 MR diff 的新增/上下文 `new_line` 中。
- `postMrLineComment` 若不可评论，不发 `/discussions`，改发 `/notes` 整体评论，body 前追加“原计划评论位置不可行内评论: `file:line`”。
- 返回值区分 `posted: "line" | "note_fallback"`，tool 文案显示降级。
- 仍保留真实 GitLab 4xx 抛错能力，用于权限、MR 不存在等非行号问题。

## Compatibility

- 已有 `gitlab_post_comment` 和 `gitlab_post_line_comment` schema 尽量不变，减少 prompt 改动。
- `python3` 白名单是合规边界调整，不改变 GitLab 工具 schema。
- 跨项目 workspace remote URL 不变，已存在本地 workspace 可复用。

## Rollout / Rollback

- Rollout：合并后 CI reviewer 自动使用新工具和新鉴权路径。
- Rollback：如 Basic Auth 对某 GitLab 实例不兼容，可回退 `workspace.ts` 的 header 构造；如 `python3` 放行风险不可接受，可从 bash 白名单移除；行内评论降级可通过代码回退到原抛错行为。
