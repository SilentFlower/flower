# 技术设计:修真实模型参数 + 接入 reasoning effort 抽象

> 配套 `prd.md`。聚焦类型变化 / 数据流 / 跨层契约 / 失败处理。

## 模块改动概览

```
packages/flower-providers/src/
├── catalog.ts          # ⚠️ 改 8 模型数据 + 加 thinkingLevelMap 字段
├── env.ts              # ⚠️ 新增 getLLMReasoningEffort + extras JSON 透传 thinkingLevelMap
├── runtime.ts          # ⚠️ 新增 getDefaultReasoningEffort + buildHavefunModel spread thinkingLevelMap
├── register.ts         # ⚠️ toProviderModelConfig spread thinkingLevelMap
└── index.ts            # ⚠️ re-export getDefaultReasoningEffort + ModelThinkingLevel 类型
└── __tests__/*.ts      # ⚠️ 同步测试断言

packages/flower-ops-bot/src/
└── agent-factory.ts    # ⚠️ streamFn 注入 reasoning + thinkingBudgets(Gemini)
```

## 类型契约变化

### `BuiltinModelEntry` 加新字段

```typescript
import type { Api, ThinkingLevelMap } from "@earendil-works/pi-ai";

export interface BuiltinModelEntry {
  // 既有字段不变...
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  nativeApi: Api;
  // 新增:
  /**
   * 把 pi 统一的 ThinkingLevel 映射到该 model 自家实际 effort/budget 字符串。
   * 不声明则走 pi 默认 mapping(可能降级,见 PRD ADR-1)。
   */
  thinkingLevelMap?: ThinkingLevelMap;
}
```

### 新公开 API

```typescript
// 从 pi-ai re-export 类型
export type { ModelThinkingLevel } from "@earendil-works/pi-ai";

// 新函数(取代不存在的"per-model 默认 effort"决策)
export function getDefaultReasoningEffort(modelId?: string): ModelThinkingLevel;
```

## 数据流

### 启动期(register.ts)

```
registerHavefunProviders(pi, { appSource })
  for each providerName ∈ 4 个:
    filteredModels = mergedModels.filter(nativeApi 匹配)
    for each m of filteredModels:
      toProviderModelConfig(m) = {
        id, name, reasoning, input, cost, contextWindow, maxTokens,
        thinkingLevelMap: m.thinkingLevelMap,  // ← 新增,可能 undefined
      }
    pi.registerProvider(providerName, { baseUrl, apiKey, api, models, headers })
```

pi 启动后,模型清单里 model.thinkingLevelMap 由 pi 内部决定 effort/budget(anthropic.js 显式查、openai-responses.js 显式查、google.js 不查走 budgets)。

### 运行期 ops-bot(agent-factory.ts)

```
pickModel() → { provider, modelId } via getDefaultModel()
            → buildHavefunModel(provider, modelId)
                Model<Api> 对象,含 thinkingLevelMap(若 entry 有)
            ▼
new Agent({ model, streamFn })
            ▼
streamFn 被 pi 调用时:
  effort = getDefaultReasoningEffort(model.id)   // env 优先 → per-model 默认
  thinkingBudgets = computeGeminiBudgets(model.id, effort)  // 仅 Gemini 需要(可 undefined)
  return streamSimple(model, ctx, {
    ...opts,
    apiKey: process.env.LLM_API_KEY,
    reasoning: effort === "off" ? undefined : effort,
    thinkingBudgets,
  })
            ▼
pi-ai streamSimple 内部:
  - Anthropic:if (options.reasoning) → mapThinkingLevelToEffort(model, options.reasoning)
    → 优先 model.thinkingLevelMap[options.reasoning] → 否则降级 default
  - OpenAI Responses:if (options.reasoning) → clampThinkingLevel(model, options.reasoning)
    → params.reasoning.effort = model.thinkingLevelMap[level] ?? level
  - Google:if (options.reasoning) → getGoogleBudget(model, effort, options.thinkingBudgets)
    → 优先 thinkingBudgets,否则 pi 内部默认表
```

### 关键不变量

1. **thinkingLevelMap 是声明式的**:catalog.ts 写一次,4 个数据流(register / buildHavefunModel / streamFn / pi-ai 内部)都会读到
2. **env.LLM_REASONING_EFFORT 是单一开关**:覆盖所有 model 的"默认 effort";per-model 默认仅在 env 缺省时使用
3. **Gemini 特殊**:budget 数字必须由 streamFn 注入 `thinkingBudgets`(pi google.js 不查 thinkingLevelMap),其他 3 个 provider 走 thinkingLevelMap

## 兼容性

### 破坏性变更

| 旧 API / 行为 | 新 API / 行为 | 处理 |
|---|---|---|
| `claude-haiku-4-5-20251001.reasoning: true` | `false` | 若有调用方依赖此 model 走 thinking 路径,会变成纯回复(实际无下游) |
| `BUILTIN_MODELS.contextWindow / maxTokens` 占位值 | 真实值 | 若下游做"按 contextWindow 计算可塞多少 token"的逻辑,新值会扩大可塞量(不破坏) |
| 无 `LLM_REASONING_EFFORT` env | 新增可选 env | 不配置时走 per-model 默认,与原有行为兼容(没有"原有行为",原本就没接 thinking) |
| 无 `getDefaultReasoningEffort` API | 新增公开函数 | 向后兼容(纯新增) |

### 非破坏性变更

- ops-bot streamFn 加 `reasoning` 字段:**如果 model 不支持 thinking**(pi 内部检查 `model.reasoning`),pi-ai 会自动忽略 — 安全
- `register.ts` 透传 thinkingLevelMap:pi 接受这个字段,不会破坏既有调用

## 失败处理

### Fail-fast 矩阵(新增)

| 触发条件 | 错误信息 |
|---|---|
| `LLM_REASONING_EFFORT` 非法值 | `LLM_REASONING_EFFORT 非法值 "<x>":合法值:off / minimal / low / medium / high / xhigh` |

其他 env / runtime 错误沿用前任务的失败处理矩阵(error-handling.md)。

### 运行期失败

- **pi-ai 内部 effort 不被 provider 接受**(如发了 xhigh 给不支持的 model):pi 会 4xx,本包不拦截
- **Gemini budget 超过 maxTokens**:pi google.js 内部 clamp,不报错

## 测试策略

### 单元测试

| 文件 | 新增 case |
|---|---|
| catalog.test.ts | 8 模型 contextWindow / maxTokens 断言;Opus 4.7 thinkingLevelMap.xhigh === "max";Haiku 4.5 reasoning === false |
| env.test.ts | LLM_REASONING_EFFORT 6 个合法值各 1;1 个非法值 fail-fast |
| runtime.test.ts | getDefaultReasoningEffort 矩阵:env 不配 8 model 各 1 + env 配 1 + 全局 fallback |
| register.test.ts | 断言 Opus 4.7 注册到 pi 时 model.thinkingLevelMap 等于 builtin 声明;其他 model 该字段 undefined |

### 端到端(AC7,可选)

复用前任务的 `scripts/smoke-gateway.ts`(已 archive),改一下使用新的 reasoning 字段。验证项:
- Opus 4.7 请求 payload 实际带 `effort: "max"`
- GPT-5.5 / 5.4 请求带 `reasoning.effort: "xhigh"`
- Gemini 请求带 `thinking.budgetTokens: 24576`
- Haiku 4.5 不带 thinking 字段

需要新 key 才跑;不强制本任务做完(默认延后)。

## Rollout / Rollback

- 改动只触及 flower-providers 与 ops-bot/agent-factory.ts,无 DB / 无在跑服务
- 部署需要新增可选 env `LLM_REASONING_EFFORT`(不加则走 per-model 默认 = 拉到最高)
- Rollback:`git revert` 即可

## 风险与开放项

| 风险 | 缓解 |
|---|---|
| Sonnet 4.6 实际不接受 pi 默认 "high"(可能要别的字符串) | brainstorm 时按 pi 默认,AC7 真跑时如果 4xx 则在 thinkingLevelMap 显式覆盖 |
| Gemini budget 阶梯不合实际(过高或过低) | 初版 24576 顶格,实测后调;不阻塞本任务 |
| `LLM_REASONING_EFFORT` env 命名与未来其他 env(如 `LLM_TEMPERATURE`)风格不一 | 本任务定个先例:用 `LLM_<参数名>` 模式 |
| ops-bot streamFn 的 Gemini budget 注入 hardcode 在 agent-factory.ts(违反"配置只在 flower-providers"原则) | 标记为 Out of Scope 的重构点,初版接受;真要重构在后续任务 |
