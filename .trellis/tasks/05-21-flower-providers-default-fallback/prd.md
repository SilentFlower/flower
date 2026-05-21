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

`code-reviewer` 形态(走 `buildPiCliArgs` 路径)在 `LLM_PROVIDER` / `LLM_MODEL` / `LLM_REASONING_EFFORT` 缺省时,**自动 fallback 到 flower-providers 内置的合理默认值**,确保:
- `--provider <havefun-*>` 总是显式传给 pi CLI(永远不让 pi 走自己的内置 provider)
- `--model <havefun BUILTIN_MODELS 中存在的 id>` 总是显式传给 pi CLI
- `--thinking <effort>` 总是显式传给 pi CLI(避免 pi 内置 `medium` 默认)
- 三个值的默认 = **stress test 实测稳定组合**(`havefun-openai-responses + gpt-5.5 + high`),业务方零配置即拿到与生产对齐的行为
- LLM 调用**保证**走 havefun 网关 + 我们的 `LLM_API_KEY`

## 3. Requirements

### R1 · 默认值常量化

`flower-providers/src/env.ts` 顶部(贴近 `ALLOWED_REASONING_EFFORTS`)新增 3 个 export 常量:

```typescript
export const DEFAULT_LLM_PROVIDER: ProviderName = "havefun-openai-responses";
export const DEFAULT_LLM_MODEL = "gpt-5.5";
export const DEFAULT_LLM_REASONING_EFFORT: ModelThinkingLevel = "high";
```

选择理由(2026-05-21 用户决策,见 prd §0 + walkthrough-blocker-consistency §0):
- **stress test 实测稳定组合**:`xhgj003027/xhgj-iqs-ui` MR-2 pipeline 2127 / job 7552 用 `gpt-5.5 + high effort` 跑通了 5 文件 6 issue 的评审,这是当前生产侧已验证的"reviewer 推荐组合"。把它做成默认 → 业务方零配置即拿到与生产对齐的行为
- `havefun-openai-responses` + `gpt-5.5`:`BUILTIN_MODELS` 中已存在(catalog.ts:246-256)、`nativeApi: "openai-responses"` 与 provider 协议匹配、`baseUrl` 自动拼 `/v1`
- `DEFAULT_LLM_REASONING_EFFORT = "high"`:对应 `getDefaultReasoningEffort` per-model 表里 gpt-5.5=`xhigh` 的"次高档"。**不**选 xhigh 因为 high 已经是 stress 实测组合,xhigh 改成本/响应时间太激进,留给"显式想要"的项目
- **不选 claude-sonnet-4-6 + high**:虽然 sonnet 价格便宜、Anthropic 协议稳定,但与当前生产侧默认接入推荐(gpt-5.5)不一致,会让业务方默认行为偏离 stress test
- **不选 gpt-5.4 medium**:那是 pi 内置默认,正是本任务要消除的"侥幸路径"

### R2 · `buildPiCliArgs` 缺省时填默认 + 打日志

修改 `buildPiCliArgs(input)`:

- `LLM_PROVIDER` 缺省 → `DEFAULT_LLM_PROVIDER` + `console.log("[flower-providers] LLM_PROVIDER 未配置,fallback 到 \"<default>\"")`
- `LLM_MODEL` 缺省 → `DEFAULT_LLM_MODEL` + 同上格式日志
- `LLM_REASONING_EFFORT` 缺省 → `DEFAULT_LLM_REASONING_EFFORT` + 同上格式日志
- `--provider` / `--model` / `--thinking` argv **必然存在**,pi CLI 拿到的不再是空
- 每次调用最多打 3 行日志(provider / model / effort 各 1 行),不刷屏

### R3 · 不破坏 fail-fast 路径

`getLLMProvider()` / `getLLMModel()` / `getLLMReasoningEffort()` 当前**仍然按各自现有契约处理**(前两者缺省 throw;`getLLMReasoningEffort` 缺省返回 undefined,非法值 throw)。**本任务不动这三个函数**。

新增 3 个 helper(仍在 `env.ts` 里):
- `getLLMProviderOrDefault(): ProviderName` — 空 → DEFAULT_LLM_PROVIDER;非法值仍走 `getLLMProvider` 的 fail-fast(只对缺省值兜底,不对非法值兜底)
- `getLLMModelOrDefault(): string` — 空 → DEFAULT_LLM_MODEL;非空任意字符串透传,具体合法性由下游 `getMergedModels` 校验
- `getLLMReasoningEffortOrDefault(): ModelThinkingLevel` — 空 → DEFAULT_LLM_REASONING_EFFORT;非法值仍走 `getLLMReasoningEffort` 的 fail-fast

只在 `buildPiCliArgs` 内使用。

### R4 · 不影响 ops-bot

ops-bot 形态走 `getDefaultModel()` → 缺 env 仍 throw(服务常驻,部署时应显式配齐 env,**不应**用默认值带病运行)。本任务**只**对 CLI 路径加 fallback。

### R5 · CLI 路径 reasoning effort 也补默认(2026-05-21 用户决策扩范围)

`LLM_REASONING_EFFORT` 缺省时,`buildPiCliArgs` fallback 到 `DEFAULT_LLM_REASONING_EFFORT = "high"`,与 stress test 实测组合对齐。

- **CLI 路径**(`buildPiCliArgs`):env 缺省 → fallback 到 high(本任务新增)
- **SDK 路径**(`getDefaultReasoningEffort`,ops-bot 用):**完全不动**,仍按 env > per-model > global="high" 决定

理由:R1 把默认 model 改成 gpt-5.5 后,若 effort 仍由 pi 内置 medium 决定,业务方零配置实际跑的是 `gpt-5.5 + medium`,与 stress 用的 `gpt-5.5 + high` 不一致。统一三个值都 fallback,才能保证"零配置 = stress test 同款"。

### R6 · README + spec 同步

- `packages/flower-providers/README.md` env 表加注:"`LLM_PROVIDER` / `LLM_MODEL` / `LLM_REASONING_EFFORT` 缺省时 `buildPiCliArgs`(code-reviewer CLI 路径)fallback 到 `havefun-openai-responses` + `gpt-5.5` + `high`;`getDefaultModel` / `getDefaultReasoningEffort`(ops-bot 路径)仍 fail-fast / 走 per-model 默认"
- `.trellis/spec/flower-providers/backend/index.md` 加一节:CLI 路径 vs SDK 路径的缺省语义不同的原因(含 reasoning effort)

## 4. Out of Scope

- ❌ 修改 `getLLMProvider()` / `getLLMModel()` / `getLLMReasoningEffort()` 现有 throw 语义(本任务**不**改 env.ts 现有 throw 行为,只新增 OrDefault 变体)
- ❌ 给 `getDefaultModel()` / `getDefaultReasoningEffort()`(ops-bot 路径)加 fallback
- ❌ `LLM_BASE_URL` / `LLM_API_KEY` 缺省 fallback(基础设施凭据,缺省必须 fail-fast)
- ❌ harness 模板 / 业务方 `.gitlab-ci.yml` 改动(本任务在 flower-providers 内部解决)
- ❌ 修改 `PER_MODEL_DEFAULT_EFFORT` 表(ops-bot 路径 gpt-5.5=xhigh 不动,本任务只动 CLI 路径默认)

## 5. Acceptance Criteria

### AC1 · 单元测试(`packages/flower-providers/src/__tests__/`)

#### AC1.A · env.test.ts 新增(`OrDefault` 三件)

- [ ] **AC1.1** `getLLMProviderOrDefault()` 在 env 不配 → 返回 `"havefun-openai-responses"`
- [ ] **AC1.2** `getLLMProviderOrDefault()` 在 env=`havefun-anthropic` → 透传
- [ ] **AC1.3** `getLLMProviderOrDefault()` 在 env=非法值(如 `openai`)→ 仍 throw(沿用 fail-fast,**只对缺省兜底**)
- [ ] **AC1.4** `getLLMModelOrDefault()` 在 env 不配 → 返回 `"gpt-5.5"`
- [ ] **AC1.5** `getLLMModelOrDefault()` 在 env=`claude-opus-4-7` → 透传(任意非空字符串)
- [ ] **AC1.6** `getLLMReasoningEffortOrDefault()` 在 env 不配 → 返回 `"high"`
- [ ] **AC1.7** `getLLMReasoningEffortOrDefault()` 在 env=`xhigh` → 透传
- [ ] **AC1.8** `getLLMReasoningEffortOrDefault()` 在 env=非法值(如 `max`)→ 仍 throw

#### AC1.B · runtime.test.ts 改写现有 `buildPiCliArgs` case + 新增

- [ ] **AC1.9** `buildPiCliArgs` 在 env 全空 → argv 等于 `["-p", PROMPT, "--provider", "havefun-openai-responses", "--model", "gpt-5.5", "--thinking", "high"]`
- [ ] **AC1.10** `buildPiCliArgs` 在仅配 `LLM_MODEL=claude-opus-4-7` → argv 含 default provider + 用户 model + default effort
- [ ] **AC1.11** `buildPiCliArgs` 在三个 env 都配 → argv 中 provider/model/effort 等于用户值(不被覆盖)
- [ ] **AC1.12** `buildPiCliArgs` 在 `LLM_PROVIDER=invalid` → throw `/LLM_PROVIDER 非法值/`(语义从原"降级到只传 model"变为"显式 fail-fast")
- [ ] **AC1.13** `buildPiCliArgs` fallback 时 `console.log` 收到 3 行对应日志(用 `vi.spyOn(console, "log")`)

### AC2 · 集成验证

- [ ] 在 `xhgj003027/xhgj-iqs-ui` 复跑一次 reviewer(**故意不配** `LLM_PROVIDER` / `LLM_MODEL` / `LLM_REASONING_EFFORT`),job trace 中应:
  - 看到 `[flower-providers] LLM_PROVIDER 未配置,fallback 到 "havefun-openai-responses"` 日志
  - 看到 `[flower-providers] LLM_MODEL 未配置,fallback 到 "gpt-5.5"` 日志
  - 看到 `[flower-providers] LLM_REASONING_EFFORT 未配置,fallback 到 "high"` 日志
  - 后续 LLM 调用确实走 havefun 网关(可由 SIEM 端核对 endpoint host)
  - 评审输出质量与 stress test(pipeline 2127 / job 7552 显式配 gpt-5.5+high)等价

### AC3 · 旧行为兼容

- [ ] `getLLMProvider()` 缺省仍 throw(中文错误信息含合法值列表)
- [ ] `getLLMModel()` 缺省仍 throw
- [ ] `getLLMReasoningEffort()` 缺省仍返回 undefined / 非法值仍 throw
- [ ] `getDefaultModel()` 缺省仍 throw(ops-bot 路径不被影响)
- [ ] `getDefaultReasoningEffort()` 行为完全不变(env > per-model > "high")
- [ ] 现有所有 vitest 单测全过(改写完 4 个 buildPiCliArgs 现有 case 后,加上 13 个新 case,总数从 149 → ~158)
- [ ] biome / tsc 干净

### AC4 · 文档

- [ ] `flower-providers/README.md` env 表加 fallback 注释
- [ ] `.trellis/spec/flower-providers/backend/index.md` 加节"CLI 路径 vs SDK 路径的缺省语义"

## 6. Risks

- ⚠️ **默认值选错伤所有未配 env 的接入方**:`havefun-openai-responses + gpt-5.5 + high` 的选择需要确认 havefun 网关确实开通了 openai-responses 协议 + gpt-5.5 model id 可用。**实施前先 curl 网关 `POST /v1/responses` 验证一次**(若运维已封掉该 protocol 或 model 下线,需调整默认)。stress test 在 2026-05-21 已用此组合跑通,网关侧支持目前确定。
- ⚠️ **gpt-5.5 + high 成本/响应时间高于 sonnet-4-6 + high**:gpt-5.5 reasoning summary 模式比 sonnet 慢一些。**mitigation**:若有"成本敏感型"接入方,显式配 `LLM_PROVIDER=havefun-anthropic` + `LLM_MODEL=claude-sonnet-4-6` 即可覆盖,默认成本由 reviewer "推荐组合"的产品定位决定(stress 实测稳定 > 单点最便宜)。
- ⚠️ **日志噪音**:fallback 时打 3 行 `console.log`(provider/model/effort 各 1 行)会让"忘配 env"的接入方一直看到提示,部分团队可能体验差。**mitigation**:用 `console.log`(info 级)而非 `console.warn`,避免被 SIEM 误报为告警;且只在 `buildPiCliArgs` 调用瞬间打 3 行,不进事件循环。
- ⚠️ **隐式默认 vs 显式配置的工程取向**:有些团队希望"缺 env 立刻报错",本任务的方向是"缺 env 自动兜底"。两条路都合理,本任务选后者**仅**因为 reviewer 是 opt-in 给业务方接入的 CI 工具,**降低接入门槛**优先于"显式配置文化"。**ops-bot 走另一条路**(`getDefaultModel` 仍 fail-fast)保留显式配置选项。
- ⚠️ **`buildPiCliArgs` 现有"非法 provider 降级"行为消失**:当前实测路径下,`LLM_PROVIDER` 被配成非法值会"吃错降级到只传 --model"。改后会 throw `LLM_PROVIDER 非法值`。这其实是行为修正(显式错误优于隐式),但 commit message 要明确写 BREAKING-NOTE 提醒接入方。

## 7. 关联任务

- 姊妹任务:`05-21-walkthrough-blocker-consistency`(同一天发现的 reviewer 问题,但走独立 PR)
- 上游任务:`05-19-flower-providers-fix-params-and-reasoning`(本包基线)
