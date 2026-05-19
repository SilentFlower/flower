# Directory Structure

> `@flower-ai/flower-tools-gitlab` 的目录布局。

---

## Directory Layout

```
packages/flower-tools-gitlab/
├── src/
│   ├── index.ts     # 5 个工具定义 + registerGitlabTools + 类型 / 工具 export
│   └── client.ts    # GitLab REST 轻量客户端 + 当前 stub 实现
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
| `GitlabClient` | 客户端接口(5 个方法) |
| `gitlabClient()` | 惰性单例 getter |
| `createStubClient(host, token)` | 当前 stub 实现(TODO 真实接入) |

---

## 未来拆分

真实接入 GitLab REST API 后,client.ts 可能拆为:

```
src/
├── index.ts
├── client.ts          # GitlabClient 接口 + 单例 getter
└── client-real.ts     # 真实 HTTP 实现
```

或者直接在 `client.ts` 内把 `createStubClient` 替换为 `createRealClient`。当前先放一个文件。

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
