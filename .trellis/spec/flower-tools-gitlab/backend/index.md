# Backend Development Guidelines

> `@flower-ai/flower-tools-gitlab` 的内部实现层(REST 客户端、stub 实现、未来真实接入)规范。

---

## Overview

本目录(`backend/`)关心 **`src/client.ts` 的实现**:

- 已接入真实 GitLab REST API(**6 个 endpoint**:getMrDiff / getMrFiles / postMrComment / postMrLineComment / getBotComments / **getFileContent**)
- stub 阶段的 `[Stub]` console.log 已全部清除
- `safe-read.ts` 工具层 wrapper(单文件 50KB cap + 18 类二进制后缀跳过)封装 `gitlab_get_file_content` execute,LLM 永远拿不到超大或二进制原始内容

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 当前布局与未来拆分 |
| [Database Guidelines](./database-guidelines.md) | 不适用(GitLab 是远端) |
| [Error Handling](./error-handling.md) | API 错误 / token 错误 / 增量评审重试策略 |
| [Logging Guidelines](./logging-guidelines.md) | 不打 token / diff 内容 / 评论 body |
| [Quality Guidelines](./quality-guidelines.md) | 与 frontend/ 共用 + backend 强约束 |

---

## 关键设计点

1. **轻量 HTTP 客户端**:`fetch` + 5-6 个 endpoint,**不引** `@gitbeaker/rest`
2. **endpoint 设计**:
   - `GET /api/v4/projects/{projectId}/merge_requests/{mrIid}/changes` → diff + files + diff_refs
   - `POST /api/v4/projects/{projectId}/merge_requests/{mrIid}/notes` → 整体评论
   - `POST /api/v4/projects/{projectId}/merge_requests/{mrIid}/discussions` → 行内评论(需要 position 参数)
   - `GET notes` 后过滤 `author.username === bot user` → bot 历史评论
   - `GET /api/v4/user` → bot 自身 username(由 client 内部自查 + 缓存,避免硬编码 env)
   - **`GET /api/v4/projects/{projectId}/repository/files/{encodedPath}/raw?ref={encodedRef}`** → 任意 ref 的文件原始内容(N1 LLM 拉真实代码上下文用;`path` / `ref` 必须 URL-encode;200 OK 返回文本 body 非 JSON;**工具层 `safe-read.ts` wrapper 兜底**:文件 size > `FLOWER_MAX_FILE_SIZE`(默认 50KB)截断 + 标注;按后缀跳过 `.png/.jpg/.jpeg/.gif/.pdf/.zip/.tar/.gz/.7z/.ico/.woff/.woff2/.ttf/.otf/.so/.dll/.exe/.bin/.lock` 18 类二进制)
3. **token 鉴权**:`PRIVATE-TOKEN` header(GitLab 推荐,client.ts 用此)
4. **`projectId` 必须 `encodeURIComponent`**:GitLab project path 含 `/`(如 `digital-independent-projects/srm-esign`),URL 拼接时必须 encode 成 `digital-independent-projects%2Fsrm-esign`,否则 404
5. **行内评论 position**:必须传 `position_type: "text"` + `base_sha` / `start_sha` / `head_sha` / `new_path` / `new_line`。三个 sha 从同一个 `/changes` 接口的 `diff_refs` 拿,**client 内部缓存 per-MR**(`Map<"<projectId>:<mrIid>", DiffRefs>`)避免每次发评论都重拉 changes
6. **severity 词表 + 评论 body marker 注入策略**(2026-05-20 二次迭代):
   - **词表统一**:`severitySchema = z.enum(["blocker", "major", "minor"])`(原 `info | warning | blocker` 已弃用);对齐 `flower-code-reviewer/src/comments/render.ts` 与 `prompts.ts` few-shot 模板
   - **仅 blocker 注入 HTML 注释 marker**(2026-05-20 升级,替代旧字面 `[severity:blocker]` 前缀):
     - blocker:`postMrComment` / `postMrLineComment` execute 在 body 首行 prepend `<!-- severity: blocker -->\n`(GitLab markdown 渲染时 HTML 注释不显示,用户视图完全干净)
     - major / minor:**body 原样**,无任何 marker(由模板内 emoji + 加粗中文等级 表达严重程度,例如 `🟠 **重要** · ...`)
   - `run.ts:scanForBlockers` 双 marker 兼容:正则同时匹配 `<!--\s*severity:\s*blocker\s*-->`(新)和 `^\[severity:blocker\]`(旧,向后兼容历史评论)
   - 改 marker 格式必须同步改 `flower-code-reviewer/src/run.ts:scanForBlockers` 正则
7. **行内评论 quick-action 防御**:`postMrComment` / `postMrLineComment` execute 内对 `body` 参数做 `sanitizeQuickActions`(import 自 `@flower-ai/flower-tools-common`)→ 首字符 `/` 改成 `&#47;`,防止 LLM 输出 `/approve` `/close` 等被 GitLab 当作 quick action 误执行 MR 状态;**与 prompt 第 4 条硬约束形成双层防御**
8. **错误处理**:
   - HTTP 200/201 OK
   - 4xx(401/403/404/429)直接抛 Error,信息含 endpoint path + HTTP code + 响应体前 200 字符(截断防 token / 内部信息泄漏)
   - 5xx + 网络错误重试 1 次(sleep 2s),仍失败抛
   - **429 不重试**(限流意味配额耗尽,继续重试火上浇油)
   - **N1 `getFileContent` 错误分类**(`gitlabFetch({ classifyError: true })`):401/403 → `AuthError`(整个评审 abort)/ 404 → `FileNotFoundError`(LLM 可选拉别的 ref)/ 5xx → `RetryableError`(重试 1 次仍失败抛);其他 5 endpoint 保持原行为(`classifyError: false`),向后兼容
9. **超时 10 秒**:`AbortSignal.timeout(10_000)`
10. **失败 fail-loud**:GitLab API 错时 throw,让上层(工具 execute / pi 框架)知道
