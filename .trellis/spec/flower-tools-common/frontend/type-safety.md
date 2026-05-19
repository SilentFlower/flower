# Type Safety

> 见 `flower-tools-arms/frontend/type-safety.md`。本节列本包特有点。

---

## Type Organization

- 工具参数:`Type.Object` schema,字段类型由推断
- 系统枚举:`Type.Union(Type.Literal(...))`(例:`zentaoEntityType = Union([Literal("bug"), Literal("task"), ...])`)
- 工具不导出 TypeScript interface(类型在 schema 里)

参考:`src/zentao.ts:17-26`(`zentaoEntityType` 联合字面量)

---

## Validation

### 工具参数

走 `Type.Object` schema,运行期由 pi 框架做 schema 校验。

### 凭证 / env

```typescript
const appKey = process.env.DINGTALK_APP_KEY;
const appSecret = process.env.DINGTALK_APP_SECRET;
if (!appKey || !appSecret) throw new Error("...");
```

不用 zod,简单 if 即可。

### API 响应

钉钉 / 禅道 API 响应**先 `unknown`**,再窄化:

```typescript
const data = (await resp.json()) as { accessToken?: string; expireIn?: number };
if (typeof data.accessToken !== "string" || typeof data.expireIn !== "number") {
  throw new Error("钉钉 accessToken 响应格式异常");
}
```

不要 `as { accessToken: string; expireIn: number }` 强 cast 后直接用。

---

## Common Patterns

### 系统枚举集中定义

```typescript
const zentaoEntityType = Type.Union(
  [Type.Literal("bug"), Type.Literal("task"), Type.Literal("story"), Type.Literal("case")],
  { description: "限定对象类型:bug / task / story / case" },
);
```

参考 `src/zentao.ts:17-26`。

### Optional 字段 + 内部默认值

```typescript
limit: Type.Optional(Type.Number({ description: "返回数量,默认 10" }))
```

execute 内 `params.limit ?? 10`。

---

## Forbidden Patterns

### ❌ `as` 强转 API 响应

```typescript
// 错误
const data = (await resp.json()) as DingtalkSearchResponse;
return data.docs.map(...);
```

至少校验关键字段存在。

### ❌ 把禅道 `status` 写成联合字面量

```typescript
// 错误
status: Type.Union([Type.Literal("active"), Type.Literal("closed")])
```

不同禅道实例的 status 取值不同(可以自定义),保持 `Type.String({ description: "..." })` 并在 description 里说明"具体取值看禅道配置"。

### ❌ accessToken 字段返回 `string | undefined`

```typescript
// 错误
async function getDingTalkAccessToken(): Promise<string | undefined>
```

要么返回 string,要么 throw。`undefined` 会让调用方加大量分支,徒增复杂度。
