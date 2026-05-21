# flower-providers · env 缺省时 fallback 到 havefun 默认 provider/model

## 0. 触发场景

2026-05-21 在 `xhgj003027/xhgj-iqs-ui` 排查 reviewer "model 怎么是 gpt-5.4 medium" 时挖出根因(详见 `05-21-walkthrough-blocker-consistency` 的姊妹任务对话记录):

- 业务方 `.gitlab-ci.yml` 和 Project CI Variables **都没**配 `LLM_PROVIDER` / `LLM_MODEL`
- `flower-providers/runtime.ts:buildPiCliArgs` 当前对 `LLM_PROVIDER`/`LLM_MODEL` 都做了 `try-catch` 吃掉缺失错误 + **不附加** `--provider` / `--model`
- 结果是 **pi-coding-agent 走自己的内置默认**(`model-resolver.js:defaultModelPerProvider` 表里 `openai/azure-openai-responses/github-copilot` 默认都是 `gpt-5.4`,DEFAULT_THINKING_LEVEL=`medium`)
- pi 内置 provider(`openai` / `azure-openai-responses`)走的是**它们各自的 baseUrl 与 API key 解析**,**不一定**走我们的 havefun 网关

## 1. 问题严重性

当前"侥幸跑通"了 — pi 在容器里大概是因为 `flower-providers/register.ts` 注册了 4 个 `havefun-*` provider,某种解析路径让 model 命中了 havefun-openai-responses,但**这是隐式行为**,不能依赖。最坏的情况:

- **后果 A**:LLM 请求被发到 pi 内置 provider 的官方 URL(如 `api.openai.com`),凭据 `LLM_API_KEY` 是 havefun 网关 key 不匹配 → 401 + fail open(`run.ts:isLlmFailure` 走网络错误分支) → MR 看到 warning 评论但不知道真因
- **后果 B**:pi 内置 provider 找的 env 变量是 `OPENAI_API_KEY`(不是我们的 `LLM_API_KEY`),实际跑到这条路径会"No API key found" → 看起来像 LLM 故障
- **后果 C**:即便侥幸走对网关,model id 也是 pi 内置默认而非项目预期,模型一换业务方完全不感知

总之:**缺 env 时不应静默走 pi 内置,要么 fail-fast,要么 fallback 到我们自己的默认**。

## 2. Goal

`code-reviewer` 形态(走 `buildPiCliArgs` 路径)在 `LLM_PROVIDER` / `LLM_MODEL` 缺省时,**自动 fallback 到 flower-providers 内置的合理默认值**,确保:
- `--provider <havefun-*>` 总是显式传给 pi CLI(永远不让 pi 走自己的内置 provider)
- `--model <havefun BUILTIN_MODELS 中存在的 id>` 总是显式传给 pi CLI
- LLM 调用**保证**走 havefun 网关 + 我们的 `LLM_API_KEY`

## 3. Requirements

### R1 · 默认值常量化

`flower-providers/src/runtime.ts` 中新增 2 个 export 常量:

```typescript
export const DEFAULT_LLM_PROVIDER: ProviderName = "havefun-anthropic";
export const DEFAULT_LLM_MODEL = "claude-sonnet-4-6";
```

选择理由:
- `havefun-anthropic` + `claude-sonnet-4-6`:速度 + 准确性折中(reviewer 的核心使用面),`BUILTIN_MODELS` 中已存在、protocol 自动匹配、`baseUrl` 自动拼对
- **不选 opus-4-7**:更贵,要做默认对所有接入方都加成本,opus 留给"显式想要"的项目
- **不选 haiku**:reasoning=false,reviewer 思考深度不够

### R2 · `buildPiCliArgs` 缺省时填默认 + 打日志

修改 `buildPiCliArgs(input)`:

- `LLM_PROVIDER` 缺省 → `DEFAULT_LLM_PROVIDER` + `console.log("[flower-providers] LLM_PROVIDER 未配置,fallback 到 \"<default>\"")`
- `LLM_MODEL` 缺省 → `DEFAULT_LLM_MODEL` + 同上格式日志
- `--provider` / `--model` argv **必然存在**,pi CLI 拿到的不再是空
- 每次调用最多打 2 行日志(provider 1 行 + model 1 行),不刷屏

### R3 · 不破坏 fail-fast 路径

`getLLMProvider()` / `getLLMModel()` 当前**仍然 throw**(`env.ts` 现有契约,ops-bot 形态走 `getDefaultModel()` 依赖这个 throw 来 fail-fast),**本任务不动**。

新增 2 个 helper(仍在 `env.ts` 里):
- `getLLMProviderOrDefault(): ProviderName` — 空 → DEFAULT_LLM_PROVIDER;非法值仍走 `getLLMProvider` 的 fail-fast(只对缺省值兜底,不对非法值兜底)
- `getLLMModelOrDefault(): string` — 空 → DEFAULT_LLM_MODEL;非空任意字符串透传,具体合法性由下游 `getMergedModels` 校验

只在 `buildPiCliArgs` 内使用。

### R4 · 不影响 ops-bot

ops-bot 形态走 `getDefaultModel()` → 缺 env 仍 throw(服务常驻,部署时应显式配齐 env,**不应**用默认值带病运行)。本任务**只**对 CLI 路径加 fallback。

### R5 · 不影响 reasoning effort

`LLM_REASONING_EFFORT` 缺省继续透传给 pi(让 pi 走自己的 medium 默认),**不**fallback 到 high 或 xhigh。理由:思考预算与"是否走 havefun 网关"无关,不绑入本任务;真要默认 high 单开任务讨论。

### R6 · README + spec 同步

- `packages/flower-providers/README.md` env 表加注:"`LLM_PROVIDER` / `LLM_MODEL` 缺省时 `buildPiCliArgs`(code-reviewer CLI 路径)fallback 到 `havefun-anthropic` + `claude-sonnet-4-6`;`getDefaultModel`(ops-bot 路径)仍 fail-fast"
- `.trellis/spec/flower-providers/backend/index.md` 加一节:CLI 路径 vs SDK 路径的缺省语义不同的原因

## 4. Out of Scope

- ❌ 修改 `getLLMProvider()` / `getLLMModel()` throw 语义(本任务**不**改 env.ts 现有 throw 行为,只新增 OrDefault 变体)
- ❌ 给 `getDefaultModel()`(ops-bot 路径)加 fallback
- ❌ `LLM_REASONING_EFFORT` 默认值改动
- ❌ `LLM_BASE_URL` / `LLM_API_KEY` 缺省 fallback(基础设施凭据,缺省必须 fail-fast)
- ❌ harness 模板 / 业务方 `.gitlab-ci.yml` 改动(本任务在 flower-providers 内部解决)

## 5. Acceptance Criteria

### AC1 · 单元测试(`packages/flower-providers/src/__tests__/`)

- [ ] **AC1.1** `getLLMProviderOrDefault()` 在 env 不配 → 返回 `"havefun-anthropic"`
- [ ] **AC1.2** `getLLMProviderOrDefault()` 在 env=`havefun-openai-responses` → 透传
- [ ] **AC1.3** `getLLMProviderOrDefault()` 在 env=非法值(如 `openai`)→ 仍 throw(沿用 fail-fast,**只对缺省兜底**)
- [ ] **AC1.4** `getLLMModelOrDefault()` 在 env 不配 → 返回 `"claude-sonnet-4-6"`
- [ ] **AC1.5** `getLLMModelOrDefault()` 在 env=`gpt-5.5` → 透传(任意非空字符串)
- [ ] **AC1.6** `buildPiCliArgs` 在 env 全空 → argv 含 `["--provider", "havefun-anthropic", "--model", "claude-sonnet-4-6"]`
- [ ] **AC1.7** `buildPiCliArgs` 在仅配 `LLM_MODEL` → argv 含 default provider + 用户 model
- [ ] **AC1.8** `buildPiCliArgs` 在都配 → argv 中 provider/model 等于用户值(不被覆盖)
- [ ] **AC1.9** `buildPiCliArgs` fallback 时 `console.log` 收到对应日志(用 vitest spy)

### AC2 · 集成验证

- [ ] 在 `xhgj003027/xhgj-iqs-ui` 复跑一次 reviewer(**故意不配** `LLM_PROVIDER` / `LLM_MODEL`),job trace 中应:
  - 看到 `[flower-providers] LLM_PROVIDER 未配置,fallback 到 "havefun-anthropic"` 日志
  - 看到对应 model fallback 日志
  - 后续 LLM 调用确实走 havefun 网关(可由 SIEM 端核对 endpoint host)

### AC3 · 旧行为兼容

- [ ] `getLLMProvider()` 缺省仍 throw(中文错误信息含合法值列表)
- [ ] `getLLMModel()` 缺省仍 throw
- [ ] `getDefaultModel()` 缺省仍 throw(ops-bot 路径不被影响)
- [ ] 现有所有 vitest 单测全过
- [ ] biome / tsc 干净

### AC4 · 文档

- [ ] `flower-providers/README.md` env 表加 fallback 注释
- [ ] `.trellis/spec/flower-providers/backend/index.md` 加节"CLI 路径 vs SDK 路径的缺省语义"

## 6. Risks

- ⚠️ **默认值选错伤所有未配 env 的接入方**:`havefun-anthropic + claude-sonnet-4-6` 的选择需要确认 havefun 网关确实开通了 anthropic 协议 + sonnet-4-6 model id 可用。**实施前先 curl 网关 `/v1/models` 验证一次**(若运维已封掉某个 protocol,需调整默认)。
- ⚠️ **日志噪音**:fallback 时打日志会让"忘配 env"的接入方一直看到提示,部分团队可能体验差。**mitigation**:用 `console.log`(info 级)而非 `console.warn`,避免被 SIEM 误报为告警;且只在 `buildPiCliArgs` 调用瞬间打 1-2 行,不进事件循环。
- ⚠️ **隐式默认 vs 显式配置的工程取向**:有些团队希望"缺 env 立刻报错",本任务的方向是"缺 env 自动兜底"。两条路都合理,本任务选后者**仅**因为 reviewer 是 opt-in 给业务方接入的 CI 工具,**降低接入门槛**优先于"显式配置文化"。**ops-bot 走另一条路**(`getDefaultModel` 仍 fail-fast)保留显式配置选项。

## 7. 关联任务

- 姊妹任务:`05-21-walkthrough-blocker-consistency`(同一天发现的 reviewer 问题,但走独立 PR)
- 上游任务:`05-19-flower-providers-fix-params-and-reasoning`(本包基线)
