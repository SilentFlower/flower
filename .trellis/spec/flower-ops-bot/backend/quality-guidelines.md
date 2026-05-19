# Quality Guidelines

> 后端额外约束。基本约束见 `frontend/quality-guidelines.md`。

---

## Backend 专项强约束

### ✅ Redis 必带 TTL

```typescript
redis.set(key, value, "EX", TTL_SECONDS);
```

session key 不带 TTL = Redis 越涨越大,且僵尸数据永久存在。

### ✅ Redis client 必须监听 `error` 事件

```typescript
redis.on("error", (err) => console.error("[redis]", err));
```

ioredis 内部 error 未被监听会让进程崩(uncaughtException)。

### ✅ Agent 订阅必须 `unsubscribe`

```typescript
const unsubscribe = agent.subscribe(...);
try {
  await agent.prompt(...);
} finally {
  unsubscribe();  // 必须
}
```

漏 unsubscribe = 内存泄漏(每个请求泄漏一个 listener,长跑会爆)。

### ✅ Agent factory 不缓存(当前)

```typescript
// 当前实现:每个请求新建 Agent
export async function getOrCreateAgent(input): Promise<AgentInstance> { ... }
```

不缓存 = 简单可预测,代价是每条消息多一次 Redis 读。
**如果改成 LRU 缓存**,必须在 PRD 中明确多副本一致性策略(同一 conversationId 可能落到不同副本,缓存会失效)。

### ✅ 启动期凭证 fail-fast

```typescript
if (!baseUrl) throw new Error("LLM_BASE_URL 环境变量未配置");
```

缺凭证当场退出,不在运行时反复检查。

---

## Forbidden Patterns

### ❌ 在后端模块直接读 `req` / `res`

后端模块(`handler.ts` / `agent-factory.ts` / `session-store.ts`)应该是**HTTP 无关**的,
通过 `HandleMessageInput` / `AgentFactoryInput` 等结构化对象接收输入,
通过 `onChunk` 回调输出。

### ❌ 使用 `setInterval` 做后台清理

Redis TTL 已自动清理。不要自己写"清理过期 session"的定时任务。

### ❌ 不同模块共享 module-level 变量

每个模块自己的 module-level 单例只能在本文件内访问。
跨模块共享 → 走参数传递 / 工厂函数。

### ❌ 在 backend 模块抛 `Response`-typed 错误(没有这种类型)

错误传递用 `Error`,HTTP 状态映射只在 `webhook.ts` / `server.ts` 做。

---

## Testing Requirements

- `npm run typecheck`
- `npm run check`
- `npm run build`
- 本地起 Redis + `npm run dev`,curl 测试一次成功路径
- 关掉 Redis,curl 测试一次 → 应该 fallback 到内存或合理失败,不应该 webhook 5xx

---

## Code Review Checklist

- [ ] Redis `set` 是否带 EX TTL
- [ ] Redis client 是否监听 `error`
- [ ] Agent 是否 `unsubscribe` / `dispose`
- [ ] 后端模块是否漏 `await persistAgent(...)`
- [ ] 后台 try/catch 是否 `push` 用户可见错误
- [ ] 是否有跨模块直接读 module-level 变量
- [ ] `pickModel` 是否被改成了带副作用的工厂(应该保持纯)
- [ ] `OPS_SYSTEM_PROMPT` 是否被偷偷加了写操作口子
