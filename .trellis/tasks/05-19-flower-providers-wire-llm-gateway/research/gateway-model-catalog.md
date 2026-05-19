# 目标 LLM 网关:模型清单与协议矩阵

> 探测时间:2026-05-19
> 网关 baseUrl:`https://jp-ai.havefun.eu.cc`(开发环境)
> API key:**不落盘**,运行时从 `LLM_API_KEY` env 注入
> 探测命令:`GET /v1/models`(OpenAI 兼容 `/v1/models` 列表)

## 网关性质

这是一个**多协议聚合网关**。每个模型用 `supported_endpoint_types` 字段标注它支持的 API 协议。
同一个模型可以通过多种协议访问(例如 `claude-opus-4-7` 既支持 `anthropic` 也支持 `openai`)。

支持的协议类型(对应 pi-ai 的 `Api`):

| 网关协议名 | pi-ai 对应 `api` 字段 | pi-coding-agent `ProviderConfig.api` |
|------|------|------|
| `openai` | `openai-completions` | `"openai-completions"` |
| `openai-response` | `openai-responses` | `"openai-responses"` |
| `anthropic` | `anthropic` | `"anthropic"` |
| `gemini` | `google` | (不确定,见 pi-ai providers/google) |
| `openai-response-compact` | (无对应,网关自定义压缩格式) | — |
| `jina-rerank` | (rerank,非 chat) | — |
| `image-generation` | (image gen,非 chat) | — |

## 模型概览(按家族)

> **完整清单见网关 `/v1/models` 实时探测;此处只列出对本项目重要的 chat 模型**

### Claude 家族(代码评审 / 复杂推理首选)

| 模型 id | 支持协议 | owner |
|---|---|---|
| `claude-opus-4-7` | anthropic, openai | custom |
| `claude-opus-4-6` | openai, openai-response, openai-response-compact, anthropic, gemini, ... | vertex-ai |
| `claude-opus-4-5-20251101` | gemini, openai, openai-response, anthropic, ... | vertex-ai |
| `claude-opus-4-5-thinking` | openai, openai-response, anthropic, gemini, ... | custom |
| `claude-sonnet-4-6` | openai, openai-response, openai-response-compact, anthropic, gemini, ... | vertex-ai |
| `claude-sonnet-4-5` | openai, openai-response, anthropic, gemini, ... | custom |
| `claude-sonnet-4-5-20250929` | anthropic, gemini, openai, openai-response, ... | vertex-ai |
| `claude-haiku-4-5-20251001` | image-generation, openai, openai-response, anthropic, gemini, ... | vertex-ai |

### GPT-5.x 家族(通用 / codex)

| 模型 id | 支持协议 | owner |
|---|---|---|
| `gpt-5-codex` | openai, openai-response, anthropic, gemini, ... | codex |
| `gpt-5.1-codex` | openai, openai-response, anthropic, gemini, ... | codex |
| `gpt-5.1-codex-max` | openai-response, anthropic, gemini, openai, ... | codex |
| `gpt-5.1-codex-mini` | anthropic, gemini, openai, openai-response, ... | codex |
| `gpt-5.2` | anthropic, gemini, openai, openai-response, ... | codex |
| `gpt-5.2-codex` | openai, openai-response, anthropic, gemini, ... | codex |
| `gpt-5.3-codex` | openai, openai-response, openai-response-compact, anthropic, gemini, ... | codex |
| `gpt-5.4` | openai-response-compact, anthropic, gemini, openai, openai-response, ... | codex |
| `gpt-5.4-mini` | openai | custom |
| `gpt-5.5` | openai | custom |

### Gemini 家族

| 模型 id | 支持协议 | owner |
|---|---|---|
| `gemini-3-pro-preview` | gemini, openai, openai-response, anthropic, ... | vertex-ai |
| `gemini-3-pro-high` / `gemini-3-pro-low` | 全协议 | custom |
| `gemini-3.1-pro` / `gemini-3.1-pro-preview` | 全协议 | custom / vertex-ai |
| `gemini-3-flash` / `gemini-3-flash-preview` | 全协议 | custom / vertex-ai |
| `gemini-2.5-pro` / `gemini-2.5-flash` / `gemini-2.5-flash-lite` | 全协议 | vertex-ai |

### 其他可选(国产 / DeepSeek / Grok)

- `deepseek-v4-pro` / `deepseek-v4-flash`(各种变体:thinking / search / vision) — anthropic + openai
- `grok-4.20-beta` — 全协议;其他 grok 变体只支持 `openai`
- `kimi-k2.6` / `moonshotai/Kimi-K2.5` — openai
- `minimaxai/minimax-m2.7` — openai
- `qwen3-max` — openai
- `z-ai/glm5` — openai

## 关键观察

1. **`openai` (即 `openai-completions`) 是最广覆盖的协议** — 所有列出的 chat 模型都支持,可以做 MVP 的统一协议
2. **`anthropic` 协议覆盖 Claude / GPT-5.x codex / Gemini / DeepSeek 大部分**(但不覆盖 grok / kimi / minimax / qwen / glm)
3. **同一模型多协议访问**:意味着如果选 1 个协议(如 `openai`)就足够支撑两个产品,但**协议自动选优**(thinking / reasoning 等)的语义有差异 — 例如 Claude 用 anthropic 协议能拿到原生 thinking,用 openai-completions 协议拿不到
4. **embedding / rerank / image gen 模型**(`BAAI/bge-m3` / `jina-reranker-v3` / `gpt-image-2` 等)与本任务无关,本任务只关心 chat models

## 对 flower-providers 的影响

- 现有 `index.ts` 写死 `api: "openai-completions"` — 与网关最广覆盖一致,**这一选择本身没错**
- 但是 **provider name 与 model id 的关系需要重新设计**:
  - 当前:1 个 provider `"company"` + N 个 model id(占位)
  - 真实情况:1 个 provider 可以挂这个网关支持的所有 model id;模型 id 是网关已经定义好的(如 `claude-opus-4-7` / `gpt-5.1-codex-max`),不需要我们重新命名
- 是否要为 4 个协议各注册 1 个 provider(`company-openai` / `company-anthropic` / `company-gemini` / `company-openai-responses`)? — **见 PRD Q3**

## 不落盘的信息

- API key(对话中提供) — 已用 `LLM_API_KEY` env 注入,不写入任何文件
- 该网关是开发 / 测试环境,生产部署时网关 URL 可能不同(通过 `LLM_BASE_URL` env 覆盖)
