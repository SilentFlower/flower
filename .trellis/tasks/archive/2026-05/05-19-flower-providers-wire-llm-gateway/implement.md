# 执行计划:flower-providers 接通 LLM 网关

> 配套 `prd.md` + `design.md`。每个 step 给出动作 + 验证命令 + 完成判据。
> 顺序严格,前一步未通过不进下一步。

## Implementation Checklist

### Step 1 — 拆 `src/` 单文件成模块骨架

- [ ] 创建 `packages/flower-providers/src/env.ts`(空 stub)
- [ ] 创建 `packages/flower-providers/src/catalog.ts`(空 stub)
- [ ] 创建 `packages/flower-providers/src/register.ts`(空 stub)
- [ ] 创建 `packages/flower-providers/src/runtime.ts`(空 stub)
- [ ] `src/index.ts` 暂时保留旧实现 + 空 re-export(下一步逐个迁过去)
- **验证**:`npm run typecheck -w @flower-ai/flower-providers` 通过
- **完成判据**:目录结构与 design.md 一致

### Step 2 — `catalog.ts`:8 个 BUILTIN_MODELS

- [ ] 定义 `ProviderName` 联合类型(4 个 `havefun-*`)
- [ ] 定义 `PROVIDER_TO_API: Record<ProviderName, Api>` 常量
- [ ] 定义 `API_TO_PROVIDER: Record<Api, ProviderName>` 反向常量(给 register.ts 用)
- [ ] 定义 `BuiltinModelEntry` interface(注意:**单一 `nativeApi: Api`**,不再用 `supportedApis` 数组)
- [ ] 定义 `BUILTIN_MODELS: readonly BuiltinModelEntry[]`(8 条,数据严格按 PRD ADR-4 表格):
  - 3 条 Claude → `nativeApi: "anthropic-messages"`
  - 3 条 Gemini → `nativeApi: "google-generative-ai"`
  - 2 条 GPT(`gpt-5.4` / `gpt-5.5`)→ `nativeApi: "openai-responses"`
  - `cost` 字段:全填 0(`{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`),加 `@remarks` 注释说明"接计费系统后再补"
  - `contextWindow` / `maxTokens`:Claude 系列查 anthropic 官方 / Gemini 系列查 google 官方 / GPT 系列填 128K + 16K 作占位
- [ ] 单元测试 `catalog.test.ts`:断言 8 条记录;断言每条 `nativeApi` ∈ pi-ai `KnownApi`;断言无 BUILTIN 模型走 `openai-completions`(`havefun-openai` 默认空,这是设计)
- **验证**:`npm run test -w @flower-ai/flower-providers`(若无 test runner,先按 Step 8 配置)
- **完成判据**:`BUILTIN_MODELS` 文件 ≤ 120 行(数据 + 少量注释)

### Step 3 — `env.ts`:环境变量 schema 与 fail-fast

- [ ] `getLLMBaseUrl(): string`:读 `LLM_BASE_URL`,缺失抛 `LLM_BASE_URL 未配置`
- [ ] `getLLMApiKeyEnvName(): string`:固定返回字符串 `"LLM_API_KEY"`(给 pi 用);**附加 fail-fast 检查 `process.env.LLM_API_KEY` 真实存在**(避免 ops-bot 路径运行期才发现)
- [ ] `getLLMProvider(): ProviderName`:读 `LLM_PROVIDER`,fail-fast 校验 ∈ 4 名
- [ ] `getLLMModel(): string`:读 `LLM_MODEL`,fail-fast 校验非空字符串
- [ ] `getExtraModels(): BuiltinModelEntry[]`:读 `LLM_EXTRA_MODELS_JSON`(可选),JSON.parse,数组结构校验,fail-fast on parse error / 类型错
- [ ] `getMergedModels(): BuiltinModelEntry[]`:`BUILTIN_MODELS + getExtraModels()`,同 id 后者覆盖前者
- [ ] 错误消息按 design.md "失败处理"表
- [ ] 单元测试 `env.test.ts`:fail-fast 矩阵
- **验证**:`npm run test -w @flower-ai/flower-providers` 通过
- **完成判据**:`env.ts` 单一职责,不引用 register/runtime

### Step 4 — `runtime.ts`:`getDefaultModel` + `buildHavefunModel`

- [ ] `getDefaultModel(): { provider: ProviderName; modelId: string }`:
  - 读 `getLLMProvider()` + `getLLMModel()`
  - 在 `getMergedModels()` 中找 `modelId`,fail-fast if not found(错误信息列出全部合法 id)
  - 校验 `model.nativeApi === PROVIDER_TO_API[provider]`,fail-fast if mismatch(错误信息说明"该模型原生协议为 X,与 LLM_PROVIDER=Y 对应的协议不一致")
- [ ] `buildHavefunModel(provider, modelId): Model<Api>`:
  - 同样校验 provider/modelId 合法
  - 拼装 `Model<Api>` 字段:`id, provider, api, baseUrl, contextWindow, maxTokens, cost, reasoning, input, name`
  - 用 `as unknown as Model<Api>` 收尾(pi-ai 类型对自定义 provider 有泛型约束,需要桥接)
- [ ] 单元测试 `runtime.test.ts`:
  - `getDefaultModel` 3 种合法组合(anthropic+Claude / gemini+Gemini / openai-responses+GPT)
  - `getDefaultModel` 6+ 种非法组合(env 缺失 / 非法 provider / 非法 model / model-provider 不匹配各覆盖,例如 `LLM_PROVIDER=havefun-openai` + `LLM_MODEL=claude-opus-4-7` 必须报错)
  - `buildHavefunModel` 字段对照
- **验证**:`npm run test -w @flower-ai/flower-providers` 通过
- **完成判据**:`runtime.ts` 不 import register.ts(无环依赖)

### Step 5 — `register.ts`:registerHavefunProviders

- [ ] `registerHavefunProviders(pi, { appSource })`:
  - 校验 `appSource` 非空字符串,fail-fast
  - 调 `getLLMBaseUrl()` + `getLLMApiKeyEnvName()`(触发 env 校验)
  - 用 `getMergedModels()` 取合并清单
  - for 4 个 provider(`havefun-openai` / `havefun-openai-responses` / `havefun-anthropic` / `havefun-gemini`):
    - `const api = PROVIDER_TO_API[providerName]`
    - filter 出 `m.nativeApi === api` 的模型子集(每个 model 只命中 1 个 provider)
    - 转换为 pi 的 `ProviderModelConfig` 形状(注意 pi 的 `ProviderModelConfig` 与本包 `BuiltinModelEntry` 字段差异,需 mapper)
    - 调 `pi.registerProvider(providerName, { baseUrl, apiKey: "LLM_API_KEY", api, models, headers: { "X-App-Source": appSource } })`
  - `havefun-openai` 在无 extras 时 `models` 为空数组,仍 `registerProvider`(留 hook 供 extras 注入)
- [ ] 单元测试 `register.test.ts`:
  - 用一个 stub `ExtensionAPI`(只实现 `registerProvider` spy)
  - 断言被调 4 次,每次 providerName / api 正确
  - 模型数断言:`havefun-anthropic`=3 / `havefun-gemini`=3 / `havefun-openai-responses`=2 / `havefun-openai`=0(无 extras 时)
  - `gpt-5.5` 只出现在 `havefun-openai-responses` 注册的 models 中
  - 提供 1 个 `LLM_EXTRA_MODELS_JSON` case(注入一个 `nativeApi: "openai-completions"` 的 model),断言它出现在 `havefun-openai` 注册中
- **验证**:`npm run test -w @flower-ai/flower-providers` 通过
- **完成判据**:`register.ts` 不直接读 process.env(全部走 env.ts)

### Step 6 — `src/index.ts`:重写为纯 re-export

- [ ] 删除旧 `CUSTOM_MODELS` / 旧 `registerHavefunProviders` / 旧 `getDefaultModelId`
- [ ] 改为:
  ```typescript
  export { registerHavefunProviders } from "./register.js";
  export { getDefaultModel, buildHavefunModel } from "./runtime.js";
  export type { ProviderName } from "./catalog.js";
  ```
- **验证**:`npm run build -w @flower-ai/flower-providers` 通过(dist/index.d.ts 含 3 个公开函数 + 1 个类型)
- **完成判据**:`src/index.ts` ≤ 5 行

### Step 7 — 接入 `ops-bot`

- [ ] 改 `packages/flower-ops-bot/src/agent-factory.ts`:
  - 加 `import { getDefaultModel, buildHavefunModel } from "@flower-ai/flower-providers";`
  - 改 `pickModel()`:删除 hard-code Model 对象,改为 `const { provider, modelId } = getDefaultModel(); return buildHavefunModel(provider, modelId);`
  - 删除函数体内的 `// biome-ignore lint/suspicious/noExplicitAny: ...` 注释(若 buildHavefunModel 返回类型已具体)
  - `streamFn` 内 `apiKey: process.env.LLM_API_KEY ?? ""` 保留,加注释"与 flower-providers 同一来源"
- [ ] 检查 `ops-bot/package.json` 是否声明 `@flower-ai/flower-providers` 依赖,缺则加(`workspace:^`)
- **验证**:`npm run typecheck -w @flower-ai/flower-ops-bot` + `npm run build -w @flower-ai/flower-ops-bot` 通过
- **完成判据**:`agent-factory.ts` 不再含字符串 `"LLM_BASE_URL"` 直读

### Step 8 — 测试基础设施(若仓库尚无 test runner)

- [ ] 检查 monorepo 是否已有 vitest / jest:`grep -r "vitest\|jest" package.json packages/*/package.json | head`
- [ ] 若无:在 root `package.json` devDep 加 `vitest`,加 `test` script,在 `packages/flower-providers/package.json` 加 `"test": "vitest run"`
- [ ] 若有:复用现有,在 `flower-providers/package.json` 补 `test` script
- **验证**:`npm run test -w @flower-ai/flower-providers` 跑通至少 1 个测试
- **完成判据**:CI 风格的命令 `npm run test --workspaces --if-present` 不报错

### Step 9 — 文档与 spec 全面"company → havefun"扫荡(R6)

> 涉及 ~17 个文件。统一原则:**LLM 网关相关 "company" 必改;`yourcompany/*` docker image 占位不动**。

#### Step 9.1 — `packages/flower-providers/README.md` 重写

- [ ] 公开 API 段:改 3 个函数(`registerHavefunProviders` / `getDefaultModel` / `buildHavefunModel`)+ `ProviderName` 类型
- [ ] 列出 4 个 provider 名(`havefun-openai` / `havefun-openai-responses` / `havefun-anthropic` / `havefun-gemini`)
- [ ] env 表新增 `LLM_PROVIDER` / `LLM_MODEL` / `LLM_EXTRA_MODELS_JSON`
- [ ] `LLM_EXTRA_MODELS_JSON` JSON 示例(脱敏,用占位 model id)
- [ ] 删 README 末尾"TODO"中"模型清单占位"+"OAuth/非标头"两项,只保留 OAuth + 非标头作后续

#### Step 9.2 — `.env.example`(repo 根,追加 3 行)

- [ ] 加 `LLM_PROVIDER=havefun-anthropic`
- [ ] 加 `LLM_MODEL=claude-opus-4-7`
- [ ] 加 `LLM_EXTRA_MODELS_JSON=`(空 = 无 extras)

#### Step 9.3 — 主 `README.md` 示例片段

- [ ] 第 279 行 `pi.registerProvider("company", {...})` 示例改为 `pi.registerProvider("havefun-anthropic", { baseUrl: "...", apiKey: "LLM_API_KEY", api: "anthropic-messages", models: [...] })`,字段更新
- [ ] 第 95 行 `yourcompany/code-reviewer:latest` **不动**(docker registry 占位)

#### Step 9.4 — `.trellis/spec/flower-providers/frontend/*`(7 文件)

逐个修正,重点是函数签名 / provider 名 / 模型 id 示例:

- [ ] `index.md` — 公开 API 列表改 3 个函数 + ProviderName 类型;`appSource` 语义补"仅用于审计 header"
- [ ] `component-guidelines.md` — `registerCompanyProviders` 签名段改 `registerHavefunProviders`;整段 `getDefaultModelId` 重写为 `getDefaultModel`(无参,fail-fast)
- [ ] `hook-guidelines.md` — `pi.registerProvider("company", ...)` 示例改 `havefun-anthropic`;明确"4 个 provider name 联合"约定;模型 id `company-gpt-4` → `claude-opus-4-7`
- [ ] `directory-structure.md` — "唯一公开入口"改 5 文件模块;公开 API 表更新
- [ ] `state-management.md` — 函数名替换 `registerCompanyProviders` → `registerHavefunProviders`
- [ ] `quality-guidelines.md` — 示例 + JSDoc 必填清单更新
- [ ] `type-safety.md` — 示例代码 + 整段 `getDefaultModelId` 重写

#### Step 9.5 — `.trellis/spec/flower-providers/backend/*`(5 文件)

- [ ] `index.md` — 同 frontend 思路
- [ ] `directory-structure.md` — "单文件"改"5 文件"
- [ ] `error-handling.md` — fail-fast 矩阵新增 3 条(`LLM_PROVIDER` / `LLM_MODEL` / `LLM_EXTRA_MODELS_JSON`)
- [ ] `logging-guidelines.md` — 检查并替换函数名
- [ ] `quality-guidelines.md` — 反模式示例改新函数名

#### Step 9.6 — `.trellis/spec/flower-code-reviewer/frontend/*`(2 文件,cross-package)

- [ ] `hook-guidelines.md` — 第 26/30/49 行 `registerCompanyProviders` → `registerHavefunProviders`;provider 名 `"company"` → `"havefun-anthropic"`
- [ ] `directory-structure.md` — 第 49 行"按固定顺序调 `registerCompanyProviders → ...`"中的函数名更新

#### Step 9.7 — 验证扫描

- [ ] `grep -rn "registerCompanyProviders\|getDefaultModelId\|CUSTOM_MODELS\|\"company\"\|company-gpt" packages/ .trellis/spec/ README.md .env.example 2>/dev/null | grep -v node_modules | grep -v .trellis/tasks/` 必须返回空
- [ ] `grep -rn "yourcompany/" packages/ README.md 2>/dev/null | grep -v node_modules | wc -l` 应为 3(主 README × 1 + 两个产品 README × 2),证明"docker 占位未被误改"

**完成判据**:Step 9.7 两条 grep 全部满足

### Step 10 — 综合质量验证

- [ ] `npm run build`(monorepo 根)— AC1
- [ ] `npm run typecheck`(monorepo 根)— AC1
- [ ] `npm run check`(biome)— AC1
- [ ] `npm run test --workspaces --if-present` — 单元测试全过
- **完成判据**:全绿

### Step 11 — 端到端验证(AC7,手动)

> 此步骤需要真实 API key,不进 CI / 不 commit 任何 secret。

- [ ] 创建 `.trellis/tasks/05-19-flower-providers-wire-llm-gateway/scripts/smoke-gateway.ts`(任务工作区,**不**在 packages/ 下)
- [ ] 脚本覆盖 4 个 provider 各跑 1 次 `pi-ai.completeSimple`,用最小 prompt(如"用一句话介绍自己")
  - `havefun-anthropic` → `claude-opus-4-7`(或其他 Claude)
  - `havefun-gemini` → `gemini-2.5-flash`
  - `havefun-openai-responses` → `gpt-5.5`(关键 case:验证网关漏报但实际支持)+ `gpt-5.4`
  - `havefun-openai` → 临时用 `LLM_EXTRA_MODELS_JSON` 注入一个 only-openai 模型(如网关里的 `grok-4.20-fast`),验证 extras 路径
- [ ] 终端运行示例:`export LLM_BASE_URL=https://jp-ai.havefun.eu.cc; export LLM_API_KEY=<key>; export LLM_PROVIDER=havefun-anthropic; export LLM_MODEL=claude-opus-4-7; npx tsx <script>`
- [ ] 4 个 provider 都拿到非空回复 → AC7 ✅
- [ ] 用 `grep -rn "sk-AtlI\|sk-[A-Za-z0-9]\{20,\}" packages/ .trellis/spec/ README.md .env.example 2>/dev/null | grep -v node_modules` 双重确认 key 没泄漏
- **完成判据**:4 个 provider 真实调通,grep 无泄漏

## Validation 命令汇总

```bash
# 类型检查
npm run typecheck

# 构建
npm run build

# 代码风格
npm run check

# 单元测试
npm run test --workspaces --if-present

# company 残留扫描(应为空)
grep -rn "registerCompanyProviders\|getDefaultModelId\|CUSTOM_MODELS\|\"company\"\|company-gpt" packages/ .trellis/spec/ README.md .env.example 2>/dev/null | grep -v node_modules | grep -v .trellis/tasks/

# yourcompany/* 占位未被误改(应为 3)
grep -rn "yourcompany/" packages/ README.md 2>/dev/null | grep -v node_modules | wc -l

# secret 泄漏自检
grep -rn "sk-[A-Za-z0-9]\{20,\}" packages/ .trellis/spec/ README.md .env.example 2>/dev/null | grep -v "node_modules" || echo "OK: no leaked secrets"
```

## Review Gates

| Gate | 何时 | 通过条件 |
|---|---|---|
| **Pre-start gate** | `task.py start` 之前 | 用户 review PRD + design + implement 三件套,显式同意 |
| **Mid-implementation gate** | Step 7 完成后 | `npm run build` 全过,ops-bot 接入逻辑无破坏 |
| **Pre-AC7 gate** | Step 10 完成后,Step 11 之前 | 单元测试 / lint / build 全绿,准备拿真 key 做端到端 |
| **Pre-commit gate** | Step 11 完成后,git commit 之前 | `grep` 自检无 secret 泄漏,trellis-check / trellis-check-all 通过 |

## Rollback Points

- **Step 7 之后**:若 ops-bot 接入引发未预料问题,只 revert `agent-factory.ts` 即可,flower-providers 本体保留(它本就是修复 + 扩展,无负面影响)
- **Step 11 失败**:若某个 provider 网关协议实测不通(罕见),把对应 provider 从 `PROVIDER_TO_API` 暂时移除,AC2 / AC7 缩到 3 个 provider 通过即可(ADR-2 已记录降级路径)

## 与子任务模式无关性

本任务不切分 subtask(scope 适中,单 PR 闭环)。`trellis-route(implement)` 阶段可选 inline 或 sub-agent;实施者按 `implement.jsonl` 取上下文清单即可。
