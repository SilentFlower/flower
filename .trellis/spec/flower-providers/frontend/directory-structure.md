# Directory Structure

> `@flower-ai/flower-providers` 的目录布局。

---

## Directory Layout

```
packages/flower-providers/
├── src/
│   ├── index.ts        # 纯 re-export 出口(≤ 10 行)
│   ├── env.ts          # 环境变量校验与解析(getLLMBaseUrl / getLLMProvider / ...)
│   ├── catalog.ts      # BUILTIN_MODELS + ProviderName + PROVIDER_TO_API 等常量
│   ├── register.ts     # registerHavefunProviders 实现(4 个 provider 一次性注册)
│   ├── runtime.ts      # getDefaultModel + buildHavefunModel 实现
│   └── __tests__/      # vitest 单元测试(env / catalog / runtime / register)
├── dist/
├── package.json
└── tsconfig.json
```

**本包共 5 个源文件(不含测试)**。

---

## Module Organization

| 元素 | 文件 | 是否导出 |
|------|------|---------|
| `BUILTIN_MODELS` | `catalog.ts` | ❌(内部) |
| `BuiltinModelEntry` | `catalog.ts` | ❌(内部) |
| `ProviderName` | `catalog.ts` | ✅(类型) |
| `PROVIDER_TO_API` / `API_TO_PROVIDER` / `ALLOWED_*` | `catalog.ts` | ❌(内部) |
| `getLLMBaseUrl` / `getLLMApiKeyEnvName` / `getLLMProvider` / `getLLMModel` / `getExtraModels` / `getMergedModels` | `env.ts` | ❌(内部) |
| `registerHavefunProviders(pi, options)` | `register.ts` | ✅ |
| `getDefaultModel()` | `runtime.ts` | ✅ |
| `buildHavefunModel(provider, modelId)` | `runtime.ts` | ✅ |

`src/index.ts` 只做 `re-export`,不写实现:

```typescript
export { registerHavefunProviders } from "./register.js";
export { buildHavefunModel, getDefaultModel } from "./runtime.js";
export type { ProviderName } from "./catalog.js";
```

---

## 模块依赖关系

```
index.ts  ──re-export─►  register.ts
                         ├── env.ts ──► catalog.ts
                         └── catalog.ts

index.ts  ──re-export─►  runtime.ts
                         ├── env.ts ──► catalog.ts
                         └── catalog.ts
```

- `catalog.ts` 是叶子(只 import `pi-ai` 类型),其他模块都依赖它
- `env.ts` 依赖 `catalog.ts`(取合法值集做校验)
- `register.ts` / `runtime.ts` 互不依赖(避免环依赖),都依赖 `env.ts` + `catalog.ts`
- 只有 `env.ts` 直接读 `process.env`,其他模块通过 `env.ts` 间接读

---

## 何时需要拆文件

当下"5 文件"结构稳定。下列情况发生时再拆:

- `BUILTIN_MODELS` 超过 ~50 条 → 拆 `catalog/` 子目录按家族(claude.ts / gemini.ts / ...)
- 增加 OAuth 支持 → `oauth.ts`
- 增加 LLM 调用统计上报 → `telemetry.ts`

---

## Naming Conventions

- 公开函数:`<动词><Havefun><名词>` 模式(`registerHavefunProviders` / `buildHavefunModel`),前缀 `Havefun` 与 provider 名一致
- 私有常量:全大写下划线(`BUILTIN_MODELS` / `PROVIDER_TO_API`)
- 模型 id:直接采用网关 `/v1/models` 命名(`claude-opus-4-7` / `gemini-2.5-flash` / `gpt-5.4`)
- 环境变量:`LLM_*` 前缀(`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_PROVIDER` / `LLM_MODEL` / `LLM_EXTRA_MODELS_JSON`)

---

## Examples

- 4 个 provider 集中注册:`src/register.ts`
- env 校验矩阵:`src/env.ts` 的 fail-fast 函数族
- 模型清单:`src/catalog.ts:BUILTIN_MODELS`
