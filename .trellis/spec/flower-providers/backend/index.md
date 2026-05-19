# Backend Development Guidelines

> `@flower-ai/flower-providers` 的内部实现层规范。

---

## Overview

`flower-providers` 是 pi 扩展库,**共 5 个源文件**(`env.ts` / `catalog.ts` / `register.ts` / `runtime.ts` + `index.ts`)。
没有真正意义的"后端实现层"(无 IO、无存储、无业务逻辑)。

本目录(`backend/`)用于:

- 记录模块边界 / 错误处理矩阵 / 日志约束
- 记录 LLM 调用栈的错误处理 / 日志约定(虽然本包不直接发起调用)

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 5 文件布局,未来拆分边界 |
| [Database Guidelines](./database-guidelines.md) | 不适用 |
| [Error Handling](./error-handling.md) | fail-fast 启动期检查矩阵、provider 注册失败语义 |
| [Logging Guidelines](./logging-guidelines.md) | 不打 apiKey / baseUrl |
| [Quality Guidelines](./quality-guidelines.md) | 与 frontend/ 共用 |

---

## 关键设计点

1. **本包是初始化代码**,只跑一次,无运行时分支(`getDefaultModel` / `buildHavefunModel` 也都是纯函数,虽然可以多次调,但本身无状态)
2. **fail-fast 是核心策略**:缺凭证 / 缺 `LLM_PROVIDER` / `LLM_MODEL` / 协议不匹配 立刻退出
3. **`BUILTIN_MODELS` 是配置而非数据**:通过代码 PR 修改;运维侧通过 `LLM_EXTRA_MODELS_JSON` env 动态扩展
4. **`appSource` 仅是 header 标签**:不参与模型选择 / 路由,模型选择由部署单元的 env 决定
5. **`LLM_BASE_URL` 是网关根 URL**:用户 env 只配根 URL(如 `https://jp-ai.havefun.eu.cc`),本包 `catalog.ts:PROVIDER_PATH_SUFFIX` + `env.ts:resolveProviderBaseUrl(provider)` 自动按 provider 拼正确后缀(openai-* → `/v1`,gemini → `/v1beta`,anthropic 无后缀)。**不要在 `register.ts` / `runtime.ts` 内直接用 `getLLMBaseUrl()` 给 model 赋值** — 必须经 `resolveProviderBaseUrl(provider)`。详见 [error-handling Common Mistakes](./error-handling.md#-把-llm_base_url-当-4-个-provider-共用的完整-baseurl-直接透传)
6. **reasoning effort 由 env + per-model 默认决定**:`runtime.ts:getDefaultReasoningEffort(modelId?)` 是公开 API,优先级 env (`LLM_REASONING_EFFORT`) > per-model 默认 > 全局 fallback `"high"`。仅 ops-bot 形态的 streamFn 调用;code-reviewer 由 pi CLI 自己管 thinking level(`/thinking` 命令)。pi 的 `ThinkingLevel` 只有 5 级无 `max`,对 Anthropic Opus 4.7 这种实际最高是 `"max"` 的 model,在 `catalog.ts:BUILTIN_MODELS` 中显式声明 `thinkingLevelMap: { xhigh: "max", ... }` 把 pi 最高映射到 anthropic 实际最高。

> **Warning**:网关 `/v1/models` 返回的 `supported_endpoint_types` 字段**可能漏报**(实测 `gpt-5.5` 漏报对 `openai-response` 协议的支持)。`BUILTIN_MODELS.nativeApi` **以人工知识为准**,不机械跟随网关返回值。如果新增模型把握不准协议支持,先 `curl` 网关对应 endpoint(`POST /v1/responses` / `POST /v1beta/models/{model}:generateContent` 等)实测,再写入 `nativeApi`。
