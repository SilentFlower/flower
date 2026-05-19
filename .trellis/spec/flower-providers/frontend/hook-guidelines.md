# Hook Guidelines

> `pi.registerProvider` 用法、模型清单结构。

---

## Overview

本包**唯一调用的 pi hook**:`pi.registerProvider(name, config)`。

不调用 `pi.on(...)` / `pi.registerTool(...)`,职责单一。

---

## Custom Hook Patterns

### `pi.registerProvider`

```typescript
pi.registerProvider("company", {
  baseUrl: process.env.LLM_BASE_URL!,
  apiKey: "LLM_API_KEY",
  api: "openai-completions",
  models: CUSTOM_MODELS as any,
  headers: { "X-App-Source": options.appSource },
});
```

字段含义:

| 字段 | 说明 |
|------|------|
| `name`(第一参) | provider 标识,**必须唯一**。本仓库统一用 `"company"`,新增网关再加 |
| `baseUrl` | LLM 网关基础 URL,**不带尾斜杠**,例如 `https://ai-gateway.corp.internal/v1` |
| `apiKey` | 环境变量名字符串(**不是值**),pi 内部读 env |
| `api` | API 协议,目前都用 `"openai-completions"`(OpenAI 兼容协议) |
| `models` | 模型清单数组 |
| `headers` | 额外请求头 |

---

## 模型清单结构

```typescript
const CUSTOM_MODELS = [
  {
    id: "company-gpt-4",
    name: "Custom GPT-4",
    reasoning: false,
    input: ["text", "image"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  },
  ...
];
```

字段说明:

| 字段 | 类型 | 注意 |
|------|------|------|
| `id` | string | 模型唯一标识,小写加横杠 |
| `name` | string | 给 LLM 看的可读名 |
| `reasoning` | boolean | 是否是 reasoning 模型(o1 / claude-thinking 这类) |
| `input` | readonly `("text" \| "image" \| ...)[]` | 支持的输入模态,**必须 `as const`** |
| `cost` | `{ input, output, cacheRead, cacheWrite }` | 计费占位,本仓库都填 0(真实计费走网关) |
| `contextWindow` | number | 上下文窗口大小(token 数) |
| `maxTokens` | number | 单次输出最大 token 数 |

新增模型时:

1. 加到 `CUSTOM_MODELS` 数组
2. `contextWindow` / `maxTokens` 必须按真实模型能力填(填错会让 LLM 调用直接被网关拒)
3. 如果是新模态(audio / video),`input` 数组扩展并保持 `as const`

---

## Data Fetching

不适用(本包只注册不调用)。

实际的 LLM 调用在 `ops-bot` 通过 `streamSimple` 发起、在 `code-reviewer` 通过 `piMain` 内部完成。

---

## Naming Conventions

- provider 名:小写,单词(`"company"`)
- 模型 id:`<provider>-<model-name>`(`company-gpt-4`、`company-gpt-4-mini`)
- header 名:大写驼峰(`X-App-Source`),保持 HTTP header 约定

---

## Common Mistakes

- ❌ 注册多个 provider 用相同 name(后注册的会覆盖前面,且无警告)
- ❌ `baseUrl` 带尾 `/`(`new URL(path, baseUrl)` 行为变化)
- ❌ `input` 不加 `as const`(类型变成 `string[]` 而非字面量联合,pi 类型推断失败)
- ❌ `cost` 字段填真实数值(本仓库约定为 0;计费在网关层做)
- ❌ 把 `CUSTOM_MODELS` 改成可变 `let`(应该 `const` + immutable)
- ❌ `models: CUSTOM_MODELS` 不加 `as any`(pi 严格类型,自定义 model 字段必须 cast)
