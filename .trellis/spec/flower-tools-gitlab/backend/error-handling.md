# Error Handling

> GitLab API 错误处理。

---

## Overview

本包错误处理与 `flower-tools-arms` 类似,但语义稍有不同:

| 错误源 | 处理 |
|--------|------|
| 凭证缺失(`GITLAB_TOKEN` 未设) | `gitlabClient()` 首次调用 throw |
| CI 环境缺失(`CI_*` 未设) | `readEnv()` throw |
| GitLab API 4xx / 5xx | client 方法 throw,工具 execute 内部决定转 content 还是抛 |
| 网络抖动 | client 方法 throw |

---

## Error Types

不定义自定义错误类。GitLab API 错误响应通常包含 `error` 字段,可以包进 Error message。

---

## Error Handling Patterns

### 凭证 fail-fast

```typescript
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

### CI env 校验

```typescript
function readEnv(): { projectId: string; mrIid: number } {
  const projectId = process.env.CI_PROJECT_ID;
  const mrIidRaw = process.env.CI_MERGE_REQUEST_IID;
  if (!projectId || !mrIidRaw) {
    throw new Error("CI_PROJECT_ID / CI_MERGE_REQUEST_IID 未设置,gitlab 工具只能在 CI 环境运行");
  }
  ...
}
```

### GitLab REST 错误(真实接入)

```typescript
async function postNote(projectId: string, mrIid: number, body: string): Promise<void> {
  const url = `${host}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`GitLab POST /notes 失败:HTTP ${resp.status} ${errText.slice(0, 200)}`);
  }
}
```

要点:

- **错误信息含 HTTP code + 响应体前 200 字符**(便于排错,避免太长)
- **`encodeURIComponent` projectId**(GitLab 项目名可能含 `/`)
- **超时 10 秒**
- **`PRIVATE-TOKEN` header** 走 GitLab 标准鉴权

### 工具 `execute` 内的处理

```typescript
async execute(_id, params) {
  try {
    const { projectId, mrIid } = readEnv();
    await gitlabClient().postMrComment(projectId, mrIid, params.body, params.severity);
    return { content: [{ type: "text", text: "整体评论已发表" }], details: { severity: params.severity } };
  } catch (err) {
    return {
      content: [
        { type: "text", text: `发表评论失败:${err instanceof Error ? err.message : String(err)}` },
      ],
      details: { error: true, severity: params.severity },
    };
  }
}
```

约定:

- **写工具**:转 content + `details: { error: true }`,让 LLM 感知失败可以重试
- **读工具**(`getMrDiff`):如果失败,转 content 但提示用户"评审无法继续";让上游 pipeline 也感知到(retain non-zero exit code)

---

## API Error Responses

不适用(本包是 caller)。

---

## Common Mistakes

- ❌ `resp.ok` 不检查直接 `await resp.json()`(403/500 也返回 JSON body,不 throw)
- ❌ 错误信息只放 HTTP code,不含响应体(GitLab 错误响应有具体原因,丢了排错难)
- ❌ 错误信息包含整段响应(可能含 token / 内部信息;`.slice(0, 200)` 截断)
- ❌ 客户端方法 catch 后 swallow + 返回 stub 数据(失败被掩盖)
- ❌ 在 `gitlabClient()` 内 `try / catch` 凭证检查(凭证缺失必须 throw,无 fallback)
