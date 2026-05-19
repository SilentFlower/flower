# Hook Guidelines

> `pi.registerProvider` 用法、模型清单结构、4 个 provider 联合。

---

## Overview

本包**唯一调用的 pi hook**:`pi.registerProvider(name, config)`。

不调用 `pi.on(...)` / `pi.registerTool(...)`,职责单一。

`registerHavefunProviders` 一次性调 4 次 `pi.registerProvider`,注册 4 个 `havefun-*` provider。

---

## Custom Hook Patterns

### `pi.registerProvider`(Anthropic 协议示例)

```typescript
pi.registerProvider("havefun-anthropic", {
  baseUrl: process.env.LLM_BASE_URL!,
  apiKey: "LLM_API_KEY",
  api: "anthropic-messages",
  models: claudeModels.map(toProviderModelConfig),
  headers: { "X-App-Source": options.appSource },
});
```

字段含义:

| 字段 | 说明 |
|------|------|
| `name`(第一参) | provider 标识,**必须唯一**;本包统一用 4 个 `havefun-*` |
| `baseUrl` | LLM 网关基础 URL,**不带尾斜杠**,例如 `https://jp-ai.havefun.eu.cc` |
| `apiKey` | 环境变量名字符串(**不是值**),pi 内部读 env |
| `api` | API 协议,必须 ∈ pi-ai 的 4 个合法值 |
| `models` | 模型清单数组(只挂"`nativeApi` 与本 provider 协议一致"的模型子集) |
| `headers` | 额外请求头 |

---

## 4 个 provider 联合

```typescript
export type ProviderName =
  | "havefun-openai"
  | "havefun-openai-responses"
  | "havefun-anthropic"
  | "havefun-gemini";
```

约定:

1. **provider 名 → pi-ai api 字段的映射在 `catalog.ts` 集中维护**(`PROVIDER_TO_API`),不要在散落的地方重复硬编码
2. pi-ai 的正式 api 名是 `anthropic-messages` / `google-generative-ai`,**不是** `anthropic` / `gemini`(网关侧用短名,容易混淆)
3. 上游 pi-ai 增减协议时,本表与 `BUILTIN_MODELS.nativeApi` 一起更新

---

## 模型清单结构

```typescript
interface BuiltinModelEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 单一原生协议,决定注册到哪个 provider — 见 PRD ADR-6 */
  nativeApi: Api;
}

export const BUILTIN_MODELS: readonly BuiltinModelEntry[] = [
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    nativeApi: "anthropic-messages",
  },
  // ...
];
```

字段说明:

| 字段 | 类型 | 注意 |
|------|------|------|
| `id` | string | 模型唯一标识,与网关 `/v1/models` 一致 |
| `name` | string | 给 UI 显示的可读名 |
| `reasoning` | boolean | 是否是 reasoning 模型(Claude / Gemini thinking / GPT-5.x reasoning) |
| `input` | readonly `("text" \| "image")[]` | 支持的输入模态 |
| `cost` | `{ input, output, cacheRead, cacheWrite }` | 当前全 0(占位),接通计费系统后再补 |
| `contextWindow` | number | 上下文窗口大小(token 数) |
| `maxTokens` | number | 单次输出最大 token 数 |
| `nativeApi` | `Api` | **以人工知识为准**,不机械跟随网关 `/v1/models` 返回值(例如 `gpt-5.5` 网关漏报,本包仍写 `openai-responses`) |

新增模型时:

1. 加到 `BUILTIN_MODELS` 数组,**或**通过 `LLM_EXTRA_MODELS_JSON` 注入(运维侧不改代码)
2. `nativeApi` 必须 ∈ pi-ai 的 4 个合法值(`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`)
3. `contextWindow` / `maxTokens` 按真实模型能力填(填错会让网关拒)

---

## Data Fetching

不适用(本包只注册不调用)。

实际的 LLM 调用在 `ops-bot` 通过 `streamSimple` 发起、在 `code-reviewer` 通过 `piMain` 内部完成。

---

## Naming Conventions

- provider 名:`havefun-<协议短名>`(`havefun-openai` / `havefun-anthropic` / 等),**严禁**沿用历史 placeholder 命名(如旧版本曾用的通用单词代号)
- 模型 id:直接采用网关 `/v1/models` 中的 id(如 `claude-opus-4-7` / `gemini-2.5-flash` / `gpt-5.4`)
- header 名:大写驼峰(`X-App-Source`),保持 HTTP header 约定

---

## Common Mistakes

- ❌ 注册同名 provider 多次(后注册的会覆盖前面,且无警告)
- ❌ `baseUrl` 带尾 `/`(`new URL(path, baseUrl)` 行为变化)
- ❌ `nativeApi` 写 `"anthropic"` / `"gemini"`(网关短名),应写 pi-ai 正式名 `"anthropic-messages"` / `"google-generative-ai"`
- ❌ 把同一个模型注册到多个 provider(本包设计是单一原生协议归属;若需跨协议,通过 `LLM_EXTRA_MODELS_JSON` 显式指定不同 `nativeApi` 的副本)
- ❌ `cost` 字段填真实数值(本仓库约定为 0;计费在网关 / 计费系统层做)
- ❌ 把 `BUILTIN_MODELS` 改成可变 `let`(应该 `const` + immutable)
