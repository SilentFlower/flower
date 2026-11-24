# Directory Structure

> `@flower-ai/flower-tools-gitlab` 的目录布局。

---

## Directory Layout

```
packages/flower-tools-gitlab/
├── src/
│   ├── index.ts     # 工具定义、registerGitlabTools 和公开导出
│   ├── client.ts    # GitLab REST 客户端
│   └── sanitize.ts  # 包内评论快捷指令转义
├── dist/
├── package.json
└── tsconfig.json
```

---

## Module Organization

### `src/index.ts`

| 元素 | 说明 |
|------|------|
| `severitySchema` | module-level const,三档 Literal 联合 |
| `gitlabGetMrDiffTool` | 拿 MR diff |
| `gitlabGetMrFilesTool` | 列文件 |
| `gitlabPostCommentTool` | 整体评论 |
| `gitlabPostLineCommentTool` | 行内评论 |
| `gitlabGetPreviousReviewTool` | 查历史 |
| `registerGitlabTools(pi)` | 集中注册 |
| `readEnv()` | 内部 helper,读 `CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID` |

### `src/client.ts`

| 元素 | 说明 |
|------|------|
| `LineCommentInput` / `BotComment` | 公开接口类型 |
| `GitlabClient` | 客户端接口 |
| `gitlabClient()` | 惰性单例 getter |
| `createRealClient(host, token)` | REST 实现 |

---

### `src/sanitize.ts`

`gitlabPostCommentTool` 和 `gitlabPostLineCommentTool` 发送前通过本地模块调用 `sanitizeQuickActions`。包根保持工具调用入口。

---

## Naming Conventions

- 工具变量:`gitlab<Verb><Noun>Tool`(`gitlabGetMrDiffTool`、`gitlabPostLineCommentTool`)
- 工具 `name`:`gitlab_<verb>_<noun>` snake(`gitlab_get_mr_diff`、`gitlab_post_line_comment`)
- 注册函数:`registerGitlabTools`
- 客户端接口:`GitlabClient`(PascalCase)
- 客户端实例 getter:`gitlabClient()`
- 类型:`LineCommentInput` / `BotComment`(PascalCase)
- 环境变量:沿用 GitLab CI 官方(`CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID` / `CI_JOB_URL` 等);自定义的用 `GITLAB_TOKEN` / `GITLAB_HOST`

---

## Examples

- 工具命名约定:`src/index.ts:1-9`(get_xxx 只读 / post_xxx 写)
- severity 联合:`src/index.ts:20-24`
- 集中注册:`src/index.ts:154-160`
- 客户端接口:`src/client.ts:31-42`
