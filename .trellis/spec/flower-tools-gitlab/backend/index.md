# Backend Development Guidelines

> `@flower-ai/flower-tools-gitlab` 的内部实现层(REST 客户端、stub 实现、未来真实接入)规范。

---

## Overview

本目录(`backend/`)关心 **`src/client.ts` 的实现**:

- 已接入真实 GitLab REST API(5 个 endpoint:getMrDiff / getMrFiles / postMrComment / postMrLineComment / getBotComments)
- stub 阶段的 `[Stub]` console.log 已全部清除

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
3. **token 鉴权**:`PRIVATE-TOKEN` header(GitLab 推荐,client.ts 用此)
4. **`projectId` 必须 `encodeURIComponent`**:GitLab project path 含 `/`(如 `digital-independent-projects/srm-esign`),URL 拼接时必须 encode 成 `digital-independent-projects%2Fsrm-esign`,否则 404
5. **行内评论 position**:必须传 `position_type: "text"` + `base_sha` / `start_sha` / `head_sha` / `new_path` / `new_line`。三个 sha 从同一个 `/changes` 接口的 `diff_refs` 拿,**client 内部缓存 per-MR**(`Map<"<projectId>:<mrIid>", DiffRefs>`)避免每次发评论都重拉 changes
6. **severity 前缀写进 body**:`postMrComment` / `postMrLineComment` 把 `[severity:<level>] ` 前缀写进真实评论 body —— GitLab API 本身没有 severity 字段;`run.ts` 的 blocker 扫描凭 `/^\[severity:blocker\]/` regex 识别。改前缀格式只需要改一处,但**必须**与 `flower-code-reviewer/src/run.ts:scanForBlockers` 同步
7. **错误处理**:
   - HTTP 200/201 OK
   - 4xx(401/403/404/429)直接抛 Error,信息含 endpoint path + HTTP code + 响应体前 200 字符(截断防 token / 内部信息泄漏)
   - 5xx + 网络错误重试 1 次(sleep 2s),仍失败抛
   - **429 不重试**(限流意味配额耗尽,继续重试火上浇油)
8. **超时 10 秒**:`AbortSignal.timeout(10_000)`
9. **失败 fail-loud**:GitLab API 错时 throw,让上层(工具 execute / pi 框架)知道
