# Type Safety

> Model 类型与 `as any` 的边界。

---

## Type Organization

本包不导出类型(pi 的 `ExtensionAPI` 由 caller 传入)。

内部:

- `CUSTOM_MODELS` 元素隐式类型由对象字面量推断
- `pi.registerProvider` 的 config 类型由 pi 上游约束

---

## Validation

### 环境变量:fail-fast

```typescript
if (!baseUrl) throw new Error("LLM_BASE_URL 环境变量未配置");
```

**不**用 zod / yup 校验环境变量,简单 if 已足够。

### `options.appSource`

TypeScript 编译期保证是 string,运行期不再校验(caller 是仓库内 product 包,可信)。

---

## Common Patterns

### `as const` for readonly literals

```typescript
input: ["text", "image"] as const,
```

让 `input` 类型为 `readonly ["text", "image"]` 而非 `string[]`。

### `as any` 的合理边界

`pi.registerProvider` 的 `models` 字段在 pi 上游类型严格,
自定义 LLM 网关的模型清单字段(如 `cost` 子字段、`input` 模态名)pi 不一定全覆盖。

**唯一允许 `as any` 的位置**:

```typescript
// biome-ignore lint/suspicious/noExplicitAny: pi 的 Model 类型在自定义 provider 上较宽松
models: CUSTOM_MODELS as any,
```

必须有 `biome-ignore` 注释 + 中文原因说明。

### 模型字段约束

| 字段 | 类型 | 校验 |
|------|------|------|
| `id` | string | 编译期 + 网关接受度 |
| `contextWindow` | number | 必须 ≤ 真实模型能力(否则网关拒) |
| `maxTokens` | number | 必须 ≤ contextWindow |
| `cost` | `{ input, output, cacheRead, cacheWrite }` | 4 个字段都必填(即使是 0) |

---

## Forbidden Patterns

### ❌ Non-null assertion 处理 env

```typescript
// 错误
pi.registerProvider("company", {
  baseUrl: process.env.LLM_BASE_URL!,
  ...
});
```

应该:

```typescript
const baseUrl = process.env.LLM_BASE_URL;
if (!baseUrl) throw new Error("...");
pi.registerProvider("company", { baseUrl, ... });
```

### ❌ `as any` 滥用

只允许 `models: CUSTOM_MODELS as any` 这一处。其他地方 `as any` 都需要 PRD 讨论。

### ❌ `getDefaultModelId` 返回值改成 `string | undefined`

```typescript
// 错误
export function getDefaultModelId(appSource: string): string | undefined {
  if (appSource === "code-reviewer") return "company-gpt-4";
  return undefined;
}
```

未知 appSource 应该返回保守默认值(`company-gpt-4-mini`),让 caller 总能拿到可用模型。
