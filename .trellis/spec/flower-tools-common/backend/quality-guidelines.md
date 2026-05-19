# Quality Guidelines

> 见 `frontend/quality-guidelines.md`。本节列后端强约束。

---

## Backend 专项强约束

### ✅ accessToken 过期前 60s 刷新

```typescript
if (_cachedToken && _cachedToken.expiresAt > now + 60_000) {
  return _cachedToken.token;
}
```

### ✅ 失败清空 token 缓存

```typescript
} catch (err) {
  _cachedToken = undefined;
  throw err;
}
```

### ✅ 必须超时

```typescript
signal: AbortSignal.any([signal ?? AbortSignal.timeout(10_000), AbortSignal.timeout(10_000)])
```

或者更简单:

```typescript
// 如果 caller 已传 signal,组合
const composed = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
await fetch(url, { signal: composed });
```

### ✅ URL `encodeURIComponent`

所有 URL 参数必须经 `encodeURIComponent`。

### ✅ API 错误转 content

不要 throw。

---

## Forbidden Patterns

- ❌ 跨子模块 import(`zentao.ts` import `dingtalk-doc.ts`)
- ❌ `fetch` 无超时
- ❌ token 刷新失败仍缓存
- ❌ 用 `setInterval` 后台刷新 token(简单的"调用时检查"已够)
- ❌ retry 在 backend 层做(让 LLM 决定 retry)

---

## Testing Requirements

同 `frontend/quality-guidelines.md`。

新增系统时:

- [ ] 鉴权流程文档清晰(README / spec 都记一份)
- [ ] 凭证 env 命名一致(`<SYSTEM>_<什么>`)
- [ ] 失败路径返回友好 content

---

## Code Review Checklist

- [ ] token 缓存是否带过期 + 提前刷新
- [ ] 缓存是否在失败时清空
- [ ] fetch 是否带 signal + 超时
- [ ] URL 是否 encodeURIComponent
- [ ] API 错误是否转 content
- [ ] 子模块之间是否独立(无交叉 import)
- [ ] 日志是否打了 token / query / 响应内容
