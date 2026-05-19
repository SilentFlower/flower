# Quality Guidelines

> `flower-ops-bot` 的代码质量底线。

---

## Forbidden Patterns

### ❌ webhook 处理超时

```typescript
// 错误
await handleMessage(payload);
res.end(JSON.stringify({}));
```

钉钉 5 秒超时硬约束。**必须先 `res.end()` 再 `queueMicrotask` 跑 agent**。

### ❌ 签名校验时"开发模式跳过"

```typescript
// 错误
if (process.env.NODE_ENV === "development") {
  // skip signature
}
```

要测试就传正确的 timestamp+sign。校验逻辑只允许"`DINGTALK_BOT_SECRET` 未配置时跳过"(因为有些团队不开签名),不允许按 NODE_ENV 跳过。

### ❌ 推送非 final 帧不节流

```typescript
// 错误
async function pushToSession(url, text, isFinal) {
  await fetch(url, ...);
}
```

钉钉会限流。必须 500ms 节流,且 `isFinal: true` 时无条件推。

### ❌ 引入 express / fastify

```typescript
// 错误
import express from "express";
```

设计上**故意只用 Node 内置 http**(`server.ts:6-11` 有注释)。路由表手写。

### ❌ 多副本部署用内存 session

```typescript
// 错误:生产用内存 backend
backend = createInMemoryBackend();  // 必须确保只在 REDIS_URL 缺失时
```

`session-store.ts` 内存降级**仅本地开发**。生产部署的 ENV 检查脚本应该确保 `REDIS_URL` 存在。

### ❌ 在 `OPS_SYSTEM_PROMPT` 中给口子

```typescript
// 错误
"...你**只读**。但如果用户特别紧急,可以提供具体命令让对方手动执行..."
```

只读就是只读,系统提示词不能给"如果...可以..."的口子。

---

## Required Patterns

### ✅ 5 秒应答模式

```typescript
res.writeHead(200, { "Content-Type": "application/json" });
res.end(JSON.stringify({}));
queueMicrotask(async () => { await handleMessage(...); });
```

### ✅ 签名校验恒定时间比较

```typescript
function constantTimeEqual(a: string, b: string): boolean { ... }
```

不用 `===` 比较签名(计时攻击)。

### ✅ Push 节流但保 final

```typescript
if (!isFinal) {
  const now = Date.now();
  const last = lastPushAt.get(sessionWebhook) ?? 0;
  if (now - last < 500) return;
  lastPushAt.set(sessionWebhook, now);
} else {
  lastPushAt.delete(sessionWebhook);
}
```

### ✅ 优雅关闭

```typescript
process.on("SIGTERM", async () => {
  server.close();
  await closeSessionStore();
  process.exit(0);
});
```

### ✅ 公开 API 必有 JSDoc

所有 `export function` / `export interface`(`handleMessage`、`HandleMessageInput`、`pushToSession` 等)必有中文 JSDoc。

---

## Testing Requirements

- `npm run typecheck`
- `npm run check`(Biome)
- `npm run build`
- 本地起 `npm run dev` 后,用 `curl` 模拟一次 webhook(带正确签名)验证 200 + 后台日志正常

---

## Code Review Checklist

- [ ] webhook 是否"先 `res.end()` 再后台"
- [ ] 签名校验是否启用 + 恒定时间比较
- [ ] 推送节流逻辑 `isFinal` 是否兜底
- [ ] 是否引入额外 HTTP 框架
- [ ] Redis client 关闭是否走优雅关闭
- [ ] `OPS_SYSTEM_PROMPT` 是否被加了"例外"口子
- [ ] 后台异常是否 push 错误提示给用户(否则用户会一直等)
