# Type Safety

> `ProviderName` 联合、`Model<Api>` 的 cast 边界。

---

## Type Organization

本包导出 **1 个公开类型**:

```typescript
export type ProviderName =
  | "havefun-openai"
  | "havefun-openai-responses"
  | "havefun-anthropic"
  | "havefun-gemini";
```

下游可以用它做类型校验,例如:

```typescript
import type { ProviderName } from "@flower-ai/flower-providers";

function pickFor(provider: ProviderName) { ... }
```

内部:

- `BuiltinModelEntry` interface(`catalog.ts`,不导出)
- `PROVIDER_TO_API: Record<ProviderName, Api>` / `API_TO_PROVIDER: Record<string, ProviderName>`(`catalog.ts`)
- `pi.registerProvider` 的 `ProviderConfig` 由 pi 上游约束

---

## Validation

### 环境变量:fail-fast

```typescript
const provider = process.env.LLM_PROVIDER;
if (!provider || provider.trim() === "") {
  throw new Error(`LLM_PROVIDER 未配置:合法值:${ALLOWED_PROVIDER_NAMES.join(" / ")}`);
}
if (!(ALLOWED_PROVIDER_NAMES as readonly string[]).includes(provider)) {
  throw new Error(`LLM_PROVIDER 非法值 "${provider}":合法值:${ALLOWED_PROVIDER_NAMES.join(" / ")}`);
}
```

**不**用 zod / yup 校验环境变量,简单 if + 联合类型已足够。

### `options.appSource`

TypeScript 编译期保证是 string,运行期额外检查"非空字符串"(空字符串会让审计完全失效)。

### `LLM_EXTRA_MODELS_JSON` 结构校验

只做基础结构校验:

- 必须是数组(`Array.isArray`)
- 每项必须是对象 + 含 `id` + `nativeApi`
- `nativeApi` 必须 ∈ pi-ai 4 个合法值

其他字段缺失走默认值(不强制每项都完整)。

---

## Common Patterns

### `as unknown as Model<Api>` 的合理边界

`buildHavefunModel` 拼装的对象在运行时确实满足 `Model<Api>` 的形状,但 TypeScript 静态分析无法确认 `compat` 字段与具体 `TApi` 的对应关系(`Model<TApi>` 是泛型)。

**唯一允许 cast 的位置**:

```typescript
// runtime.ts:buildHavefunModel 返回值
return result as unknown as Model<Api>;
```

不用 `as any`(语义太宽);用双重 assertion `as unknown as Model<Api>`,提示这是有意桥接。

### `PROVIDER_TO_API` 双向映射

```typescript
export const PROVIDER_TO_API: Record<ProviderName, Api> = {
  "havefun-openai": "openai-completions",
  "havefun-openai-responses": "openai-responses",
  "havefun-anthropic": "anthropic-messages",
  "havefun-gemini": "google-generative-ai",
};
```

类型签名 `Record<ProviderName, Api>` 保证每个 `ProviderName` 都映射到合法 `Api`;增减时编译期会提示。

### 模型字段约束

| 字段 | 类型 | 校验 |
|------|------|------|
| `id` | string | 编译期 + 网关接受度 |
| `nativeApi` | `Api`(pi-ai 类型) | 编译期 + 运行期 ∈ `ALLOWED_APIS` |
| `contextWindow` | number | 必须 ≤ 真实模型能力(否则网关拒) |
| `maxTokens` | number | 必须 ≤ contextWindow |
| `cost` | `{ input, output, cacheRead, cacheWrite }` | 4 个字段都必填(即使是 0) |

---

## Forbidden Patterns

### ❌ Non-null assertion 处理 env

```typescript
// 错误
pi.registerProvider("havefun-anthropic", {
  baseUrl: process.env.LLM_BASE_URL!,
  ...
});
```

应该:

```typescript
const baseUrl = getLLMBaseUrl(); // 内部 fail-fast
pi.registerProvider("havefun-anthropic", { baseUrl, ... });
```

### ❌ `as any` 滥用

只允许 `buildHavefunModel` 返回值的 `as unknown as Model<Api>`。其他地方 `as any` 都需要 PRD 讨论。

### ❌ `getDefaultModel` 返回值改成 `... | undefined`

```typescript
// 错误
export function getDefaultModel(): { provider: ProviderName; modelId: string } | undefined {
  if (!process.env.LLM_PROVIDER) return undefined;
  ...
}
```

env 缺失或非法应该 **fail-fast 抛错**,**不**返回 undefined 让调用方自己处理。
fail-fast 的语义是"启动期就让运维知道配错了",而不是"运行期再悄悄退化"。

### ❌ 用宽类型代替 `ProviderName`

```typescript
// 错误
export function buildHavefunModel(provider: string, modelId: string) { ... }
```

应该用 `ProviderName` 联合类型,让编译器在调用方就拒绝错误的 provider 名。
