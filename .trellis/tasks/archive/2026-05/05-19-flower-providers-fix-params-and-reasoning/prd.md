# flower-providers: 修真实模型参数 + 接入 reasoning effort 抽象

## Goal

修正 `BUILTIN_MODELS` 中 8 个模型的占位 `contextWindow` / `maxTokens` 为联网核实的真实值;同时接入 pi-ai 的 thinking / reasoning effort 抽象 — 给每个 model 声明 `thinkingLevelMap`(把 pi 统一的 5 级映射到 provider 自家实际 effort 字符串 / budget 数字),并新增 env `LLM_REASONING_EFFORT` 让运维统一调节"思考预算"。

完成后:
- 调用方按 token 数算上下文窗口时不会再被错值误导
- ops-bot / code-reviewer 可在 env 一处控制全 provider 的思考预算,默认"拉到该 model 实际上限"
- Anthropic Opus 4.7 的 `max` effort(pi 抽象层默认拿不到)能通过 thinkingLevelMap 接入

## Background / Known Context

### 真实模型参数(联网核实 + 用户校正)

| 模型 | contextWindow | maxTokens | reasoning |
|---|---|---|---|
| `claude-opus-4-7` | 1,000,000 | 128,000 | true |
| `claude-sonnet-4-6` | 1,000,000 | 64,000 | true(adaptive thinking) |
| `claude-haiku-4-5-20251001` | 200,000 | 64,000 | **false**(官方文档不提 extended thinking)|
| `gemini-2.5-pro` | 1,048,576 | 65,536 | true |
| `gemini-2.5-flash` | 1,048,576 | 65,535 | true |
| `gemini-2.5-flash-lite` | 1,048,576 | 65,535 | false(轻量) |
| `gpt-5.4` | 1,050,000 | 128,000 | true |
| `gpt-5.5` | **400,000**(网关走 Codex 模式) | 128,000 | true |

### pi-ai thinking 抽象层关键事实

- `ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh"` — pi 统一 5 级,**无 max**
- `ModelThinkingLevel = "off" | ThinkingLevel` — 6 个状态
- `ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>` — 每个 model 可声明把 pi level 映射到自家实际值;null = 不支持
- `ProviderModelConfig` 和 `Model<Api>` 都有 `thinkingLevelMap?: ThinkingLevelMap` 字段

### pi 默认行为(没 thinkingLevelMap 时)

- Anthropic `mapThinkingLevelToEffort`:`xhigh` 走 default 分支 → `"high"`(降级!);**默认拿不到 max / xhigh**
- Google `getGoogleBudget`:按 effort 算 budget(具体数字看 pi 内部默认表)
- OpenAI Responses:直接发 reasoningEffort 字段(若 thinkingLevelMap 未覆盖)

### Anthropic 官方事实

- **Opus 4.7**:effort 范围 `low / medium / high / xhigh / max`,原话 "xhigh sits between high and max" → **最高是 max**
- **Sonnet 4.6**:支持 adaptive thinking + effort 字符串(具体支持哪些 effort 文档未列);budget_tokens 已废弃
- **Haiku 4.5**:官方文档**不提**支持 extended thinking → `reasoning: false` 跳过 thinking 路径
- **pi-ai anthropic.js:544 注释("max only Opus 4.6")已过时**,与 Anthropic 现行文档冲突

### 已知问题(本任务修)

1. `catalog.ts` 8 模型的 `contextWindow` / `maxTokens` 大多错(前任务 ADR-4 注释明说"GPT 系列 128K+16K 占位")
2. `BuiltinModelEntry` 缺 `thinkingLevelMap` 字段 → `buildHavefunModel` / `toProviderModelConfig` 不传给 pi → pi 用默认 mapping,Opus 4.7 拿不到 max
3. `claude-haiku-4-5-20251001.reasoning` 当前为 true 是错的
4. 没有 env 让运维统一调节 effort/budget

## Decisions (ADR-lite)

### ADR-1:thinkingLevelMap 精简到 1 key(pi 最高 → provider 实际最高)

- **Context**:pi `ThinkingLevel` 没 max(经 pi-ai 0.75.3 源码确认是 deliberate 设计,max 是 anthropic 专有,放进 5 provider 共用的抽象层会污染语义),但 Opus 4.7 实际最高是 max。pi 官方解决方案就是 `thinkingLevelMap`。
- **Decision**:对 Opus 4.7 声明 `thinkingLevelMap: { xhigh: "max" }` —— **只 override 唯一与 pi 默认不一致的那个 level**。其他 level(low/medium/high/minimal)缺省,由 pi-ai `mapThinkingLevelToEffort`(`node_modules/.../providers/anthropic.js:546-561`)的 switch fallback 自动恒等映射。
  - 不写 6-key 的原因:5 个恒等 key 是噪音,且 PRD 早期写的 `minimal: null` 在 pi 实际行为下与"不声明"完全一致(`typeof null !== "string"` → 走 switch fallback)
- **Consequences**:
  - 优:信号面缩到 1 行,意图自解释;升级面最小(若 pi 上游加 max level,只需删这一行)
  - 劣:pi 抽象层失去 1 级粒度(xhigh 和 high 之间隔了 max 一级)— 可接受,真要精细绕过 pi 抽象直传 effort(方案 G,代价大,本任务不采纳)

### ADR-2:Haiku 4.5 `reasoning: false`

- **Context**:Anthropic 官方 extended-thinking 页面未列 Haiku 4.5;且明确说 Haiku 模型上 thinking blocks 会被从上下文移除。
- **Decision**:`reasoning: false`,不声明 thinkingLevelMap。
- **Consequences**:用户配 Haiku 时,pi 走 `!options.reasoning` 分支,纯回复。

### ADR-3:Sonnet 4.6 按 pi 默认 thinkingLevelMap(不显式覆盖)

- **Context**:Anthropic 官方未列 Sonnet 4.6 支持哪些 effort 字符串。pi 默认 mapping 把 `xhigh` 降级到 `"high"`,这至少不会 4xx。
- **Decision**:Sonnet 4.6 不声明 thinkingLevelMap,走 pi 默认。实际最高拿到 `effort: "high"`。
- **Consequences**:若后续实测 Sonnet 也支持 xhigh / max,再补 thinkingLevelMap(Out of Scope)。

### ADR-4:Gemini 用 thinkingBudgets 数字阶梯(经 streamFn 注入)

- **Context**:Gemini 的 thinking 控制是 `budgetTokens` 数字,不是 effort 字符串。pi 提供 `options.thinkingBudgets: { minimal, low, medium, high }`,在 streamFn 内层注入。
- **Decision**:Gemini 系列不声明 thinkingLevelMap;由 ops-bot streamFn 按 model 注入 thinkingBudgets。具体阶梯(初版):

| 模型 | minimal | low | medium | high(也是 xhigh 上限) |
|---|---|---|---|---|
| Pro | 1024 | 4096 | 16384 | 24576 |
| Flash | 1024 | 4096 | 16384 | 24576 |
| Flash Lite | — | — | — | — (reasoning=false) |

- **Consequences**:Gemini 的"effort 到 budget"映射在 streamFn 里硬编码;后续实测可调阶梯。
- **Implement 阶段验证点**:看 pi google.js 是否支持从 thinkingLevelMap 读 budget 字符串(若可,则用 thinkingLevelMap 统一抽象;若否,坚持 thinkingBudgets 注入)。**实测结果(pi-ai 0.75.3 google.js:367)**:不查 thinkingLevelMap,只查 `customBudgets[effort]` + 内置表;且 `ThinkingBudgets` 类型只有 4 键,内置表也只到 high,**没有 xhigh 通道**。
- **Gemini xhigh 边缘 case**:若运维配 `LLM_REASONING_EFFORT=xhigh`,gemini 会拿到 undefined budget(行为未定义)。**修复**:ops-bot streamFn 在 gemini 路径(`model.api === "google-generative-ai"`)上把 `xhigh` clamp 到 `high`,稳定落在 `GEMINI_BUDGETS_BY_MODEL` 的 high 阶梯。

### ADR-5:新 env `LLM_REASONING_EFFORT`(用 OpenAI 命名风格)

- **Context**:运维需要一个统一开关调"思考预算"。pi 抽象叫 ThinkingLevel,OpenAI Responses 叫 reasoningEffort。选 OpenAI 风格(更广为人知)。
- **Decision**:
  - 新增 env `LLM_REASONING_EFFORT`(可选)
  - 合法值:`off / minimal / low / medium / high / xhigh`(pi 6 级)
  - 不配置 → fallback per-model 默认(下表)
  - 配置非法 → fail-fast,列出合法集

**Per-model 默认推荐**(env 不配时拉到该 model 实际上限):

| 模型 | 默认 effort | 实际效果 |
|---|---|---|
| claude-opus-4-7 | `xhigh` | → effort `max`(经 thinkingLevelMap) |
| claude-sonnet-4-6 | `high` | → effort `"high"`(pi 默认) |
| claude-haiku-4-5-20251001 | `off` | 实际跳过 thinking(reasoning=false) |
| gemini-2.5-pro | `high` | budget 24576 |
| gemini-2.5-flash | `high` | budget 24576 |
| gemini-2.5-flash-lite | `off` | reasoning=false |
| gpt-5.4 | `xhigh` | reasoningEffort `"xhigh"` |
| gpt-5.5 | `xhigh` | reasoningEffort `"xhigh"` |

### ADR-6:新公开 API `getDefaultReasoningEffort(modelId?)`

- **Context**:ops-bot 的 streamFn 需要把 effort 注入 streamSimple 选项。
- **Decision**:新增 `getDefaultReasoningEffort(modelId?: string): ModelThinkingLevel`
  - env > per-model 默认 > 全局 fallback `"high"`
  - 传 modelId 时,model 在 BUILTIN_MODELS / extras 中找;找不到走全局 fallback
- 说明:**code-reviewer 形态不调本函数** — pi 自己管 thinking level(通过 /thinking 命令 / config)
- ops-bot 形态 streamFn 调用 `getDefaultReasoningEffort(model.id)` → 转成 pi `options.reasoning`

## Requirements

### R1:更新 BUILTIN_MODELS 8 模型真实参数

按 Background 表格更新:contextWindow / maxTokens / reasoning(Haiku 改 false,Flash Lite 改 false)。

### R2:`BuiltinModelEntry` 加 thinkingLevelMap 字段

- 新增 `thinkingLevelMap?: ThinkingLevelMap`(从 pi-ai import)
- Opus 4.7 显式声明 `{ xhigh: "max" }`(ADR-1 精简版 — 仅 override 与 pi 默认不一致的 level)
- 其他 model 留空(走 pi 默认)
- `LLM_EXTRA_MODELS_JSON` 注入的 model 也允许带 thinkingLevelMap 字段(env.ts:getExtraModels 透传)

### R3:新 env `LLM_REASONING_EFFORT`

- `env.ts:getLLMReasoningEffort(): ModelThinkingLevel | undefined`
- 缺失返回 undefined,非法值 fail-fast(消息列出 6 个合法值)
- 加入 `.env.example`

### R4:新公开 API `getDefaultReasoningEffort(modelId?)`

- `runtime.ts:getDefaultReasoningEffort(modelId?: string): ModelThinkingLevel`
- 实现:env 优先 → per-model 默认表(ADR-5)→ 全局 fallback `"high"`
- 通过 `index.ts` re-export

### R5:`buildHavefunModel` + `toProviderModelConfig` 透传 thinkingLevelMap

- `runtime.ts:buildHavefunModel`:Model 对象 spread `thinkingLevelMap`(若 entry 有)
- `register.ts:toProviderModelConfig`:同步 spread

### R6:ops-bot agent-factory.ts streamFn 接入 effort

- 加 `import { getDefaultReasoningEffort } from "@flower-ai/flower-providers"`
- streamSimple options:`reasoning: getDefaultReasoningEffort(model.id)`(off → undefined 传)
- Gemini model 的 thinkingBudgets 注入由 streamFn 内部按 model.id 判断(初版 hardcode ADR-4 阶梯,后续可移到 flower-providers 公开 API)

### R7:单元测试同步

- `catalog.test.ts`:新参数断言 + Opus 4.7 thinkingLevelMap.xhigh === "max" + Haiku 4.5 reasoning === false
- `env.test.ts`:LLM_REASONING_EFFORT 6 个合法 / 非法 case
- `runtime.test.ts`:`getDefaultReasoningEffort` 矩阵(env 不配 + env 配 + 各 model fallback)
- `register.test.ts`:断言注册到 pi 的 model.thinkingLevelMap 与 builtin 一致(Opus 4.7 有,其他没)

### R8:文档同步

- `packages/flower-providers/README.md`:新 env + 新 API + 默认 effort 表
- `.env.example`:`LLM_REASONING_EFFORT=xhigh` 示例
- `.trellis/spec/flower-providers/backend/error-handling.md`:fail-fast 矩阵加 1 条
- `.trellis/spec/guides/debugging-llm-integration.md`:加反面案例 "pi-ai anthropic.js:544 注释过时 — 信官方文档,不信中间层 SDK 注释"

## Acceptance Criteria

- [ ] **AC1**:`npm run build` / `typecheck` / `check` / `test` 全过
- [ ] **AC2**:`BUILTIN_MODELS` 8 模型 contextWindow / maxTokens / reasoning 与 Background 表格一致
- [ ] **AC3**:`buildHavefunModel("havefun-anthropic", "claude-opus-4-7")` 返回的 Model 含 `thinkingLevelMap.xhigh === "max"`
- [ ] **AC4**:`getDefaultReasoningEffort()` 无参 + env 不配 → `"high"`;`getDefaultReasoningEffort("claude-opus-4-7")` env 不配 → `"xhigh"`;`getDefaultReasoningEffort("claude-haiku-4-5-20251001")` env 不配 → `"off"`;`LLM_REASONING_EFFORT=low` 时三种调用都返回 `"low"`
- [ ] **AC5**:`LLM_REASONING_EFFORT=foo` → fail-fast,错误信息列出 6 个合法值
- [ ] **AC6**:ops-bot `agent-factory.ts:streamFn` 调用 streamSimple 时包含 `reasoning` 字段(off 时为 undefined)
- [ ] **AC7**(可选,需新 key):端到端 smoke 5 case 全过,且通过抓包确认请求 payload 含正确的 anthropic effort / openai reasoningEffort / google thinkingBudget
- [ ] **AC8**:`packages/flower-providers/README.md` + `.env.example` + 2 个 spec 文件按 R8 更新

## Definition of Done

- AC1-AC8 全勾(AC7 可延后)
- 新公开 API 有 JSDoc 中文注释
- pi-ai 文档过时事实记入 spec/guides(institutional memory)

## Out of Scope

- **Sonnet 4.6 / Haiku 4.5 的 max 实证测试**:本任务按 pi 默认,后续 follow-up
- **Gemini budget 阶梯精细调优**:本任务用 ADR-4 初版阶梯,后续实测后调
- **pi 抽象层加 `max` level**:这是 pi-ai 上游的事,本任务通过 thinkingLevelMap 绕开
- **code-reviewer 形态的 reasoning 接入**:由 pi CLI 自己管
- **Gemini thinkingBudgets 提取到公开 API**:本任务在 ops-bot streamFn 内 hardcode,后续可重构

## Research References

- Anthropic 官方:[Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- Anthropic 官方:[What's new in Opus 4.7](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)
- pi-ai 源码:
  - `node_modules/@earendil-works/pi-ai/dist/types.d.ts`(ThinkingLevel / ThinkingLevelMap)
  - `.../providers/anthropic.{d.ts,js}`(mapThinkingLevelToEffort + supportsAdaptiveThinking)
  - `.../providers/google.js`(getGoogleBudget + thinking config)
  - `.../providers/openai-responses.js`(reasoningEffort + thinkingLevelMap lookup)
- 前任务沉淀:`.trellis/spec/guides/debugging-llm-integration.md`(本任务会扩充)
