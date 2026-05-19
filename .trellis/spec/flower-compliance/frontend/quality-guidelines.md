# Quality Guidelines

> `flower-compliance` 的代码质量底线。

---

## Forbidden Patterns

### ❌ 在拦截 handler 中 `throw`

```typescript
// 错误
pi.on("tool_call", async (event) => {
  if (event.toolName === "write") throw new Error("禁止 write");
});
```

抛 Error 会污染 pi 调用栈,LLM 看不到 reason。**必须 `return { block: true, reason: "..." }`**。

### ❌ 在审计 handler 中 `await`

```typescript
// 错误:阻塞主流程
pi.on("tool_call", async (event) => {
  await sendAudit({ ... });
});
```

**必须 `void sendAudit(...)`**(fire-and-forget)。

### ❌ 把敏感数据写入审计

```typescript
// 错误
void sendAudit({ kind: "tool_call", input: event.input, ... });
```

可能含密钥 / PII。**只上报 `inputKeys: Object.keys(event.input ?? {})`**。

### ❌ 改变 bash 白名单时不同步 reason

修改白名单时,必须更新 `index.md` 的"白名单清单"小节(可选)+ 让 reason 携带可读说明。

---

## Required Patterns

### ✅ 审计请求必须有超时

```typescript
signal: AbortSignal.timeout(2000)
```

### ✅ 失败仅 warn

```typescript
} catch (err) {
  console.warn("[audit] 上报失败:", err);
}
```

绝不向上抛错。

### ✅ 公开 API 必有 JSDoc

`registerCompliance` / `sendAudit` / `AuditRecord` / `ComplianceMode` 都必须有中文 JSDoc。

### ✅ Module-level 常量 immutable

用 `const`,正则用 `/.../`(不要 `new RegExp(...)`,可读性差且每次都构造新对象)。

---

## Testing Requirements

- `npm run typecheck` 通过
- `npm run check`(Biome)无 error
- `npm run build` 通过

新增拦截规则时,鼓励手工跑一次 `code-reviewer --dry-run` 确认 pi 行为符合预期(目前无单元测试)。

---

## Code Review Checklist

- [ ] 是否 `await sendAudit`(必须改 `void`)
- [ ] 上报字段是否包含敏感 `input` 全量
- [ ] 新增拦截规则是否在 `ci-readonly` 模式下、`return { block: true, reason }`
- [ ] `AuditRecord` 新增 `kind` 时,是否在 SIEM 文档同步更新
- [ ] 是否漏掉 `[audit]` / `[compliance]` 日志前缀
