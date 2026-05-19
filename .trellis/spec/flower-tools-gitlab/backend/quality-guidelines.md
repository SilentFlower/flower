# Quality Guidelines

> 见 `frontend/quality-guidelines.md`。本节列后端强约束。

---

## Backend 专项强约束

### ✅ 不引 `@gitbeaker/rest`

故意只用 `fetch` + 5-6 个 endpoint:

- 控制 bundle 大小
- 错误信息可控
- 不被 SDK 版本绑定

### ✅ `PRIVATE-TOKEN` header 鉴权

```typescript
headers: {
  "PRIVATE-TOKEN": token,
  "Content-Type": "application/json",
}
```

GitLab 推荐的鉴权方式。**不**在 URL 中传 token。

### ✅ `encodeURIComponent` projectId

```typescript
const url = `${host}/api/v4/projects/${encodeURIComponent(projectId)}/...`;
```

GitLab 支持 `projectId` 是 group/project 字符串(含 `/`),必须 encode。

### ✅ 超时 10 秒

```typescript
signal: AbortSignal.timeout(10_000)
```

### ✅ 行内评论 position 完整

```typescript
body: JSON.stringify({
  body: input.body,
  position: {
    base_sha: ...,
    start_sha: ...,
    head_sha: ...,
    new_path: input.file,
    new_line: input.line,
    position_type: "text",
  },
}),
```

`base_sha` / `start_sha` / `head_sha` 必须来自 MR refs(GitLab API)。
真实接入时需要先调一次 MR detail 拿这三个 sha。

### ✅ Stub 实现仅本地

```typescript
function createStubClient(host: string, _token: string): GitlabClient {
  return {
    async getMrDiff(...) {
      return `[Stub] diff for ${host} project=...`;
    },
    ...
  };
}
```

生产部署前必须有非-stub 实现可用。

---

## Forbidden Patterns

- ❌ 引 `@gitbeaker/rest` 或类似 SDK(违反"轻量自包")
- ❌ token 写在 URL(`?private_token=...`)
- ❌ 客户端方法不带 `signal` / 不带超时
- ❌ `projectId` 不 encode(组项目 `group/project` 会被截断)
- ❌ 行内评论缺 position 字段(GitLab 会返回 400)
- ❌ stub 日志留到生产(`[Stub]` 不应该出现在生产日志)

---

## Testing Requirements

同 `frontend/quality-guidelines.md`。

真实接入时手工验证清单:

- [ ] 创建一个测试 MR,本地跑 `flower-review --dry-run --mr-iid <N>`
- [ ] 评论真的发到了 MR
- [ ] 行内评论真的绑定到对的文件 + 行号
- [ ] 多次评审能识别历史(`gitlab_get_previous_review`)
- [ ] 错误响应(故意传错 mrIid)能给出 user-friendly content

---

## Code Review Checklist

- [ ] 是否引了 GitLab SDK
- [ ] token 是否在 header(不在 URL)
- [ ] projectId 是否 encode
- [ ] 行内评论 position 是否完整
- [ ] 错误响应是否包含 HTTP code + 响应片段
- [ ] Stub 实现是否影响生产路径
- [ ] 是否 console.log 了 token / diff / body
