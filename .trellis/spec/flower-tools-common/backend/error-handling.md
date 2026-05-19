# Error Handling

> API 错误 / 凭证错误处理。

---

## Overview

同 `flower-tools-arms/backend/error-handling.md`:

1. **API 错误** → 转 user-friendly content 返回(不 throw)
2. **凭证缺失** → 首次 `execute` 时 throw(fail-fast)

本节列本包特有点:**钉钉 accessToken 刷新失败**。

---

## Error Types

不定义自定义错误类。

---

## Error Handling Patterns

### accessToken 刷新失败

```typescript
async function getDingTalkAccessToken(): Promise<string> {
  // ... check cache
  try {
    const resp = await fetch("...", { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      throw new Error(`钉钉换 token 失败:HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (typeof data.accessToken !== "string") {
      throw new Error("钉钉换 token 响应格式异常");
    }
    _cachedToken = { token: data.accessToken, expiresAt: Date.now() + data.expireIn * 1000 };
    return data.accessToken;
  } catch (err) {
    _cachedToken = undefined;  // 不缓存失败结果
    throw err;
  }
}
```

约定:

- 失败时**清空 `_cachedToken`**,让下次重新尝试
- 错误信息明确(HTTP code / 响应格式)
- **必须超时**(5 秒)

调用方 `execute`:

```typescript
try {
  const token = await getDingTalkAccessToken();
  // ... 用 token 调 API
} catch (err) {
  return {
    content: [
      { type: "text", text: `钉钉文档搜索不可用:${err instanceof Error ? err.message : String(err)}` },
    ],
    details: { error: true },
  };
}
```

### 禅道 API 错误

```typescript
try {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!resp.ok) {
    throw new Error(`禅道返回 HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return {
    content: [{ type: "text", text: formatResults(data) }],
    details: { count: data.length },
  };
} catch (err) {
  return {
    content: [{ type: "text", text: `禅道搜索失败:${err instanceof Error ? err.message : String(err)}` }],
    details: { error: true },
  };
}
```

---

## API Error Responses

不适用(本包是工具 caller,不是 HTTP server)。

---

## Common Mistakes

- ❌ token 刷新失败仍缓存空字符串(下次拿到空 token 调 API,远端报权限错,排错困难)
- ❌ `fetch` 失败时把 `_cachedToken` 留着旧值(过期 token 再用会失败,但不会重新换;清空更安全)
- ❌ 在 `execute` 内 retry token 换取(逻辑放 `getDingTalkAccessToken` 内部更内聚,但本仓库当前选择"失败就报",由 LLM 决定再调)
- ❌ API 错误 throw 让 pi 框架接(LLM 看到模糊"工具调用失败",应该转 content 告诉具体原因)
