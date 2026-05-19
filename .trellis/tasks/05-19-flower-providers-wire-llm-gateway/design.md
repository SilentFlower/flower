# 技术设计:flower-providers 接通 LLM 网关

> 配套 `prd.md`。聚焦边界 / 接口契约 / 数据流 / 兼容性 / 失败处理。

## 模块结构

`packages/flower-providers/src/` 从"单文件"扩展到多文件:

```
src/
├── index.ts              # 公开 API 出口(re-export only)
├── env.ts                # 环境变量校验与解析(LLM_BASE_URL / LLM_PROVIDER / LLM_MODEL / LLM_EXTRA_MODELS_JSON)
├── catalog.ts            # BUILTIN_MODELS 静态清单 + ProviderName 类型
├── register.ts           # registerHavefunProviders 实现(注册 4 个 provider)
└── runtime.ts            # getDefaultModel / buildHavefunModel 实现
```

不引入 barrel / 子目录,层级保持平。

### 类型契约

```typescript
// 暴露给下游的 4 个公开 provider 名,联合类型,便于编辑器补全 + 类型校验
export type ProviderName =
  | "havefun-openai"
  | "havefun-openai-responses"
  | "havefun-anthropic"
  | "havefun-gemini";

// 4 个 provider name → pi-ai Api 字段的映射(实现细节,不导出)
const PROVIDER_TO_API: Record<ProviderName, Api> = {
  "havefun-openai": "openai-completions",
  "havefun-openai-responses": "openai-responses",
  "havefun-anthropic": "anthropic-messages",
  "havefun-gemini": "google-generative-ai",
};

// 单个模型的元数据(internal type,基本对齐 pi-ai ProviderModelConfig 的子集)
interface BuiltinModelEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 该模型走哪个 pi-ai api(原生协议),由它决定注册到哪个 provider — 见 ADR-6 */
  nativeApi: Api;
}

// 反向映射:nativeApi → 注册到哪个 provider
const API_TO_PROVIDER: Record<Api, ProviderName> = {
  "anthropic-messages": "havefun-anthropic",
  "google-generative-ai": "havefun-gemini",
  "openai-responses": "havefun-openai-responses",
  "openai-completions": "havefun-openai",
} as Record<Api, ProviderName>;

// 公开 API
export function registerHavefunProviders(pi: ExtensionAPI, options: { appSource: string }): void;
export function getDefaultModel(): { provider: ProviderName; modelId: string };
export function buildHavefunModel(provider: ProviderName, modelId: string): Model<Api>;
```

## 数据流

### 启动期:`code-reviewer` 走 `pi.registerProvider`

```
extension.ts:registerHavefunProviders(pi, { appSource: "code-reviewer" })
       │
       ▼
[env.ts]  读 LLM_BASE_URL → fail-fast if missing
          读 LLM_EXTRA_MODELS_JSON(可选)→ JSON.parse → fail-fast if invalid
       │
       ▼
[catalog.ts]  合并:BUILTIN_MODELS + extras → mergedModels[]
       │
       ▼
[register.ts]  for each providerName ∈ 4 个:
                 const api = PROVIDER_TO_API[providerName];
                 // 关键:按 m.nativeApi === api 过滤(每个 model 只匹配 1 个 provider)
                 const filteredModels = mergedModels.filter(m => m.nativeApi === api);
                 // baseUrl 按 provider 拼协议后缀(见 ADR-7):
                 //   havefun-openai/-responses → root + "/v1"
                 //   havefun-anthropic         → root(SDK 自己拼 /v1/messages)
                 //   havefun-gemini            → root + "/v1beta"
                 const providerBaseUrl = resolveProviderBaseUrl(providerName);
                 pi.registerProvider(providerName, {
                   baseUrl: providerBaseUrl,
                   apiKey: "LLM_API_KEY",      // 字符串字面量 → pi 自己 resolve
                   api,
                   models: filteredModels.map(toProviderModelConfig),
                   headers: { "X-App-Source": appSource },
                 });
                 // 注意:`havefun-openai` 在无 extras 时 filteredModels 可能为空数组;
                 // pi.registerProvider 接受空 models(此 provider 仅作"已注册但可扩展"的接口)
```

### 运行期:`ops-bot` 走 `buildHavefunModel`

```
agent-factory.ts:pickModel()
       │
       ▼
[runtime.ts:getDefaultModel()]
   读 LLM_PROVIDER → 校验 ∈ ProviderName 联合 → fail-fast
   读 LLM_MODEL → 在 mergedModels 中查 + 校验 model.nativeApi === PROVIDER_TO_API[provider] → fail-fast
   return { provider, modelId }
       │
       ▼
[runtime.ts:buildHavefunModel(provider, modelId)]
   从 mergedModels 拿元数据
   返回 Model<Api>:{
     id: modelId,
     provider,
     api: PROVIDER_TO_API[provider],
     baseUrl: resolveProviderBaseUrl(provider),  // 根 + 协议后缀,见 ADR-7
     contextWindow, maxTokens, cost, reasoning, input, ...
   }
       │
       ▼
new Agent({ initialState: { model, ... }, streamFn: streamSimple-with-apikey })
```

### 关键不变量

1. **apiKey 永不流经 flower-providers 代码**:
   - code-reviewer 路径:`apiKey: "LLM_API_KEY"` 是字符串字面量,pi 内部 resolve
   - ops-bot 路径:`agent-factory.ts:streamFn` 自己读 `process.env.LLM_API_KEY` 传给 `streamSimple` — 这是 pi-agent-core 的约定,无法绕开,但本包不持有它
2. **`baseUrl` 取自单一来源** `process.env.LLM_BASE_URL`(根 URL,不带后缀):本包不接受 baseUrl 作为参数(没有"测试覆盖一个不同 URL"的需求,降低 surface area);4 个 provider 各自的完整 baseUrl 由 `resolveProviderBaseUrl(provider)` 按 `PROVIDER_PATH_SUFFIX` 自动拼后缀(详见 ADR-7)
3. **`appSource` 仅出现在 header**:本包接到 appSource 后只写 `X-App-Source` header,不参与任何模型选择 / 路由

## 兼容性

### 破坏性变更清单(同 PR 一起改)

| 旧 API | 新 API | 处理 |
|---|---|---|
| `getDefaultModelId(appSource: string): string` | **删除** | 现有唯一调用方 README 示例文档,本任务 R6 同步更新 |
| `appSource` 影响模型选择(README 旧描述) | `appSource` 仅审计 | README R6 改 |
| `LLM_BASE_URL` / `LLM_API_KEY`(必填) | 不变 | — |
| (无) | 新增 `LLM_PROVIDER`(必填) | `.env.example` R6 加 |
| (无) | 新增 `LLM_MODEL`(必填) | `.env.example` R6 加 |
| (无) | 新增 `LLM_EXTRA_MODELS_JSON`(可选) | README R6 文档化 |

### ops-bot 当前 `agent-factory.ts` 已知改动

```diff
- function pickModel(): any {
-   return {
-     id: "company-gpt-4-mini",
-     name: "Custom GPT-4 Mini",
-     api: "openai-completions",
-     provider: "company",
-     baseUrl: process.env.LLM_BASE_URL ?? "",
-     ...
-   };
- }
+ function pickModel() {
+   const { provider, modelId } = getDefaultModel();
+   return buildHavefunModel(provider, modelId);
+ }
```

`streamFn` 里 `apiKey: process.env.LLM_API_KEY ?? ""` **保留**(pi-agent-core 的 streamSimple 协议要求)。

### code-reviewer 当前 `extension.ts` 不变

```typescript
registerHavefunProviders(pi, { appSource: "code-reviewer" });  // 函数签名不动
```

## 失败处理

### Fail-fast 边界(进程启动期)

| 触发条件 | 行为 |
|---|---|
| `LLM_BASE_URL` 缺失 | `throw new Error("LLM_BASE_URL 未配置")` |
| `LLM_API_KEY` 缺失 | 由 pi 自己 fail-fast(本包不预先检查,因为 ops-bot 路径直接读) — **本包额外加一次检查**保持两条路径行为一致 |
| `LLM_PROVIDER` 缺失或非法值 | `throw new Error(...)`,列出合法 4 个 provider 名 |
| `LLM_MODEL` 缺失 | `throw new Error("LLM_MODEL 未配置")` |
| `LLM_MODEL` 不在合并清单 | `throw new Error("...,可选模型 id:[...]")`(列出合并清单全部 id) |
| `LLM_MODEL` 不支持 `LLM_PROVIDER` 对应协议 | `throw new Error("...,该 model 仅支持协议 [...]")` |
| `LLM_EXTRA_MODELS_JSON` JSON parse 失败 | `throw new Error("LLM_EXTRA_MODELS_JSON 解析失败:<原始 message>")` |
| `LLM_EXTRA_MODELS_JSON` 不是数组 / 缺关键字段 | 仅做基础结构校验(数组 + 每项有 `id`/`supportedApis`),其余字段缺失走默认值 |
| `appSource` 为空字符串 | `throw new Error("appSource 必填")` |

### 错误消息约定

- 中文 + 明确指明哪个 env 变量出问题 + 给出可选值(如果适用)
- 不打印 `LLM_API_KEY` 的任何片段(spec 强约束)

### 运行期失败

- 本包没有运行时分支,所有失败都在启动期 surface
- 网关请求失败 / 401 / 429 等由 pi-ai 自己处理,不属于本包责任

## 测试策略

### 单元测试(`packages/flower-providers/src/__tests__/`)

- `env.test.ts`:fail-fast 矩阵(每个 env 缺失场景一个 case)
- `catalog.test.ts`:`BUILTIN_MODELS` 数据完整性(每个模型必须至少支持 1 个 api;`supportedApis` 全部 ∈ `KnownApi`)
- `runtime.test.ts`:
  - `getDefaultModel` 4 种合法组合各一个 case
  - `getDefaultModel` 8 种非法组合(env 缺失 / 非法 provider / 非法 model / model-provider 不匹配)
  - `buildHavefunModel` 返回的 Model 字段对照 pi-ai `Model<Api>` 类型(用 TypeScript 自动检查)
- `register.test.ts`:用 stub 的 `ExtensionAPI` 检查 4 次 `registerProvider` 调用 + 每次 models 过滤正确

> 单元测试**不联网**,网关交互用 mock/stub。

### 端到端验证(AC7,手动一次性)

写一个独立脚本 `scripts/smoke-gateway.ts`(不进 git,放在 `.trellis/tasks/05-19-.../scripts/`):

```typescript
// 对 4 个 provider 各跑一个 streamSimple 调用,打印第一个 chunk 的前 50 字符
// 用 LLM_API_KEY 从 env 注入(终端 `export LLM_API_KEY=... && npx tsx scripts/smoke-gateway.ts`)
// key 不进任何 commit 文件
```

完成 AC7 后该脚本作为 reference 留在 task workspace,任务收尾时**不** commit 到 packages/。

## Rollout / Rollback

- 本任务全部代码改动只影响 `flower-providers` 与 `ops-bot/agent-factory.ts`;无 DB / 无在跑服务
- code-reviewer / ops-bot 部署需要在 env 中**新增**:`LLM_PROVIDER` / `LLM_MODEL`(若不加,启动期 fail-fast,不会"悄悄退化")
- Rollback:`git revert` 即可,无副作用

## 风险与开放项

| 风险 | 缓解 |
|---|---|
| 网关对某些协议的"实际兼容度"可能与 supported_endpoint_types 表述不一致(如 anthropic-messages 协议下的 tool calling 可能行为有差异) | AC7 端到端验证时,每个 provider 至少跑 1 个带工具调用的 case(可由 ops-bot smoke 复用) |
| 真实 cost 数据缺失 | ADR-4 明确 cost 暂全 0,后续接计费再补;不阻塞本任务 |
| `LLM_EXTRA_MODELS_JSON` 多行 JSON 在 shell / docker env 中转义麻烦 | README 给出双引号 + base64 解码两种示例 |
| pi-ai 上游升级可能修改 `Api` 字段名 | 本包 PROVIDER_TO_API 集中映射,一处可改;`KnownApi` 改动会立即在 typecheck 时暴露 |
