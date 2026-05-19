# AC7 端到端验证 — 根因 + 修复记录

> 时间:2026-05-19
> 状态:✅ **5/5 case 全过**(Claude / Gemini / GPT-5.5 / GPT-5.4 / Grok)

## 一句话结论

最初观察到的"streaming parser 多处失败" **不是 pi-ai 上游 bug**,而是 `flower-providers` 把根 URL 直接当 `baseUrl` 传给 4 个 SDK,而 SDK 各自对 `baseURL` 后缀的预期不同,导致请求打到 404 / 错误路径,响应当然解析失败。

## 直接 curl 网关:全部正常

3 个协议**非流式**直接 curl,4 类模型都拿到真实文本:

| 协议 | endpoint | 模型 | 结果 |
|---|---|---|---|
| openai-responses | `POST /v1/responses` | `gpt-5.5` | ✅ "我是一个由 OpenAI 训练的 AI 助手…" |
| openai-completions | `POST /v1/chat/completions` | `grok-4.20-fast` | ✅ "Hi! 👋 What's up?…",有 `finish_reason: "stop"` |
| gemini | `POST /v1beta/models/gemini-2.5-flash:generateContent` | `gemini-2.5-flash` | ✅ "Hello! I'm Antigravity…" |

**结论:网关本身 100% 正常**。

## 第一轮 smoke 错误现象(修前)

| Case | 报错 |
|---|---|
| `havefun-gemini` / gemini-2.5-flash | `Incomplete JSON segment at the end` |
| `havefun-openai-responses` / gpt-5.5 | done event 触发但 `done.message.content` 没 text |
| `havefun-openai-responses` / gpt-5.4 | 同上 |
| `havefun-openai` / grok-4.20-fast | `Stream ended without finish_reason` |

## 根因(用户指出)

> "我看日志你根本没有请求过,是不是问题出在了 baseurl 上,他是不是会默认加一些后缀?"

确实如此。pi-ai 4 个 provider 对 `baseUrl` 后缀的预期:

| provider | pi-ai 实现位置 | baseUrl 预期 |
|---|---|---|
| openai-completions | `providers/openai-completions.js:385` → `new OpenAI({ baseURL: model.baseUrl })` | 必须含 `/v1`(OpenAI SDK 拼 `${baseURL}/chat/completions`) |
| openai-responses | `providers/openai-responses.js:168` → 同上 | 必须含 `/v1` |
| anthropic-messages | `providers/anthropic.js:622-625` → `new Anthropic({ baseURL: model.baseUrl })` | **不**含 `/v1`(Anthropic SDK 内部拼 `${baseURL}/v1/messages`) |
| google-generative-ai | `providers/google.js:247-249` → `httpOptions.baseUrl = model.baseUrl; apiVersion = ""` | 必须含 `/v1beta`(注释明说 "baseUrl already includes version path, don't append") |

我们传的是根 URL `https://jp-ai.havefun.eu.cc`,所以:
- openai-* 实际打 `https://.../chat/completions` → 网关 404 / 路径错 → 响应不是标准 SSE → parser 报"Stream ended without finish_reason"
- gemini 实际打 `https://.../models/...:streamGenerateContent` → 缺 `/v1beta` → 网关返回错误页 → "Incomplete JSON segment"
- openai-responses 类似,响应被网关重定向/错误处理后无标准 `output_text`,所以 done event 的 content 为空

## 修复(本次提交)

新增 `PROVIDER_PATH_SUFFIX` 常量与 `resolveProviderBaseUrl(provider)` 函数。每个 provider 注入到 pi 时,baseUrl = `getLLMBaseUrl() + PROVIDER_PATH_SUFFIX[provider]`。

文件改动:
- `packages/flower-providers/src/catalog.ts` — 加 `PROVIDER_PATH_SUFFIX` 常量
- `packages/flower-providers/src/env.ts` — `getLLMBaseUrl` 加 trailing slash 规范化;新增 `resolveProviderBaseUrl(provider)`
- `packages/flower-providers/src/register.ts` — 改用 `resolveProviderBaseUrl(providerName)`
- `packages/flower-providers/src/runtime.ts` — `buildHavefunModel` 改用 `resolveProviderBaseUrl(provider)`
- `packages/flower-providers/src/__tests__/register.test.ts` — "baseUrl 来自 env" 测试改为按 provider 断言不同后缀;新增"尾部斜杠规范化"测试
- `packages/flower-providers/README.md` — `LLM_BASE_URL` 字段说明加"必须是根 URL,不带后缀"
- `.env.example` — `LLM_BASE_URL` 注释 + 示例去掉 `/v1`

## 第二轮 smoke(修后)

```
=== Claude Opus (havefun-anthropic / claude-opus-4-7) ===
  ✓ 我是 Claude Code,Anthropic 推出的命令行 AI 编程助手。

=== Gemini Flash (havefun-gemini / gemini-2.5-flash) ===
  ✓ 我是由 Google DeepMind 开发的 AI 编程助手 Antigravity。

=== GPT-5.5 (response) (havefun-openai-responses / gpt-5.5) ===
  ✓ 我是一个帮助解答问题和编程的 AI 助手。

=== GPT-5.4 (response) (havefun-openai-responses / gpt-5.4) ===
  ✓ 我是一个擅长解答问题的智能助手。

=== Grok 4.20 (openai extras) (havefun-openai / grok-4.20-fast) ===
  ✓ 我是 Grok,由 xAI 构建的 AI 助手。

[smoke] AC7 完成:全部 provider 拿到真实响应。
```

**AC7 ✅ 真正达成**。
