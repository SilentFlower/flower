# Type Safety

> `Type.Object` schema 用法与禁止模式。

---

## Type Organization

- 工具参数类型由 `Type.Object({...})` 推断,**不要手写 interface**(避免双写漂移)
- 公开类型:无(本包不导出 TypeScript interface,所有类型都在 `Type.Object` schema 里)
- SDK 类型:从对应 SDK 包 import,加 `type` 关键字

---

## Validation

### 工具参数:`Type.Object` schema

参数 schema **既是文档(给 LLM 看 description),也是运行期校验(由 pi 框架做)**。

```typescript
parameters: Type.Object({
  project: Type.String({ description: "..." }),
  logstore: Type.String({ description: "..." }),
  query: Type.String({ description: "..." }),
  from: Type.String({ description: "..." }),
  to: Type.Optional(Type.String({ description: "..." })),
  limit: Type.Optional(Type.Number({ description: "..." })),
})
```

### 枚举:`Type.Union(Type.Literal(...))`

```typescript
metric: Type.Union([
  Type.Literal("qps"),
  Type.Literal("rt"),
  Type.Literal("error_rate"),
  Type.Literal("slow_call_count"),
])
```

**不要**用 `Type.String()` 后在 `execute` 自己 switch(类型不严,LLM 可能传错)。

### Optional:`Type.Optional(...)`

```typescript
to: Type.Optional(Type.String({ description: "结束时间,默认 'now'" }))
```

`execute` 内用 `params.to ?? "now"` 兜底。

### 时间格式

`from` / `to` 用 `Type.String`,接受 ISO 字符串或相对时间("1h ago")。
**不用** `Type.Number` 时间戳,因为 LLM 算时间戳易出错。

---

## Common Patterns

### `_id` / `_signal` 用下划线前缀标记未使用

```typescript
async execute(_id, params, _signal) { ... }
```

让 Biome / TS 知道这是故意不用的参数。
真实接入 SDK 时,`signal` 应该传给 SDK,变成 `async execute(_id, params, signal)`。

### `Type.Number` vs `Type.Integer`

`@earendil-works/pi-ai` 的 Type 当前用 `Type.Number`(可能为浮点)。如果一定要整数,在 `execute` 用 `Math.floor(params.limit ?? 100)` 兜底。

---

## Forbidden Patterns

### ❌ `Type.Any` / `Type.Unknown`

```typescript
// 错误
parameters: Type.Object({
  filters: Type.Any({ description: "过滤条件" })  // LLM 不知道传什么
})
```

要复杂结构,用 `Type.Object({ field1: Type.String(...), ... })` 展开。

### ❌ 在 `execute` 内手写类型断言

```typescript
// 错误
async execute(_id, params) {
  const project = (params as any).project;  // 应该走 Type.Object 推断
}
```

`params` 类型由 schema 推断,不需要 `as`。

### ❌ 单字符 / 无 description 参数

```typescript
// 错误
q: Type.String()
```

参数名要语义化(`query` / `app` / `traceId`),每个必带 description。

### ❌ 工具实现里把参数当 `string | undefined`

```typescript
// 错误
async execute(_id, params) {
  if (typeof params.project !== "string") {
    throw new Error("project 必填");  // schema 已经保证必填,这里多余
  }
}
```

schema 已经做过校验,`execute` 内 `params.project` 一定是 string(对 optional 字段才需要兜底)。
