# Error Handling

> 启动期错误处理。

---

## Overview

本包的所有错误都在**启动期**(`registerHavefunProviders` / `getDefaultModel` / `buildHavefunModel` 首次调用时)发生。
策略是 **fail-fast**:有问题立刻退出,绝不带病运行。

---

## Error Types

不定义自定义错误类,统一用 JavaScript 内置 `Error`。错误消息全部中文,指明具体变量名 + 给出可选值。

---

## Fail-fast 矩阵

| 触发条件 | 触发位置 | 错误信息(摘要) |
|---|---|---|
| `LLM_BASE_URL` 缺失或空字符串 | `env.ts:getLLMBaseUrl` | `LLM_BASE_URL 未配置:请在环境变量中设置 LLM 网关的 baseUrl` |
| `LLM_API_KEY` 缺失或空字符串 | `env.ts:getLLMApiKeyEnvName` | `LLM_API_KEY 未配置:请在环境变量中设置 LLM 网关的 API key` |
| `LLM_PROVIDER` 缺失 | `env.ts:getLLMProvider` | `LLM_PROVIDER 未配置:合法值:havefun-openai / havefun-anthropic / ...` |
| `LLM_PROVIDER` 非法值 | `env.ts:getLLMProvider` | `LLM_PROVIDER 非法值 "<x>":合法值:...` |
| `LLM_MODEL` 缺失 | `env.ts:getLLMModel` | `LLM_MODEL 未配置:请在环境变量中设置默认模型 id` |
| `LLM_MODEL` 不在合并清单 | `runtime.ts:getDefaultModel / buildHavefunModel` | `LLM_MODEL "<x>" 不在合并模型清单中。可选模型 id:[...]` |
| `LLM_MODEL` 与 `LLM_PROVIDER` 协议不匹配 | `runtime.ts:getDefaultModel / buildHavefunModel` | `LLM_MODEL "<x>" 的原生协议为 "<api>",与 LLM_PROVIDER 对应的 "<api>" 不一致` |
| `LLM_EXTRA_MODELS_JSON` JSON.parse 失败 | `env.ts:getExtraModels` | `LLM_EXTRA_MODELS_JSON 解析失败:<原始 message>` |
| `LLM_EXTRA_MODELS_JSON` 不是数组 | `env.ts:getExtraModels` | `LLM_EXTRA_MODELS_JSON 必须是数组结构` |
| `LLM_EXTRA_MODELS_JSON[i]` 缺 `id` / `nativeApi` | `env.ts:getExtraModels` | `LLM_EXTRA_MODELS_JSON[i].id / nativeApi 必填` |
| `LLM_EXTRA_MODELS_JSON[i].nativeApi` 非法值 | `env.ts:getExtraModels` | `nativeApi 非法值 "<x>":合法值:openai-completions / ...` |
| `options.appSource` 为空字符串 | `register.ts:registerHavefunProviders` | `registerHavefunProviders:options.appSource 必填(非空字符串)` |

约定:

1. **每个缺失变量单独 throw**,错误信息含具体变量名 + 给出修复指引
2. **顺序检查**(先 baseUrl 再 apiKey 再 provider/model),便于用户按提示一步步配
3. **不 fallback**(无默认 URL、无空 apiKey、无默认模型)
4. **不打印 apiKey 任何片段**(连 message 模板都不允许嵌入)

---

## `pi.registerProvider` 本身失败

pi 上游的 `registerProvider` 在重复注册同名 provider 时会**静默覆盖**(根据 pi 0.75 行为),不抛错。
本包对 4 个 provider **一次性顺序注册**,不在意覆盖语义(同一 caller 多次调用是反模式)。

如果未来需要严格检查"是否已注册",在 `registerHavefunProviders` 入口加幂等检测(当前 pi 未必有这个 API,先不做)。

---

## API Error Responses

不适用(本包无 API 层)。

---

## Common Mistakes

- ❌ 缺凭证时 `console.warn` 后继续(pi 后续会拿不到 model 而崩,错误源被掩盖)
- ❌ 把 `LLM_API_KEY` 缺失当作"可选"(凭证必填,无默认)
- ❌ 多次调用 `registerHavefunProviders(pi, ...)` 注册同一组 provider(会覆盖前一次注册,且 `appSource` header 串味;每个 caller 只调一次)
- ❌ 在 `getDefaultModel` 内退化到"默认 anthropic + 默认 claude-opus"(策略函数应**总是** fail-fast,让运维知道配错了)
- ❌ 错误信息嵌入 `process.env.LLM_API_KEY` 片段(任何长度任何形式都禁止)

### ❌ 把 `LLM_BASE_URL` 当 4 个 provider 共用的完整 baseUrl 直接透传

**Symptom**:smoke 测试时多个 provider 报形如:
- `Stream ended without finish_reason`(openai-completions 路径)
- `Incomplete JSON segment at the end`(google-generative-ai 路径)
- done event 触发但 `message.content` 为空(openai-responses 路径)

表面像 pi-ai streaming parser 与网关不兼容,**实际是路径错位** — 请求打到了网关不识别的 URL,网关返回错误页,被 parser 当成坏 SSE。

**Cause**:pi-ai 4 个 LLM provider 各自把 `model.baseUrl` 透传给底层 SDK,但各家 SDK 对 `baseURL` 的预期不同:

| 协议 | SDK 预期 | 来源 |
|---|---|---|
| openai-completions / openai-responses | baseURL 含 `/v1`(SDK 拼 `${baseURL}/chat/completions`) | `node_modules/.../pi-ai/dist/providers/openai-completions.js:385` |
| anthropic-messages | baseURL 不带 `/v1`(SDK 默认 `https://api.anthropic.com`,内部拼 `/v1/messages`) | `node_modules/@anthropic-ai/sdk/client.d.ts:126` |
| google-generative-ai | baseURL 含 `/v1beta`(`apiVersion = ""` 不再追加) | `node_modules/.../pi-ai/dist/providers/google.js:247-249` |

**Fix**:`LLM_BASE_URL` 是**网关根 URL**,本包 `catalog.ts:PROVIDER_PATH_SUFFIX` + `env.ts:resolveProviderBaseUrl(provider)` 按 provider 自动拼正确后缀。`register.ts` / `runtime.ts:buildHavefunModel` 必须用 `resolveProviderBaseUrl(provider)`,不要直接用 `getLLMBaseUrl()`。

**Prevention**:
1. 文档(`README.md` + `.env.example`)显式提示"`LLM_BASE_URL` 必须是根 URL,不带 `/v1` 等后缀"
2. 遇到 "streaming parser 错误" 类报错时,**第一步** `curl` 直接 POST 网关 chat endpoint 验证网关本身正常,排除路径错位
3. 完整诊断流程见 [`guides/debugging-llm-integration.md`](../../guides/debugging-llm-integration.md)
