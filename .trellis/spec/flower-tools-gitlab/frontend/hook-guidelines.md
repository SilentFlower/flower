# Hook Guidelines

> `registerGitlabTools(pi)` + 客户端单例。

---

## Overview

```typescript
export function registerGitlabTools(pi: { registerTool: (def: any) => void }): void {
  pi.registerTool(gitlabGetMrDiffTool);
  pi.registerTool(gitlabGetMrFilesTool);
  pi.registerTool(gitlabPostCommentTool);
  pi.registerTool(gitlabPostLineCommentTool);
  pi.registerTool(gitlabGetPreviousReviewTool);
}
```

集中入口,与 `flower-tools-arms` / `flower-tools-common` 风格统一。

---

## Custom Hook Patterns

### 客户端单例(`gitlabClient()`)

```typescript
let cachedClient: GitlabClient | undefined;

export function gitlabClient(): GitlabClient {
  if (cachedClient) return cachedClient;
  const host = process.env.GITLAB_HOST ?? "https://gitlab.com";
  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    throw new Error("GITLAB_TOKEN 环境变量未设置");
  }
  cachedClient = createStubClient(host, token);
  return cachedClient;
}
```

约定:

1. **`host` 有默认值**(`https://gitlab.com`),自部署 GitLab 才需要设
2. **`token` 必须设置**,首次调用时 fail-fast
3. **module-level `let cachedClient`**:网络客户端单例(合理使用 mutable state)
4. **不在 `import` 时初始化**:让加载本包不出错,真实调用工具才会校验凭证

### `readEnv()` helper

```typescript
function readEnv(): { projectId: string; mrIid: number } {
  const projectId = process.env.CI_PROJECT_ID;
  const mrIidRaw = process.env.CI_MERGE_REQUEST_IID;
  if (!projectId || !mrIidRaw) {
    throw new Error("CI_PROJECT_ID / CI_MERGE_REQUEST_IID 未设置,gitlab 工具只能在 CI 环境运行");
  }
  const mrIid = Number.parseInt(mrIidRaw, 10);
  if (Number.isNaN(mrIid)) {
    throw new Error(`CI_MERGE_REQUEST_IID 不是合法整数: ${mrIidRaw}`);
  }
  return { projectId, mrIid };
}
```

约定:

1. **每个工具 `execute` 都调一次** `readEnv()`(消耗很小,代码可读)
2. **统一从这里读 CI 变量**,不要散落在工具实现里
3. **错误信息明确**:不只说"env 未设置",还说"gitlab 工具只能在 CI 环境运行"

---

## Data Fetching

通过 `gitlabClient()` 的 5 个方法:

- `getMrDiff(projectId, mrIid)` → `Promise<string>`
- `getMrFiles(projectId, mrIid)` → `Promise<string[]>`
- `postMrComment(projectId, mrIid, body, severity)` → `Promise<void>`
- `postMrLineComment(projectId, mrIid, input)` → `Promise<void>`
- `getBotComments(projectId, mrIid)` → `Promise<BotComment[]>`

真实接入时:

- 用 `fetch`(node 22 自带),**不引** SDK
- Token 通过 `Authorization: Bearer <token>` 或 `PRIVATE-TOKEN: <token>`(看 GitLab 版本)
- 超时 10 秒
- 错误响应转 throw(让工具 execute 决定要不要转 content)

---

## Naming Conventions

- 工具变量:`gitlab<Verb><Noun>Tool`
- 工具 `name`:`gitlab_<verb>_<noun>`
- 注册函数:`registerGitlabTools`
- 客户端方法:动词在前(`getMrDiff`、`postMrComment`),与 REST 语义对应
- 环境变量:CI 注入沿用 GitLab 官方,自定义用 `GITLAB_` 前缀

---

## Common Mistakes

- ❌ 在 `execute` 内 `new GitlabClient(...)`(每次重建)
- ❌ 在 `registerGitlabTools` 内调用 `gitlabClient()`(让注册阶段就需要 token;应该惰性,工具执行时才需要)
- ❌ `readEnv()` 在工具定义 module-level 调用(`import` 本包就崩)
- ❌ 不同工具读不同的 env 变量(`mr_iid` / `MR_IID` / `gitlab_mr` 混用;统一用 GitLab CI 官方 `CI_MERGE_REQUEST_IID`)
- ❌ 客户端方法 throw 不带具体 endpoint 信息(失败时排错困难)
