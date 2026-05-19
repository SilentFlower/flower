# @flower-ai/flower-providers

自定义 LLM provider 统一注册扩展。把自部署 / 内部 / 第三方代理的 LLM 网关接入
[pi-coding-agent](https://github.com/earendil-works/pi-mono) 与 [pi-agent-core](https://github.com/earendil-works/pi-mono)。

## 职责

- 集中管理 LLM 网关的 `baseUrl`、API key 引用、模型清单
- 为不同产品注入 `X-App-Source` header,便于网关侧审计 / 计费
- 提供"取默认模型"的统一入口,模型选择由 env 驱动(进程级)

## 公开 API

| API | 形态 | 用途 |
|------|------|------|
| `registerHavefunProviders(pi, options)` | 函数 | 给 pi-coding-agent 形态(CLI)注册 4 个 provider |
| `getDefaultModel()` | 函数 | 读 `LLM_PROVIDER` + `LLM_MODEL`,返回 `{ provider, modelId }` |
| `buildHavefunModel(provider, modelId)` | 函数 | 构造 pi-ai `Model<Api>` 对象,给 pi-agent-core 形态(Agent 实例)用 |
| `ProviderName` | 类型 | 4 个 provider 名的联合类型 |

## 4 个 provider

| Provider 名 | pi-ai 协议(`api` 字段) | 默认挂的模型家族 |
|---|---|---|
| `havefun-openai` | `openai-completions` | 兜底接口,默认无内置模型;通过 `LLM_EXTRA_MODELS_JSON` 注入只支持 openai-completions 的模型(grok / qwen / glm 等) |
| `havefun-openai-responses` | `openai-responses` | GPT-5.x codex 系列(`gpt-5.4` / `gpt-5.5`),拿到 reasoning summary |
| `havefun-anthropic` | `anthropic-messages` | Claude 系列(`claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5-20251001`),原生 thinking |
| `havefun-gemini` | `google-generative-ai` | Gemini 系列(`gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-2.5-flash-lite`) |

每个模型只挂载到自己的**原生协议** provider,避免协议降级丢失家族特性。

## 用法

### 形态 A:pi-coding-agent(code-reviewer)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHavefunProviders } from "@flower-ai/flower-providers";

export default function (pi: ExtensionAPI) {
  registerHavefunProviders(pi, { appSource: "code-reviewer" });
}
```

`registerHavefunProviders` 一次性注册 4 个 provider。pi 启动后用户通过 `/model` 选哪个,
或在 `models.json` 中配 `defaultModel` 字段。

### 形态 B:pi-agent-core(ops-bot)

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import { buildHavefunModel, getDefaultModel } from "@flower-ai/flower-providers";

const { provider, modelId } = getDefaultModel();
const model = buildHavefunModel(provider, modelId);

new Agent({
  initialState: { model, /* systemPrompt / tools / messages */ },
  streamFn: (model, ctx, opts) => streamSimple(model, ctx, {
    ...opts,
    apiKey: process.env.LLM_API_KEY ?? "",
  }),
});
```

## 环境变量

| 变量 | 必填 | 含义 |
|------|:----:|------|
| `LLM_BASE_URL` | ✓ | LLM 网关**根 URL**(自部署 vLLM / 内部 AI Gateway / 任意 OpenAI 兼容代理)。**不要带 `/v1` / `/v1beta` / `/anthropic` 等后缀** — 本包按 provider 自动拼:openai-* → `/v1`,gemini → `/v1beta`,anthropic 无后缀(Anthropic SDK 自己拼 `/v1/messages`) |
| `LLM_API_KEY` | ✓ | API key。**不会经过本包代码** — pi 直接从 env resolve;ops-bot 路径在 streamFn 中直读 |
| `LLM_PROVIDER` | ✓ | 默认 provider,合法值:`havefun-openai` / `havefun-openai-responses` / `havefun-anthropic` / `havefun-gemini` |
| `LLM_MODEL` | ✓ | 默认模型 id,必须存在于合并模型清单(builtin + extras),且其 `nativeApi` 与 `LLM_PROVIDER` 对应协议一致 |
| `LLM_EXTRA_MODELS_JSON` |   | (可选)JSON 数组,注入额外模型,格式见下文 |

任一必填 env 缺失或非法,启动期 fail-fast 抛错。

### `LLM_EXTRA_MODELS_JSON` 示例

每条 entry 至少需要 `id` + `nativeApi`,其余字段缺失走默认值:

```json
[
  { "id": "grok-4.20-fast", "nativeApi": "openai-completions" },
  {
    "id": "qwen3-max",
    "name": "Qwen3 Max",
    "nativeApi": "openai-completions",
    "contextWindow": 32000,
    "maxTokens": 8192,
    "reasoning": true,
    "input": ["text"],
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
  }
]
```

`nativeApi` 决定该模型注册到哪个 provider(必须 ∈ 4 个 pi-ai 合法值)。
同 id 时 extras 覆盖 builtin。

shell / docker env 多行 JSON 转义麻烦时,推荐:
- shell:用单引号包整段 JSON
- docker:base64 编码后在 entrypoint 用 `base64 -d` 还原后再 `export`

## 内置模型清单

8 条 builtin,数据见 [`src/catalog.ts`](./src/catalog.ts):

- Claude 家族 3 条 → `havefun-anthropic`
- Gemini 家族 3 条 → `havefun-gemini`
- GPT-5.x 家族 2 条(`gpt-5.4` / `gpt-5.5`) → `havefun-openai-responses`
- `havefun-openai` 默认空(供 extras 注入)

cost 字段当前全填 0(占位),接通计费系统后再补真实数据。

## TODO

- 如果网关支持 OAuth/SSO,需要补 `oauth` 配置(本任务未做)
- 如果网关有非标鉴权头(非 `Authorization: Bearer`),需要调整 `authHeader`(本任务未做)
- `BUILTIN_MODELS.cost` 接通计费系统后补真实数据
