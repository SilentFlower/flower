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
| `getDefaultReasoningEffort(modelId?)` | 函数 | 返回该 model 的默认 reasoning effort,优先级:env > per-model 默认 > 全局 fallback `"high"` |
| `ProviderName` | 类型 | 4 个 provider 名的联合类型 |
| `ModelThinkingLevel` | 类型 | pi 统一 6 级思考强度:`off / minimal / low / medium / high / xhigh` |
| `ThinkingLevelMap` | 类型 | 把 pi level 映射到 provider 自家实际 effort 字符串(`Partial<Record<ModelThinkingLevel, string \| null>>`) |

## 4 个 provider

| Provider 名 | pi-ai 协议(`api` 字段) | 默认挂的模型家族 |
|---|---|---|
| `havefun-openai` | `openai-completions` | 兜底接口,默认无内置模型;通过 `LLM_EXTRA_MODELS_JSON` 注入只支持 openai-completions 的模型(grok / qwen / glm 等) |
| `havefun-openai-responses` | `openai-responses` | GPT 系列(`gpt-5.4` / `gpt-5.5` / `gpt-6.1-sol`),拿到 reasoning summary |
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

`registerHavefunProviders` 一次性注册 4 个 provider。reviewer 通过 `buildPiCliArgs` 显式传递 provider、模型和 thinking 参数。注册时把 `$LLM_API_KEY` 交给 pi 1.6.0 从环境解析。

### 形态 B:pi-agent-core(ops-bot)

流式函数从 `@earendil-works/pi-ai/api/<协议>` 导入。下面以 `havefun-openai` 的 Completions 协议为例，模型 ID 需在 `LLM_EXTRA_MODELS_JSON` 中登记。实际机器人根据 `model.api` 选择对应的公开子入口，见 [agent-factory.ts](../../apps/ops-bot/src/agent-factory.ts)。

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { hasApi } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { buildHavefunModel, getDefaultModel } from "@flower-ai/flower-providers";

const { provider, modelId } = getDefaultModel();
const model = buildHavefunModel(provider, modelId);

new Agent({
  initialState: { model, /* systemPrompt / tools / messages */ },
  streamFn: (model, context, options) => {
    if (!hasApi(model, "openai-completions")) {
      throw new Error(`需要 Completions 模型，实际协议为 ${model.api}`);
    }
    return streamSimple(model, context, {
      ...options,
      apiKey: process.env.LLM_API_KEY,
    });
  },
});
```

## 环境变量

| 变量 | 必填 | 含义 |
|------|:----:|------|
| `LLM_BASE_URL` | ✓ | LLM 网关**根 URL**(自部署 vLLM / 内部 AI Gateway / 任意 OpenAI 兼容代理)。**不要带 `/v1` / `/v1beta` / `/anthropic` 等后缀** — 本包按 provider 自动拼:openai-* → `/v1`,gemini → `/v1beta`,anthropic 无后缀(Anthropic SDK 自己拼 `/v1/messages`) |
| `LLM_API_KEY` | ✓ | 网关 API key。reviewer 由 pi 展开注册配置里的 `$LLM_API_KEY`，ops-bot 把环境中的值传给协议子入口。 |
| `LLM_PROVIDER` | ✓(SDK 路径)| 默认 provider,合法值:`havefun-openai` / `havefun-openai-responses` / `havefun-anthropic` / `havefun-gemini`。**CLI 路径**(`buildPiCliArgs`,code-reviewer 用)缺省 fallback 到 `havefun-openai-responses`(2026-05-21 stress test 实测稳定组合) |
| `LLM_MODEL` | ✓(SDK 路径)| 默认模型 id,必须存在于合并模型清单(builtin + extras),且其 `nativeApi` 与 `LLM_PROVIDER` 对应协议一致。**CLI 路径**缺省 fallback 到 `gpt-6.1-sol` |
| `LLM_EXTRA_MODELS_JSON` |   | (可选)JSON 数组,注入额外模型,格式见下文 |
| `LLM_REASONING_EFFORT` |   | (可选)统一调节"思考预算",合法值 `off / minimal / low / medium / high / xhigh`。**SDK 路径**配置后覆盖所有 model 的默认 effort,不配则按 per-model 默认拉到该 model 的实际上限。**CLI 路径**缺省 fallback 到 `high`(stress test 显式配置端) |

ops-bot 创建 Agent 时校验模型、网关及推理配置。协议子入口在请求时检查凭据。reviewer 注册 provider 时校验网关及凭据，`buildPiCliArgs` 对缺省的 provider、模型和推理强度使用 `havefun-openai-responses + gpt-6.1-sol + high`。显式配置的合法性由相应入口校验。

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

9 条 builtin,数据见 [`src/catalog.ts`](./src/catalog.ts):

- Claude 家族 3 条 → `havefun-anthropic`
- Gemini 家族 3 条 → `havefun-gemini`
- GPT 家族 3 条(`gpt-5.4` / `gpt-5.5` / `gpt-6.1-sol`) → `havefun-openai-responses`
- `havefun-openai` 默认空(供 extras 注入)

cost 字段当前全填 0(占位),接通计费系统后再补真实数据。

`gpt-6.1-sol` 的上下文窗口为 1,050,000 token,最大输出 128,000 token,支持文本与图片输入。
工具调用使用 Responses API,默认 reviewer 推理强度为 `high`。能力参数见
[OpenAI 官方模型文档](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。

## Reasoning Effort

`getDefaultReasoningEffort(modelId?)` 提供"取该 model 的默认 reasoning effort"的统一入口,
**仅 ops-bot 形态(`streamFn` 内)需要调用**,把返回值传给 `streamSimple` 的 `reasoning` 字段。
code-reviewer 形态由 pi CLI 自己管 thinking level(通过 `/thinking` 命令 / config),不调本函数。

### 决策优先级

1. `LLM_REASONING_EFFORT` env 显式配置(全局开关)
2. `PER_MODEL_DEFAULT_EFFORT` 每模型默认(下表)
3. 全局兜底 `"high"`

### Per-model 默认(env 未配时)

| 模型 | 默认 effort | 实际效果 |
|---|---|---|
| `claude-opus-4-7` | `xhigh` | 经 `thinkingLevelMap` 映射到 anthropic 实际最高 `"max"` |
| `claude-sonnet-4-6` | `high` | pi 默认 mapping,实际拿到 effort `"high"` |
| `claude-haiku-4-5-20251001` | `off` | reasoning=false,跳过 thinking |
| `gemini-2.5-pro` | `high` | 经 ops-bot `thinkingBudgets.high` 算 budget |
| `gemini-2.5-flash` | `high` | 同上 |
| `gemini-2.5-flash-lite` | `off` | reasoning=false,跳过 thinking |
| `gpt-5.4` | `xhigh` | OpenAI Responses 直接发 `reasoning.effort: "xhigh"` |
| `gpt-5.5` | `xhigh` | 同上 |

### Responses 协议的 reasoning 设置

```typescript
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { hasApi } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { getDefaultReasoningEffort } from "@flower-ai/flower-providers";

const streamResponses: StreamFn = (model, context, options) => {
  if (!hasApi(model, "openai-responses")) {
    throw new Error(`需要 Responses 模型，实际协议为 ${model.api}`);
  }
  const effort = getDefaultReasoningEffort(model.id);
  return streamSimple(model, context, {
    ...options,
    apiKey: process.env.LLM_API_KEY,
    reasoning: effort === "off" ? undefined : effort,
  });
};
```

Gemini 2.5 Pro 和 Flash 使用 `agent-factory.ts` 中的 `thinkingBudgets`，`xhigh` 按 `high` 档传递。保留 Agent 提供的 transcript 和取消信号。

## TODO

- 如果网关支持 OAuth/SSO,需要补 `oauth` 配置(本任务未做)
- 如果网关有非标鉴权头(非 `Authorization: Bearer`),需要调整 `authHeader`(本任务未做)
- `BUILTIN_MODELS.cost` 接通计费系统后补真实数据
