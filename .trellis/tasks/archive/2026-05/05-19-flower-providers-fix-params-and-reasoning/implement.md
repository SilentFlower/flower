# 执行计划:修真实模型参数 + 接入 reasoning effort 抽象

> 配套 `prd.md` + `design.md`。每步给出动作 + 验证 + 完成判据。

## Implementation Checklist

### Step 1 — `catalog.ts`:更新 8 模型真实参数 + 加 thinkingLevelMap 字段

- [ ] 在 import 一行加 `type ThinkingLevelMap` from "@earendil-works/pi-ai"
- [ ] `BuiltinModelEntry` 接口加 `thinkingLevelMap?: ThinkingLevelMap`(注释见 design.md)
- [ ] 按 PRD Background 表格更新 8 模型的 contextWindow / maxTokens / reasoning:
  - claude-opus-4-7: 1_000_000 / 128_000 / reasoning: true(不变)+ 加 thinkingLevelMap `{ off:"off", minimal:null, low:"low", medium:"medium", high:"high", xhigh:"max" }`
  - claude-sonnet-4-6: 1_000_000 / 64_000 / reasoning: true(不变,无 thinkingLevelMap)
  - claude-haiku-4-5-20251001: 200_000 / 64_000 / **reasoning: false**(从 true 改),无 thinkingLevelMap
  - gemini-2.5-pro: 1_048_576 / 65_536(不变)
  - gemini-2.5-flash: 1_048_576 / 65_535(maxTokens 微调)
  - gemini-2.5-flash-lite: 1_048_576 / 65_535 / **reasoning: false**(从 true 改)
  - gpt-5.4: 1_050_000 / 128_000(从 128K/16K 大改)
  - gpt-5.5: **400_000** / 128_000(从 128K/16K 大改)
- **验证**:`npm run build -w @flower-ai/flower-providers` 通过
- **完成判据**:`catalog.ts` 各 model 数据与 PRD 表格逐项一致

### Step 2 — `env.ts`:新增 LLM_REASONING_EFFORT + extras JSON 透传 thinkingLevelMap

- [ ] import `type ModelThinkingLevel`(从 pi-ai)
- [ ] 定义常量 `ALLOWED_REASONING_EFFORTS: readonly ModelThinkingLevel[] = ["off","minimal","low","medium","high","xhigh"]`
- [ ] 新函数 `getLLMReasoningEffort(): ModelThinkingLevel | undefined`:
  - env 缺失 → undefined(fallback 在 runtime 层接手)
  - 非法值 → throw `LLM_REASONING_EFFORT 非法值 "<x>":合法值:${ALLOWED_REASONING_EFFORTS.join(" / ")}`
- [ ] `getExtraModels()` 中允许透传 `thinkingLevelMap` 字段:在循环里加 `thinkingLevelMap: obj.thinkingLevelMap as ThinkingLevelMap | undefined`(不做深度校验,信任用户)
- **验证**:`npm run test -w @flower-ai/flower-providers` 通过(env.test.ts 新加 case 后)
- **完成判据**:env.ts 改动局限于上述 3 处

### Step 3 — `runtime.ts`:新增 `getDefaultReasoningEffort` + buildHavefunModel spread thinkingLevelMap

- [ ] import 顺序 + 加 `getLLMReasoningEffort`(从 env.js)
- [ ] 定义 per-model 默认表(模块级常量,不导出):
  ```typescript
  const PER_MODEL_DEFAULT_EFFORT: Record<string, ModelThinkingLevel> = {
    "claude-opus-4-7": "xhigh",
    "claude-sonnet-4-6": "high",
    "claude-haiku-4-5-20251001": "off",
    "gemini-2.5-pro": "high",
    "gemini-2.5-flash": "high",
    "gemini-2.5-flash-lite": "off",
    "gpt-5.4": "xhigh",
    "gpt-5.5": "xhigh",
  };
  const GLOBAL_FALLBACK_EFFORT: ModelThinkingLevel = "high";
  ```
- [ ] 公开函数 `getDefaultReasoningEffort(modelId?: string): ModelThinkingLevel`:
  - `const fromEnv = getLLMReasoningEffort()`,有则直接返回
  - 否则 `modelId ? PER_MODEL_DEFAULT_EFFORT[modelId] ?? GLOBAL_FALLBACK_EFFORT : GLOBAL_FALLBACK_EFFORT`
- [ ] `buildHavefunModel`:在 result 对象 spread `...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {})`(避免显式 undefined 污染对象)
- **验证**:`npm run test -w @flower-ai/flower-providers` 通过
- **完成判据**:runtime.ts 改动包含 1 个新函数 + buildHavefunModel 1 行 spread

### Step 4 — `register.ts`:`toProviderModelConfig` 透传 thinkingLevelMap

- [ ] 在返回对象加 `...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {})`
- **验证**:`npm run test -w @flower-ai/flower-providers` 通过
- **完成判据**:register.test.ts 断言 Opus 4.7 注册时 thinkingLevelMap 存在

### Step 5 — `index.ts`:re-export 新公开 API

- [ ] 在末尾加 `export { getDefaultReasoningEffort } from "./runtime.js";`
- [ ] 加 `export type { ModelThinkingLevel } from "@earendil-works/pi-ai";`(转手 re-export 方便下游用)
- **验证**:`npm run build -w @flower-ai/flower-providers` 后 `dist/index.d.ts` 含新 export
- **完成判据**:index.ts ≤ 8 行

### Step 6 — 同步 4 个单元测试

- [ ] `catalog.test.ts`:
  - 改 contextWindow / maxTokens 断言为新值(若旧 case 断言这些字段)
  - 加 case "Opus 4.7 thinkingLevelMap.xhigh === 'max'"
  - 加 case "Haiku 4.5 reasoning === false"
  - 加 case "Flash Lite reasoning === false"
- [ ] `env.test.ts`:
  - getLLMReasoningEffort 6 个合法值各 1 case
  - 非法值 fail-fast,断言错误信息含 6 个合法值
  - 缺失值返回 undefined
- [ ] `runtime.test.ts`:
  - getDefaultReasoningEffort:
    - env 不配 + 不传 modelId → "high"
    - env 不配 + 传 "claude-opus-4-7" → "xhigh"
    - env 不配 + 传 "claude-haiku-4-5-20251001" → "off"
    - env 不配 + 传 "unknown-id" → "high"(全局 fallback)
    - env = "low" + 传 "claude-opus-4-7" → "low"(env 优先)
  - buildHavefunModel:
    - Opus 4.7 返回的 Model 含 thinkingLevelMap
    - Sonnet 4.6 返回的 Model 不含 thinkingLevelMap 字段(undefined or absent)
- [ ] `register.test.ts`:
  - 注册到 pi 的 Opus 4.7 config.thinkingLevelMap 等于 catalog 声明
  - Sonnet 4.6 config.thinkingLevelMap 为 undefined
- **验证**:`npm run test --workspaces --if-present` 全过
- **完成判据**:测试数从 62 → 80+(估算新增 18-20 个 case)

### Step 7 — ops-bot agent-factory.ts:streamFn 注入 reasoning + Gemini budget

- [ ] import `getDefaultReasoningEffort`(从 @flower-ai/flower-providers)
- [ ] 定义模块级常量(在文件顶部或 streamFn 上方):
  ```typescript
  const GEMINI_BUDGETS_BY_MODEL: Record<string, { minimal?: number; low?: number; medium?: number; high?: number }> = {
    "gemini-2.5-pro": { minimal: 1024, low: 4096, medium: 16384, high: 24576 },
    "gemini-2.5-flash": { minimal: 1024, low: 4096, medium: 16384, high: 24576 },
  };
  ```
- [ ] 改 streamFn:
  ```typescript
  streamFn: async (model, context, options) => {
    const effort = getDefaultReasoningEffort(model.id);
    const reasoning = effort === "off" ? undefined : effort;
    const thinkingBudgets = GEMINI_BUDGETS_BY_MODEL[model.id];
    return streamSimple(model, context, {
      ...options,
      apiKey: process.env.LLM_API_KEY ?? "",
      reasoning,
      ...(thinkingBudgets ? { thinkingBudgets } : {}),
    });
  },
  ```
- **验证**:`npm run typecheck -w @flower-ai/flower-ops-bot` + `npm run build -w @flower-ai/flower-ops-bot`
- **完成判据**:agent-factory.ts streamFn 内有 reasoning + thinkingBudgets 两条新逻辑

### Step 8 — 文档同步

- [ ] `packages/flower-providers/README.md`:
  - 公开 API 表加 `getDefaultReasoningEffort(modelId?)` 行 + `ModelThinkingLevel` 类型
  - env 表加 `LLM_REASONING_EFFORT`(可选)
  - 加一个段落 "## Reasoning Effort"(per-model 默认表 + env 覆盖说明)
- [ ] `.env.example`:加 `LLM_REASONING_EFFORT=xhigh`(示例)+ 注释合法值
- [ ] `.trellis/spec/flower-providers/backend/error-handling.md`:fail-fast 矩阵新增 1 行 `LLM_REASONING_EFFORT 非法值`
- [ ] `.trellis/spec/flower-providers/backend/index.md`:关键设计点加 1 条 "reasoning effort 由 env + per-model 默认决定"
- [ ] `.trellis/spec/guides/debugging-llm-integration.md`:在 "真实案例" 后加新案例 "pi-ai anthropic.js:544 注释过时'max only Opus 4.6'与 Anthropic 官方矛盾;实际 Opus 4.7 也支持 max。教训:信官方文档,不信中间层 SDK 代码注释"
- **验证**:`grep -rn "getDefaultReasoningEffort\|LLM_REASONING_EFFORT" packages/flower-providers/README.md .env.example` 各 ≥ 1
- **完成判据**:文档 / spec / .env.example 三处一致

### Step 9 — 综合质量验证

- [ ] `npm run build`(monorepo 根)
- [ ] `npm run typecheck`
- [ ] `npm run check`(biome)
- [ ] `npm run test --workspaces --if-present`(应跑 80+ 测试)
- [ ] grep secret 自检(应无新泄漏)
- **完成判据**:全绿

### Step 10(可选)— 端到端 smoke 验证 AC7

> 仅当主线想跑且有新 key 时执行;不强制本任务完成。

- [ ] 复制前任务的 smoke-gateway.ts 到本任务 `scripts/`,加 `reasoning` 字段输出和 verbose 抓包
- [ ] 跑 5 个 case,人眼验证请求 payload 含正确的 effort / budget
- [ ] 跑后 grep secret 自检

## Validation 命令汇总

```bash
# 基础
npm run build
npm run typecheck
npm run check
npm run test --workspaces --if-present

# 自检
grep -rn "sk-[A-Za-z0-9]\{20,\}" packages/ .trellis/spec/ README.md .env.example 2>/dev/null | grep -v node_modules
grep -rn "getDefaultReasoningEffort\|LLM_REASONING_EFFORT" packages/flower-providers/README.md .env.example
```

## Review Gates

| Gate | 时机 | 通过条件 |
|---|---|---|
| Pre-start | task.py start 前 | 用户 review prd + design + implement 三件套,显式同意 |
| Mid(Step 5 后) | runtime + register + index 写完 | `npm run build -w @flower-ai/flower-providers` 通过,3 个公开函数齐 |
| Pre-AC7 | Step 9 后,Step 10 前 | 所有非端到端 AC 全过(AC1-AC6 + AC8) |
| Pre-commit | 全部步骤后 | secret 自检无泄漏,trellis-check-all 通过 |

## Rollback Points

- Step 7 后:若 ops-bot streamFn 注入 reasoning 引发问题,只 revert agent-factory.ts;flower-providers 本体保留无负面影响(新 API 不影响既有调用)
- Step 1 后:若新模型参数引发"按 maxTokens 切片"类问题(可能性低,只是变大),只 revert catalog.ts 即可
