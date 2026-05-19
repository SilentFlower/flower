# Type Safety

> 类型组织与运行期校验。

---

## Type Organization

| 类型 | 文件 | 是否导出 |
|------|------|---------|
| `DingTalkRequest` | `src/dingtalk/webhook.ts` | ❌ 内部 |
| `HandleMessageInput` | `src/handler.ts` | ✅ |
| `AgentFactoryInput` / `AgentInstance` | `src/agent-factory.ts` | ✅ |
| `StoredSession` / `SessionBackend` | `src/session-store.ts` | `StoredSession` ✅,`SessionBackend` ❌ |
| `LineCommentInput` / `BotComment` 等远端来源类型 | 各 tools 包 re-export | ✅(由源包决定) |

---

## Validation

### HTTP 入参:就近 try/catch

```typescript
let payload: DingTalkRequest;
try {
  payload = JSON.parse(body) as DingTalkRequest;
} catch {
  res.writeHead(400, ...);
  return;
}
```

注意:`as DingTalkRequest` **不是真的校验**,只是给 TypeScript 一个类型。运行期如果 body 字段缺失,后续访问会得到 `undefined`,需要在使用点兜底。

### 签名校验:防重放 + 类型守卫

```typescript
const ts = Number.parseInt(timestamp, 10);
if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > 60 * 60 * 1000) {
  return false;
}
```

`Number.parseInt` + `Number.isNaN` 双重防御,避免 LLM/调用方传入非数字字符串。

### 工具参数:`Type.Object` schema

参考 `flower-tools-arms` 的工具定义。本包不直接定义工具(只是装配),不重复约束。

### Redis 反序列化:try/catch + 兜底 undefined

```typescript
try {
  return JSON.parse(value) as StoredSession;
} catch {
  return undefined;
}
```

约定:**Redis 读到的脏数据视为没有**,不要 throw 让上层失败。

---

## Common Patterns

### `as const` 用于信号集合

```typescript
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, ...);
}
```

让 `signal` 类型为 `"SIGINT" | "SIGTERM"` 而非 `string`。

### `?? 0` / `?? ""` 防 `undefined`

```typescript
const last = lastPushAt.get(sessionWebhook) ?? 0;
```

`noUncheckedIndexedAccess` 已开,Map/数组 indexer 默认带 `undefined`。

### `Number.parseInt` 取代全局 `parseInt`

Biome 推荐 `Number.parseInt` / `Number.isNaN`。

---

## Forbidden Patterns

### ❌ 把 `req.body` 类型化为复杂对象不兜底

```typescript
// 错误:LLM 看不见 undefined,后续访问会 NaN
const ts = req.headers.timestamp as number;
```

正确:用 `String(... ?? "")` + `Number.parseInt`。

### ❌ `any` 滥用

只有跨包类型转换(`tools.ts:toAgentTool`、`agent-factory.ts:pickModel`)允许 `any`,且必须加 `// biome-ignore lint/suspicious/noExplicitAny:` 注释说明原因。

### ❌ Non-null assertion 处理 `process.env`

```typescript
// 错误
const url = process.env.REDIS_URL!;
```

应该:`const url = process.env.REDIS_URL;` 后 `if (!url) { ... }` 分支处理(降级到内存 backend 或 throw)。
