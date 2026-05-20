# LLM 网关集成调试决策树

> **Purpose**: 接入 LLM 网关时遇到"模型不返回"/"streaming parser 错误"类问题,**先验证网关本身,再怀疑 SDK 配置**(尤其 baseUrl 后缀)。错误根因常常被表面症状误导。

---

## When to Use

- 接入新的 LLM 网关(自部署 / 第三方代理 / 多协议聚合)首次跑通时
- `pi-ai streamSimple` / `complete` 报形如:
  - `Incomplete JSON segment at the end`
  - `Stream ended without finish_reason`
  - done event 触发但 `message.content` 为空 / 找不到 text 块
  - 401 / 404 / 502 等 HTTP 错误
- 流式响应"看起来收到了但内容是空字符串"

---

## 错误诊断决策树

```
报错出现
   │
   ▼
[Step 1] 直接 curl 网关 endpoint(非流式 + 非走 SDK)
   │
   ├─ 拿到正常 JSON 响应 ───→ ✅ 网关本身正常,问题在 SDK 配置(走 Step 2)
   │
   └─ 报 404 / 401 / 502 / 错误页 ───→ 问题在网关侧(走 Step 5)

[Step 2] 检查 baseUrl 后缀是否与 SDK 预期一致
   │
   ├─ openai-completions / openai-responses ───→ baseURL 必须含 /v1
   ├─ anthropic-messages ───→ baseURL 不带 /v1(SDK 内部拼 /v1/messages)
   └─ google-generative-ai ───→ baseURL 必须含 /v1beta(SDK 不再追加 apiVersion)

[Step 3] 抓包/打印实际请求 URL,对比 Step 1 的 curl URL
   │
   ├─ URL 不一致 ───→ 调整 baseUrl 策略
   └─ URL 一致 ───→ 走 Step 4

[Step 4] 对比 curl 响应 vs SDK 期望 SSE 格式
   │
   ├─ 网关流式响应 SSE chunk 边界 / finish_reason 缺失 ───→ 真的是 SDK 兼容性
   └─ 网关响应正常但 SDK 解析空 ───→ 检查 stream event 类型(done.message.content 可能没文本块,可能在别的 event)

[Step 5] 网关侧问题
   │
   ├─ 401 ───→ 鉴权头 / API key 错
   ├─ 404 ───→ 端点路径错(常常就是 baseUrl 后缀问题)
   ├─ 502 / 504 ───→ 网关上游模型超时
   └─ 错误页 HTML / 非 JSON ───→ 网关侧路由错位
```

---

## 关键 SDK baseURL 预期速查

> 源码定位(`node_modules/@earendil-works/pi-ai/dist/providers/`):

| 协议 `api` | baseURL 期望 | 源码定位 |
|---|---|---|
| `openai-completions` | 含 `/v1`(SDK 拼 `${baseURL}/chat/completions`) | `openai-completions.js:385` |
| `openai-responses` | 含 `/v1`(SDK 拼 `${baseURL}/responses`) | `openai-responses.js:168` |
| `anthropic-messages` | 不带 `/v1`(SDK 内部拼 `/v1/messages`) | `node_modules/@anthropic-ai/sdk/client.d.ts:126` |
| `google-generative-ai` | 含 `/v1beta`(`apiVersion = ""` 不再追加) | `google.js:247-249` |

---

## curl 验证模板

```bash
# 假设 LLM_API_KEY 已 export
KEY=$LLM_API_KEY

# openai-completions(典型路径 /v1/chat/completions)
curl -sS -X POST https://your-gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","messages":[{"role":"user","content":"hi"}],"stream":false}'

# openai-responses(典型路径 /v1/responses)
curl -sS -X POST https://your-gateway.example.com/v1/responses \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","input":"hi","stream":false}'

# google-generative-ai(典型路径 /v1beta/models/{model}:generateContent)
curl -sS -X POST "https://your-gateway.example.com/v1beta/models/your-model:generateContent" \
  -H "x-goog-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'

# anthropic-messages(典型路径 /v1/messages,SDK 默认 root URL)
curl -sS -X POST https://your-gateway.example.com/v1/messages \
  -H "Authorization: Bearer $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

拿到 200 + 正常 JSON 即证明网关本身 OK,问题在 SDK 配置。

---

## 真实案例(flower-providers 接通 jp-ai.havefun.eu.cc)

**症状**:smoke 测试时 4 个 provider 全部失败:
- `havefun-gemini` → `Incomplete JSON segment at the end`
- `havefun-openai-responses` → done event 触发但 `message.content` 找不到 text
- `havefun-openai` → `Stream ended without finish_reason`

**误判**:第一反应是 pi-ai streaming parser 与该网关 SSE 格式不兼容,准备写一个兼容层。

**正解**(用户洞见):"我看日志你根本没有请求过,是不是问题出在了 baseurl 上,他是不是会默认加一些后缀?"

**根因**:`LLM_BASE_URL` 直接传根 URL 给 4 个 SDK,但每个 SDK 对 `baseURL` 的预期不同 → 请求实际打到了缺后缀的错误路径 → 网关返回错误页 / 非 JSON / 缺字段 → SDK parser 报"streaming 错误"。

**修复**:`flower-providers` 内部 `PROVIDER_PATH_SUFFIX` + `resolveProviderBaseUrl(provider)` 按 provider 自动拼后缀。修后 5/5 全过。

**教训**:
1. "Streaming parser 错误"是表象,**根因经常在请求阶段**(路径错位 / 鉴权错 / 端点不存在),不要被症状误导
2. **第一步永远是 curl 直接验证网关**,排除网关本身和路径问题,再怀疑 SDK
3. 多协议聚合网关接入时,**为每个 SDK 准备正确的 baseURL 后缀**是必修课

---

## 真实案例(pi-ai anthropic.js:544 过时注释 vs Anthropic 官方文档)

**症状**:接 thinking effort 抽象时,想给 Claude Opus 4.7 拿到 anthropic 实际最高的 `effort: "max"`,但翻 pi-ai 源码 `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js:544` 看到一行注释 "max only Opus 4.6",于是怀疑 Opus 4.7 不支持 max。

**误判**:第一反应是"pi-ai 已经记录了这条规则,Opus 4.7 大概只能拿到 high",准备给项目代码加"按 model id 区分是否发 max"的特判分支。

**根因**:翻 Anthropic 官方 [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) + [What's new in Opus 4.7](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7),发现 Opus 4.7 文档原话:effort 范围 `low / medium / high / xhigh / max`,且 "xhigh sits between high and max",**官方明确说最高是 max**。pi-ai 注释是 Opus 4.6 时代留下的、没跟上 4.7 发布;**中间层 SDK 的代码注释不是事实依据,过时风险高**。

**修复**:不要给上层项目加 "model id → 是否支持 max" 的特判;改用 pi-ai 暴露的 `ThinkingLevelMap` 显式声明 `{ xhigh: "max", ... }`,把 pi 统一的 `xhigh` 映射到 anthropic 实际的 `"max"`。这样上层只需调 `LLM_REASONING_EFFORT=xhigh`,无需感知 model 差异。

**教训**:
1. **官方文档 > 中间层 SDK 代码注释**:当两者冲突时,以官方为准;SDK 注释经常滞后于上游模型版本迭代
2. **"中间层告诉我不支持" 不是结论**:验证流程必须包含官方文档对照;如果有 API 访问权,curl 实测一次成本更低
3. **绕开中间层的方式是声明式映射,不是特判分支**:用 `ThinkingLevelMap`(配置)而非 `if (modelId === ...)`(代码),后者会在每接入新 model 时膨胀

## 真实案例(pi-coding-agent print 模式被默认 provider 抢占)

**症状**:flower-code-reviewer e2e 真跑时报 `No API key found for azure-openai-responses`,即使 env 已配 `LLM_PROVIDER=havefun-openai-responses` + `LLM_MODEL=gpt-5.5`,且 extension 已 `pi.registerProvider("havefun-openai-responses", ...)`。

**误判轨迹**:
1. 第一反应:LLM 网关问题 → curl `https://jp-ai.havefun.eu.cc/v1/responses` 验证,200 正常
2. 第二反应:flower-providers 注册失败 → 看 register.ts 代码,逻辑没问题
3. 第三反应:argv 没传 `--model` → 加 `--model gpt-5.5`,**仍报同样错**
4. 第四反应:argv 形式应为 `--model provider/model` → 改成 `--model havefun-openai-responses/gpt-5.5`,**还是报错**

**根因**:`~/.pi/agent/settings.json` 有 `defaultProvider: "openai"` + `defaultModel: "gpt-5.5"`,pi 内置 `openai` provider 又把 `gpt-5.5` 路由到 `azure-openai-responses` 协议;**没有显式 `--provider` 时,pi 用 settings 默认 + 内置 modelRegistry 解析**,我们注册的 `havefun-openai-responses` 同名 model 被"挤掉"。

**修复**:`buildPiCliArgs` 同时输出 `--provider <name>` 和 `--model <id>` 两个独立 flag,显式覆盖 settings.json 的 default。修后链路立即跑通。

**教训**:
1. **pi CLI 的 model 解析受 `~/.pi/agent/settings.json` 影响**:同名 model id + 默认 provider 会"抢"我们的 extension 注册结果;CLI 形态务必同时显式传 `--provider` + `--model`
2. **错误信息中的 provider 名(如 `azure-openai-responses`)是 pi 解析到的最终 model.provider,不是我们 env 配的 provider**:看到陌生 provider 名时,**第一步是 dump 实际传给 pi 的 argv**,验证是否真的传了 `--provider`,不要假设
3. **加 debug 日志的成本极低**:在 `await piMain(piArgv, ...)` 前 `console.error("piArgv:", JSON.stringify(piArgv))`,5 分钟解决 30 分钟的猜测
4. **buildPiCliArgs 单测覆盖应该有"PROVIDER + MODEL 都配 → argv 含 --provider 和 --model"的 case**:本任务最初遗漏 `--provider` 是因为单测当时只覆盖了 `--model` 路径

## Related Specs

- [flower-providers/backend/error-handling.md](../flower-providers/backend/error-handling.md) — Common Mistakes 章节有具体修复模板
- [flower-providers/backend/index.md](../flower-providers/backend/index.md) — 关键设计点 #5 / #7(buildPiCliArgs 对称接口)
