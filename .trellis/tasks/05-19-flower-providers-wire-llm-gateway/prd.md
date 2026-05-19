# flower-providers 接通目标 LLM 网关

## Goal

把 `@flower-ai/flower-providers` 从"骨架 + 占位"状态推进到**真实可用的统一 LLM 入口**:
两个产品(`code-reviewer` / `ops-bot`)的 LLM 调用都通过本包获取 provider 与 model 配置,
任何网关 URL / 模型清单 / 鉴权 / header 的变更**只改这一处**。

完成本任务后,第 1 周"基础设施"路线图中的"flower-providers 接通目标 LLM 网关"待办关闭。

## Background / Known Context

### 已知事实(来自代码/spec/README)

- 包形态:pi 扩展库,单文件 `src/index.ts`,目前公开两个函数:
  - `registerHavefunProviders(pi: ExtensionAPI, { appSource })` — 调 `pi.registerProvider` 注册名为 "company" 的 provider
  - `getDefaultModelId(appSource: string)` — 返回默认 model id
- 模型清单 `CUSTOM_MODELS` 是占位:id (`company-gpt-4` / `company-gpt-4-mini`)、cost 全 0、contextWindow 凭直觉填的
- 环境变量约定(`.env.example`):`LLM_BASE_URL`、`LLM_API_KEY` 已定义
- spec 强约束:
  - `frontend/`:fail-fast 检查环境变量,不打印 apiKey,`appSource` 必填不给默认值
  - `backend/`:本包是初始化代码,只跑一次,无运行时分支

### 已发现的 bug / 缺陷

1. ~~**apiKey 传错**:`src/index.ts:61` 写的是 `apiKey: "LLM_API_KEY"`(字符串字面量),不是 `apiKey` 变量~~ ❌ **误判 — 见 ADR-3**:pi 的 `ProviderConfig.apiKey` 支持"raw key 或 env var name",传字符串字面量是 pi 推荐用法
2. **`ops-bot` 完全旁路了本包**:
   - `packages/flower-ops-bot/src/agent-factory.ts:84` 自己 hard-code 了一个 Model 对象传给 `pi-agent-core` 的 `Agent`
   - 自己读 `process.env.LLM_BASE_URL` / `LLM_API_KEY`
   - 与 `code-reviewer` 走的 `pi.registerProvider` 路径完全脱钩
3. **两套注册表的差异未在 README/spec 反映**:
   - `pi-coding-agent` 的 `pi.registerProvider` 是 pi-coding-agent 内部 `model-registry` 的写入,只对 CLI 形态生效
   - `pi-agent-core` 的 `Agent({ initialState: { model } })` 需要的是 `pi-ai` `getModel(...)` 返回的 `Model` 对象,与上一个 registry 不连通
   - 所以"统一入口"必须同时覆盖这两条路径

### 唯一现有下游

- `packages/flower-code-reviewer/src/extension.ts:20` — `registerHavefunProviders(pi, { appSource: "code-reviewer" })`
- `packages/flower-ops-bot/src/agent-factory.ts` — 目前未引用本包(待统一)

## Assumptions (temporary)

- 真实 LLM 网关是 **OpenAI-compatible 端点**(`api: "openai-completions"`),不是 Anthropic/Google 原生协议 — 与现有代码和 README 描述一致
- 默认鉴权头是 `Authorization: Bearer <LLM_API_KEY>`(README TODO 提到"非标头需要调 authHeader")
- 模型清单**先支持 1–2 个真实模型**即可,不追求覆盖网关全部模型
- 目前**没有**接入真实网关 / 没有真实模型 id 与计费数据 — 需要在 PRD 中决定如何处理"未知真实数据"

## Open Questions (blocking / preference)

1. ~~**scope 是否包含 ops-bot 的统一接入?**~~ ✅ 已定:**包含**(方案 B,见 ADR-1)
2. ~~**真实模型清单从哪里来?**~~ ✅ 已定:开发网关 `https://jp-ai.havefun.eu.cc` + 预设 8 模型 + env JSON 扩展(见 ADR-4)
3. ~~**模型选择如何动态化?**~~ ✅ 已定:`LLM_PROVIDER` + `LLM_MODEL` 两个 env,fail-fast(见 ADR-5)
4. **OAuth / 非标鉴权头**:本任务**不做**,留作后续(见 Out of Scope)

## Decisions (ADR-lite)

### ADR-1:scope 包含 ops-bot 的统一接入

- **Context**:README 原则是"两个产品都通过 flower-providers 接入 LLM 网关",但 `ops-bot/src/agent-factory.ts:84` 当前完全旁路本包,自己 hard-code Model 并自己读 env。`pi-coding-agent.registerProvider` 与 `pi-agent-core` 的 `Agent({ model })` 是两条不连通的路径,所以"统一"需要本包同时覆盖两种形态。
- **Decision**:本任务一次性把 ops-bot 也纳入统一入口。在 `flower-providers` 新增导出 `buildHavefunModel(modelId)`,返回 `pi-ai.Model` 对象;`ops-bot/agent-factory.ts:pickModel()` 改为调用本函数。
- **Consequences**:
  - 优:LLM 配置真正只在一处;第 4-5 周 ops-bot MVP 时基础设施已就位,无需回头返工
  - 劣:本任务需要碰 `ops-bot` 代码(但只改 `pickModel` 一个函数);多出一个公开 API,需要补对应 spec / 测试

### ADR-2:本任务接入网关全部 4 个 LLM 协议

- **Context**:目标网关是多协议聚合(`openai` / `openai-response` / `anthropic` / `gemini`),同一模型可经多种协议访问。不同协议在 thinking / reasoning / tool calling 语义上有差异:Claude 走 anthropic 协议能拿到原生 thinking,GPT-5.x codex 走 openai-response 能拿到 reasoning summary。
- **Decision**:`flower-providers` 注册 4 个 provider:
  - `havefun-openai`(`api: "openai-completions"`)— 兜底,挂网关全部 chat 模型
  - `havefun-openai-responses`(`api: "openai-responses"`)— GPT-5.x codex 系列原生协议
  - `havefun-anthropic`(`api: "anthropic"`)— Claude 系列原生协议(支持 thinking)
  - `havefun-gemini`(`api: "google"`)— Gemini 系列原生协议
- **Consequences**:
  - 优:网关全部能力都可调用;每个模型家族都能走原生协议,不损失能力
  - 劣:工作量 ≈ 方案 B 的 1.5×;需要核实 pi-ai 对 `anthropic` / `google` 协议是否允许自定义 baseUrl(因为 Anthropic / Gemini 原生 SDK 通常假定官方端点);如果 pi-ai 上游不支持自定义 baseUrl,这条 ADR 需要降级到方案 B(详见 design.md)
- **Risk gate (✅ 通过)**:已验证 pi-ai 的 4 个 LLM provider 全部支持把 baseUrl 指向自定义网关:
  - `anthropic.js:622-625` → `new Anthropic({ apiKey: null, baseURL: model.baseUrl, ... })`
  - `google.js:247-249` → `httpOptions.baseUrl = model.baseUrl; httpOptions.apiVersion = "";`
  - `openai-completions.js:385` / `openai-responses` → `new OpenAI({ baseURL: model.baseUrl })`
- **pi-ai 中 4 个协议的正式 `api` 字段**(注意命名差异):
  - 网关 `openai` → pi-ai `"openai-completions"`
  - 网关 `openai-response` → pi-ai `"openai-responses"`
  - 网关 `anthropic` → pi-ai **`"anthropic-messages"`**(不是 `"anthropic"`)
  - 网关 `gemini` → pi-ai **`"google-generative-ai"`**(不是 `"gemini"` 或 `"google"`)

### ADR-3:`apiKey` 字段的语义沿用 pi 上游约定

- **Context**:`ProviderConfig.apiKey` 文档明确说"API key **or environment variable name**"。现有 `index.ts:61` 写 `apiKey: "LLM_API_KEY"` **不是 bug** — pi 会自动从 `process.env.LLM_API_KEY` 读取。
- **Decision**:保留"传 env 变量名"的写法,这是 pi 推荐用法(避免内存里出现明文 key);但要在 spec 里明确文档化这个语义,避免后人误改。
- **Consequences**:
  - 优:符合 pi 约定;apiKey 不会经过我们代码层(直接由 pi 内部 resolve)
  - 劣:之前 brainstorm 误判为 bug,需要修正 PRD 中"已发现 bug"一节

### ADR-4:模型清单 = "代码预设 8 模型 + env JSON 扩展"

- **Context**:网关有 80+ chat 模型;不必全注册。需要在"启动期零依赖 / 类型安全 / cost 元数据准确"和"运维不用 PR 加模型"之间取平衡。
- **Decision**:
  - 代码常量 `BUILTIN_MODELS`(8 个,含真实 cost / contextWindow / supported_protocols 元数据)
  - env `LLM_EXTRA_MODELS_JSON` 注入额外模型(JSON 数组,格式 = pi 的 `ProviderModelConfig`),启动时与 `BUILTIN_MODELS` 合并,id 重复以 env 为准
  - 注册时:4 个 provider(`havefun-openai` / `havefun-openai-responses` / `havefun-anthropic` / `havefun-gemini`)各自从合并清单里过滤"自己协议支持的模型"注册
- **预设 8 模型清单**(每模型只注册原生 provider,见 ADR-6;以人工经验为准,网关 `supported_endpoint_types` 仅参考):
  | id | nativeApi | 注册到的 provider |
  |---|---|---|
  | `claude-opus-4-7` | anthropic-messages | havefun-anthropic |
  | `claude-sonnet-4-6` | anthropic-messages | havefun-anthropic |
  | `claude-haiku-4-5-20251001` | anthropic-messages | havefun-anthropic |
  | `gemini-2.5-pro` | google-generative-ai | havefun-gemini |
  | `gemini-2.5-flash` | google-generative-ai | havefun-gemini |
  | `gemini-2.5-flash-lite` | google-generative-ai | havefun-gemini |
  | `gpt-5.4` | openai-responses | havefun-openai-responses |
  | `gpt-5.5` | openai-responses | havefun-openai-responses(注:网关 `/v1/models` 漏报该模型对 response 的支持,以人工知识为准) |
- **`havefun-openai`(openai-completions)provider 预设无模型**,作为兜底接口供 `LLM_EXTRA_MODELS_JSON` 注入只支持 openai-completions 的模型(如 grok / qwen / glm 等)
- **Consequences**:
  - 优:启动零外部依赖;cost 元数据可手维护;ops 可通过 env 加新模型不改代码;每模型只注册 1 处,矩阵简单
  - 劣:cost 数据需要手动同步真实计费(初版可以全填 0,后续接计费再补);`havefun-openai` provider 默认为空,需要在文档中明确"它是 extras 兜底口"

### ADR-6:每个模型只注册到"原生协议" provider(不按 supported_endpoint_types 并集多处注册)

- **Context**:网关同一模型多协议可访问,但不同协议有语义差异:
  - Claude 走 `anthropic-messages` 拿到原生 thinking + 完整 tool calling 语义
  - Gemini 走 `google-generative-ai` 拿到原生 thinking budget + 多模态
  - GPT-5.x codex 走 `openai-responses` 拿到 reasoning summary + service tier
  - 走 `openai-completions` 会把所有模型降级到最小公约数,失去家族特性
- **Decision**:每个模型在 `BUILTIN_MODELS` 中**只声明一个 `nativeApi`**,只注册到对应的 1 个 provider:
  - Claude 家族 → `anthropic-messages` → `havefun-anthropic`
  - Gemini 家族 → `google-generative-ai` → `havefun-gemini`
  - GPT-5.x 家族 → `openai-responses` → `havefun-openai-responses`
  - `havefun-openai`(openai-completions)主要承接 `LLM_EXTRA_MODELS_JSON` 注入的"只支持 openai-completions"模型(例如 grok / qwen / glm 等)
- **关于网关 `supported_endpoint_types` 的可信度**:网关 `/v1/models` 返回的协议支持矩阵在某些模型上存在漏报(如 `gpt-5.5` 漏报对 openai-response 的支持)。`BUILTIN_MODELS.nativeApi` **以人工知识为准**,不机械跟随网关返回值。
- **Consequences**:
  - 优:每个家族的原生能力完整保留;预设模型矩阵简单(N 模型 → N 注册,不是 N×4);LLM_PROVIDER 切换语义清晰("用哪个家族的协议")
  - 劣:同一模型不能跨 provider 调用(如想用 anthropic 协议调 Gemini 拿 openrouter 风格,本任务不支持);若用户在 `LLM_EXTRA_MODELS_JSON` 中显式指定 `nativeApi`,可以注入到任意 provider

### ADR-7:`LLM_BASE_URL` 是网关**根 URL**,本包按 provider 拼协议后缀

- **Context**(实施过程中发现):pi-ai 4 个 LLM provider 各自把 `model.baseUrl` 透传给底层 SDK(OpenAI / Anthropic / Google),但各家 SDK 对 `baseURL` 字段的预期不同:
  - **OpenAI SDK**(`api: "openai-completions"` / `"openai-responses"`):SDK 拼 `${baseURL}/chat/completions` 或 `${baseURL}/responses` — 要求 baseURL 含 `/v1`
  - **Anthropic SDK**(`api: "anthropic-messages"`):SDK 默认 baseURL = `https://api.anthropic.com`(根),内部拼 `/v1/messages` — 要求 baseURL **不**带 `/v1`
  - **Google Generative AI SDK**(`api: "google-generative-ai"`):pi-ai `google.js:247-249` 显式 `apiVersion = ""` 并要求 `baseUrl` 含 `/v1beta`(注释明说 "baseUrl already includes version path, don't append")
  - 如果 4 个 provider 共用同一个 baseUrl,要么用户每个协议各设一个 env(碎裂),要么本包统一拼后缀(KISS)
- **Decision**:
  - **用户 env**(`LLM_BASE_URL`)**只配根 URL**(如 `https://jp-ai.havefun.eu.cc`),不带任何协议后缀;`env.ts:getLLMBaseUrl` 自动去除尾部斜杠
  - **本包内部按 provider 自动拼后缀**:`catalog.ts:PROVIDER_PATH_SUFFIX = { "havefun-openai": "/v1", "havefun-openai-responses": "/v1", "havefun-anthropic": "", "havefun-gemini": "/v1beta" }`,由 `env.ts:resolveProviderBaseUrl(provider)` 暴露
  - `register.ts` 注册时 / `runtime.ts:buildHavefunModel` 构造 Model 时,均用 `resolveProviderBaseUrl(provider)` 替代旧的 `getLLMBaseUrl()` 直接传递
- **错位时的失败现象**(原 PRD 未预见,本任务实测发现):
  - 用户传根 URL → openai-completions 实际打 `https://.../chat/completions`(缺 `/v1`)→ 网关返回非标准响应 → pi-ai parser 报 `Stream ended without finish_reason`(误以为 streaming 兼容性)
  - gemini 实际打 `https://.../models/...:streamGenerateContent`(缺 `/v1beta`)→ 网关返回错误页 → parser 报 `Incomplete JSON segment at the end`
  - openai-responses 类似,响应被网关重定向后无标准 `output_text`,done event 的 content 为空
  - 表面看像 streaming parser 不兼容,真根因是路径错位 → 见 `research/ac7-streaming-compat.md` 完整诊断
- **Consequences**:
  - 优:用户只需要记 1 个 env(根 URL),不用记 4 套规则;后续加新 provider 只需在 `PROVIDER_PATH_SUFFIX` 加一条;每条规则有 SDK 源码定位可追溯
  - 劣:用户在 `.env.example` 里看到的示例 URL 不带 `/v1`,与他人项目惯例可能不同;需在 README + .env.example 显式提示"根 URL,不带后缀"
- **AC**:`register.test.ts` 新增 2 个 case(按 provider 断言不同后缀 + 尾部斜杠规范化);AC7 smoke 5/5 通过

### ADR-5:模型选择 = `LLM_PROVIDER` + `LLM_MODEL` 两个 env,fail-fast

- **Context**:两个产品独立部署、独立进程、独立 env(README 第 1 章);"按 appSource 分流"是上层关注,不属于 flower-providers。
- **Decision**:
  - 函数签名:`getDefaultModel(): { provider: ProviderName; modelId: string }`(**无参**)
  - 实现:读 `process.env.LLM_PROVIDER`(必须 ∈ `{havefun-openai, havefun-openai-responses, havefun-anthropic, havefun-gemini}`)+ `process.env.LLM_MODEL`(必须在该 provider 注册的模型清单里),任一缺失或不合法 → **fail-fast 抛错**
  - 删除旧 `getDefaultModelId(appSource: string)` 函数
  - `registerHavefunProviders(pi, { appSource })` 中的 `appSource` **保留**,仅用作 `X-App-Source` header(审计/计费),不再参与模型选择
- **新增 env**:`LLM_PROVIDER` / `LLM_MODEL` / `LLM_EXTRA_MODELS_JSON`(后者可选)
- **Consequences**:
  - 优:符合 KISS;每个部署单元(code-reviewer 容器 / ops-bot 容器)各自 env;flower-providers 无业务耦合
  - 劣:破坏性变更 — 现有 `getDefaultModelId` 调用方需要改(目前下游为零,只在 README 写到,影响面小);ops 必须配两个 env 才能启动(用 fail-fast 暴露问题比悄悄退化更好)

## Requirements

### R1:`flower-providers` 注册 4 个 provider

- 公开函数 `registerHavefunProviders(pi: ExtensionAPI, options: { appSource: string })` 调 `pi.registerProvider` 注册 4 个 provider:
  - `havefun-openai` → `api: "openai-completions"`
  - `havefun-openai-responses` → `api: "openai-responses"`
  - `havefun-anthropic` → `api: "anthropic-messages"`
  - `havefun-gemini` → `api: "google-generative-ai"`
- 每个 provider 的 `baseUrl` 取自 `process.env.LLM_BASE_URL`,缺失 fail-fast
- 每个 provider 的 `apiKey` 字段传字符串 `"LLM_API_KEY"`(由 pi 自己从 env resolve);本包代码**不直接接触 apiKey 值**
- 每个 provider 注入 `headers: { "X-App-Source": options.appSource }`,`appSource` 必填,缺失 fail-fast
- 每个 provider 的 `models` 取自合并清单(`BUILTIN_MODELS` + `LLM_EXTRA_MODELS_JSON`)中"`supported_protocols` 包含本 provider 协议"的子集

### R2:模型清单 = 8 预设 + env 扩展(每模型单一 nativeApi)

- 代码常量 `BUILTIN_MODELS`:8 个,见 ADR-4 表格,每条含 `id` / `contextWindow` / `maxTokens` / `cost`(初版全 0)/ `nativeApi`(单一 pi-ai `Api` 值)/ `reasoning` / `input` / `name`
- env `LLM_EXTRA_MODELS_JSON`(可选)注入额外模型,格式 = `BuiltinModelEntry`(必须含 `id` + `nativeApi`,其余字段缺失走默认值);id 重复时 env 覆盖 builtin
- JSON 解析失败 → fail-fast 抛错,错误信息明确指出"`LLM_EXTRA_MODELS_JSON` 解析失败"
- `nativeApi` 不在 4 个 `Api` 合法值内 → fail-fast,列出合法集

### R3:默认模型选择 `getDefaultModel()`(无参)

- 新公开函数:`getDefaultModel(): { provider: ProviderName; modelId: string }`
- 读 `process.env.LLM_PROVIDER` 与 `process.env.LLM_MODEL`,fail-fast 校验:
  - `LLM_PROVIDER` 必须 ∈ `{havefun-openai, havefun-openai-responses, havefun-anthropic, havefun-gemini}`
  - `LLM_MODEL` 必须能在合并清单中找到 + 该模型必须支持 `LLM_PROVIDER` 对应的协议
- 删除旧函数 `getDefaultModelId(appSource: string)`

### R4:新增 `buildHavefunModel(provider, modelId)` 给 pi-agent-core 形态使用

- 公开函数:`buildHavefunModel(provider: ProviderName, modelId: string): Model<Api>`
- 返回的 `Model` 对象直接可传给 `pi-agent-core` 的 `Agent({ initialState: { model } })`
- 内部从合并清单 + env 拼装出 `Model<Api>`,字段对齐 pi-ai 类型定义(`id` / `provider` / `api` / `baseUrl` / cost / contextWindow / maxTokens)
- 同样 fail-fast 校验 provider 与 modelId 合法

### R5:把 `ops-bot` 接入 flower-providers

- 改 `packages/flower-ops-bot/src/agent-factory.ts:pickModel()`:
  - 删除自己 hard-code 的 Model 对象与 `process.env.LLM_BASE_URL` 直读
  - 改为:`const { provider, modelId } = getDefaultModel(); return buildHavefunModel(provider, modelId);`
- `streamFn` 内部依然要传 `apiKey: process.env.LLM_API_KEY ?? ""`(pi-agent-core 的 streamSimple 走 pi-ai,需要 apiKey 来源)— 这一段保留,但建议加注释说明"和 flower-providers 用同一个 env"

### R6:更新文档与 spec(全面"company → havefun"扫荡)

> 涉及约 17 个文件。统一原则:**LLM 网关相关 "company" 必须改;docker image registry 占位 "yourcompany/*" 不动**(语义无关,见 Out of Scope)。

#### R6.1 — `packages/flower-providers/README.md`(重写)

- 新公开 API:`registerHavefunProviders` / `getDefaultModel` / `buildHavefunModel` / `ProviderName`(删旧 `registerCompanyProviders` / `getDefaultModelId`)
- 新 env:`LLM_PROVIDER` / `LLM_MODEL` / `LLM_EXTRA_MODELS_JSON`(原有 `LLM_BASE_URL` / `LLM_API_KEY` 保留)
- 列出 4 个 provider 名(`havefun-*`),给出 `LLM_EXTRA_MODELS_JSON` 的 JSON 示例(脱敏:用占位 id)
- 清空 README 末尾"TODO"中已落实的两项,保留 OAuth/非标头作为后续

#### R6.2 — `.env.example`(repo 根,追加 3 行)

- 加 `LLM_PROVIDER=havefun-anthropic`(示例)
- 加 `LLM_MODEL=claude-opus-4-7`(示例)
- 加 `LLM_EXTRA_MODELS_JSON=`(可选,留空 = 无额外模型)

#### R6.3 — 主 `README.md`(代码示例片段)

- 第 279 行 `pi.registerProvider("company", { ... })` 示例改为 `pi.registerProvider("havefun-anthropic", { ... })`,字段示例同步更新(api/baseUrl/models)
- "yourcompany/code-reviewer:latest" 第 95 行 **保留**(docker registry 占位,与 LLM 网关无关)

#### R6.4 — `.trellis/spec/flower-providers/{frontend,backend}/*`(约 13 个 spec 文件)

逐个修正以下文件,全面替换 `registerCompanyProviders` → `registerHavefunProviders`、`getDefaultModelId` → `getDefaultModel`、`CUSTOM_MODELS` → `BUILTIN_MODELS`、provider 名 `"company"` → 4 个 `havefun-*`、模型 id `company-gpt-4*` → 真实 id(`claude-opus-4-7` 等):

- `frontend/index.md` — 公开 API 列表更新为 3 个函数 + 1 个类型;`appSource` 语义补"仅用于审计 header"
- `frontend/component-guidelines.md` — 函数签名示例改新版;`getDefaultModelId` 示例整段重写为 `getDefaultModel`
- `frontend/hook-guidelines.md` — `pi.registerProvider("havefun-anthropic", ...)` 示例;明确"4 个 provider name 联合类型"约定
- `frontend/directory-structure.md` — 公开 API 表格更新;模块结构改为 5 文件(`env.ts` / `catalog.ts` / `register.ts` / `runtime.ts` + `index.ts`),不再是单文件
- `frontend/state-management.md` — 函数名替换
- `frontend/quality-guidelines.md` — 示例代码 + JSDoc 必填清单更新到新 API
- `frontend/type-safety.md` — 示例代码 + `getDefaultModelId` 整段重写为 `getDefaultModel`(无参,fail-fast)
- `backend/index.md` — 同步更新
- `backend/directory-structure.md` — "单文件"改为"5 文件";示例改新名
- `backend/error-handling.md` — fail-fast 矩阵新增 `LLM_PROVIDER` / `LLM_MODEL` / `LLM_EXTRA_MODELS_JSON` 三条
- `backend/logging-guidelines.md` — 检查并更新提到的函数名
- `backend/quality-guidelines.md` — 反模式示例改新名
- `backend/database-guidelines.md` — 检查(可能无变化)

#### R6.5 — `.trellis/spec/flower-code-reviewer/frontend/*`(2 个 cross-package 引用)

- `hook-guidelines.md` — 第 26/30/49 行的 `registerCompanyProviders` → `registerHavefunProviders`;示例 provider 名 `"company"` → `"havefun-anthropic"`
- `directory-structure.md` — 第 49 行 `registerCompanyProviders → registerCompliance → ...` 顺序描述中的函数名更新

#### R6.6 — 验证扫描

`grep -rn "registerCompanyProviders\|getDefaultModelId\|CUSTOM_MODELS\|\"company\"\|company-gpt" packages/ .trellis/spec/ README.md .env.example 2>/dev/null | grep -v node_modules | grep -v ".trellis/tasks/"` 必须返回空(除 `yourcompany/*` docker 占位)

## Acceptance Criteria

- [ ] **AC1**:`npm run build` / `npm run typecheck` / `npm run check`(biome lint)在 monorepo 根目录全部通过
- [ ] **AC2**:`registerHavefunProviders` 成功注册 4 个 provider,每个 provider 注册的模型数与 ADR-4 表格一致(anthropic=3 / gemini=3 / openai-responses=2 / openai=0,合计 8 = 预设清单大小,不含 `LLM_EXTRA_MODELS_JSON` 注入);`havefun-openai` 在无 extras 时注册成功但 models 列表为空
- [ ] **AC3**:`getDefaultModel` 在 env 缺失时抛带可读信息的错;env 合法时返回正确的 `{provider, modelId}`
- [ ] **AC4**:`buildHavefunModel` 返回的 `Model` 对象能被 `pi-agent-core` 的 `Agent` 接受(类型检查通过 + 运行时无报错)
- [ ] **AC5**:`code-reviewer` 现有调用路径行为不变(`extension.ts` 调用 `registerHavefunProviders(pi, { appSource: "code-reviewer" })` 仍能正常 boot)
- [ ] **AC6**:`ops-bot` 的 `agent-factory.ts` 改用 `buildHavefunModel` 后 `npm run build` 通过,`pickModel` 已不再直读 `LLM_BASE_URL`
- [ ] **AC7**:对开发网关 `https://jp-ai.havefun.eu.cc` 跑一次**真实端到端调用**(通过 pi-ai `streamSimple` + 4 个 provider 各一个模型),拿到非空回复;过程中 apiKey 不出现在任何 commit 文件 / 控制台日志
- [ ] **AC8**:`LLM_EXTRA_MODELS_JSON` 注入一个测试模型(如 `claude-opus-4-5-thinking`),启动后能在 `pi.registerProvider` 注册的 model 列表里看到
- [ ] **AC9**:`README.md` / `.env.example` / `packages/*/README.md` / `.trellis/spec/flower-providers/**` / `.trellis/spec/flower-code-reviewer/frontend/{hook-guidelines,directory-structure}.md` 全部按 R6 更新
- [ ] **AC10**:R6.6 验证扫描通过 — `grep -rn "registerCompanyProviders\|getDefaultModelId\|CUSTOM_MODELS\|\"company\"\|company-gpt" packages/ .trellis/spec/ README.md .env.example | grep -v node_modules | grep -v .trellis/tasks/` 返回空

## Definition of Done (team quality bar)

- 所有 Acceptance Criteria(AC1–AC9)勾选
- 新增公开 API(`getDefaultModel` / `buildHavefunModel`)有 JSDoc 中文注释,说明用途 / 参数 / 错误条件
- 新增 env 变量(`LLM_PROVIDER` / `LLM_MODEL` / `LLM_EXTRA_MODELS_JSON`)在 `.env.example` + README 各出现一次,语义说明一致
- 不引入新的运行时依赖(只用已有的 `@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent`)
- 端到端调用所用 API key 在任务结束后**轮换**(用户责任,任务在 Wrap-up reminder 中明确提示)

## Out of Scope (explicit)

- **OAuth / 非标鉴权头支持**(README 旧 TODO):保留为后续任务;本任务只支持 `Authorization: Bearer <LLM_API_KEY>`(pi 内置)
- **真实 cost 元数据**:本任务 `BUILTIN_MODELS.cost` 全填 0(明确文档化"接通计费系统后再补");计费监控不属于本任务
- **图像 / rerank / embedding 模型**:网关支持但与 chat agent 无关,本任务不注册(`BAAI/bge-m3` / `jina-reranker-v3` / `gpt-image-2` 等不在 `BUILTIN_MODELS`)
- **`ops-bot` 的 complexity 分流**(轻量 vs 重诊断自动选模型):由 ops-bot 业务侧未来自己做,flower-providers 只提供"取默认模型"
- **模型清单运行时探测**(`GET /v1/models`):本任务采用"代码预设 + env 扩展",不在启动期联网拉取
- **`code-reviewer` 的 skill-based 模型选择**:由 code-reviewer 自己未来做(第 3 周路线图),flower-providers 不掺和
- **集成测试 / CI 钩入网关调用**:本任务的 AC7 是开发期手动一次性验证,不在 CI 中跑(避免泄露 key)
- **`yourcompany/*` docker image 占位**(主 README + 各包 README 的 `docker build -t yourcompany/flower-*:latest`):这是给读者替换自己 registry 前缀的模板,与本任务"LLM 网关命名 company → havefun"是两个完全无关的语义,**不在改动范围**

## Research References

- `src/index.ts` — 当前实现 + 占位模型清单
- `packages/flower-code-reviewer/src/extension.ts` — 唯一现有下游
- `packages/flower-ops-bot/src/agent-factory.ts` — 旁路本包的反例,需要被纳入统一
- `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts` — pi-coding-agent 的 model registry 接口
- `node_modules/@earendil-works/pi-ai/dist/models.d.ts` / `api-registry.d.ts` — pi-ai 的全局 model / api 注册
- `.trellis/spec/flower-providers/{frontend,backend}/*` — 包内开发规范
