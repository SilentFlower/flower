# Design · flower-providers env 缺省 fallback

> 三件套之 design.md。承接 `prd.md` 的 R1-R6 / AC1-AC4。
> 实施 checklist 见 `implement.md`。

## 0. Overview

### 0.1 改动范围

```
packages/flower-providers/src/
  env.ts        ← + 3 常量(DEFAULT_LLM_PROVIDER / _MODEL / _REASONING_EFFORT)
                  + 3 helper(getLLMProviderOrDefault / getLLMModelOrDefault / getLLMReasoningEffortOrDefault)
  runtime.ts    ← buildPiCliArgs 改用 OrDefault helper + 3 行 fallback 日志
  index.ts      ← 不动(默认常量是内部 fallback,不对外暴露,避免被外部覆盖)
  __tests__/
    env.test.ts        ← + 8 case(AC1.1-1.8)
    runtime.test.ts    ← 改写 4 个现有 buildPiCliArgs case + 新增 5 case(AC1.9-1.13)
```

完全不动:`catalog.ts`、`register.ts`(SDK 路径不变);runtime.ts 中 `getDefaultModel` / `buildHavefunModel` / `getDefaultReasoningEffort` 三个 SDK 路径函数不变。

### 0.2 关键设计选择

| 选择 | 决定 | 理由 |
|---|---|---|
| 默认 provider | `havefun-openai-responses` | 与 stress test(pipeline 2127)实测组合对齐;BUILTIN_MODELS 已存在,protocol 自动匹配 |
| 默认 model | `gpt-5.5` | 同上;reasoning=true,reasoning summary 模式适合 reviewer |
| 默认 effort | `high` | 与 stress 显式配置对齐;not xhigh(留给"显式想要"的项目控成本) |
| API 形态 | 新增 `OrDefault` 变体,不改原函数 throw | 不破坏 ops-bot 形态对 fail-fast 的依赖 |
| 日志级别 | `console.log`(info) | 不被 SIEM 误报告警;但能在 GitLab CI 日志 grep 到 |
| 日志位置 | `buildPiCliArgs` 内,fallback 时打 | 不在 helper 内打,避免 helper 在测试中被多次调用时刷屏 |
| 默认常量是否 re-export | 否 | 内部 fallback,不对外暴露;若有人显式想用默认值,显式配 env 即可 |

## 1. 接口签名

### 1.1 新增常量(`env.ts` 顶部 export,贴近 `ALLOWED_REASONING_EFFORTS`)

```typescript
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ProviderName } from "./catalog.js";

/**
 * code-reviewer CLI 路径在 env 缺省时使用的默认 provider
 *
 * 选择理由(见 prd.md §3 R1):
 * - 与 stress test(2026-05-21 pipeline 2127 / job 7552)实测组合对齐
 * - BUILTIN_MODELS 中 gpt-5.5 已存在,baseUrl 自动拼 `/v1`
 * - 不会走 pi 内置 openai/azure provider 的官方 URL
 */
export const DEFAULT_LLM_PROVIDER: ProviderName = "havefun-openai-responses";

/**
 * code-reviewer CLI 路径在 env 缺省时使用的默认 model id
 *
 * 与 DEFAULT_LLM_PROVIDER 协议匹配(gpt-5.5.nativeApi === "openai-responses")。
 * stress test 实测稳定组合的 model 端。
 */
export const DEFAULT_LLM_MODEL = "gpt-5.5";

/**
 * code-reviewer CLI 路径在 env 缺省时使用的默认 reasoning effort
 *
 * - 与 stress test 显式配置对齐(LLM_REASONING_EFFORT=high)
 * - 不选 xhigh:留给"显式想要"的项目,控成本与响应时间
 * - 仅影响 CLI 路径;ops-bot 走 getDefaultReasoningEffort(env > per-model > "high")不变
 */
export const DEFAULT_LLM_REASONING_EFFORT: ModelThinkingLevel = "high";
```

### 1.2 新增 helper(`env.ts`)

放在各自原函数下方(`getLLMProvider` / `getLLMModel` / `getLLMReasoningEffort` 之后)。

```typescript
/**
 * 读取 LLM_PROVIDER;缺省时返回 DEFAULT_LLM_PROVIDER。
 *
 * 仅 buildPiCliArgs(code-reviewer CLI 路径)使用。
 * ops-bot 形态请用 getLLMProvider(),它在缺省时 fail-fast。
 *
 * 非法值仍走 getLLMProvider 的 fail-fast(只对**缺省**兜底,不对**非法值**兜底)。
 */
export function getLLMProviderOrDefault(): ProviderName {
  const raw = process.env.LLM_PROVIDER;
  if (!raw || raw.trim() === "") {
    return DEFAULT_LLM_PROVIDER;
  }
  return getLLMProvider();  // 重用合法性校验
}

/**
 * 读取 LLM_MODEL;缺省时返回 DEFAULT_LLM_MODEL。
 *
 * 任意非空字符串透传(具体合法性由下游 getMergedModels 校验)。
 */
export function getLLMModelOrDefault(): string {
  const raw = process.env.LLM_MODEL;
  if (!raw || raw.trim() === "") {
    return DEFAULT_LLM_MODEL;
  }
  return raw;
}

/**
 * 读取 LLM_REASONING_EFFORT;缺省时返回 DEFAULT_LLM_REASONING_EFFORT。
 *
 * 非法值仍走 getLLMReasoningEffort 的 fail-fast(列出 6 个合法值)。
 * 仅 buildPiCliArgs 使用;ops-bot 走 getDefaultReasoningEffort 不变。
 */
export function getLLMReasoningEffortOrDefault(): ModelThinkingLevel {
  const raw = process.env.LLM_REASONING_EFFORT;
  if (!raw || raw.trim() === "") {
    return DEFAULT_LLM_REASONING_EFFORT;
  }
  const validated = getLLMReasoningEffort();
  // 非空但合法的情况下 getLLMReasoningEffort 不会返回 undefined,但 TS 类型推不出
  return validated ?? DEFAULT_LLM_REASONING_EFFORT;
}
```

> 设计决定:常量与 helper 都放在 env.ts(单文件归属 env 解析逻辑),runtime.ts 通过
> `import { getLLMProviderOrDefault, getLLMModelOrDefault, getLLMReasoningEffortOrDefault } from "./env.js"`
> 引用。避免常量与 helper 跨文件放置带来的隐式耦合。

### 1.3 修改 `buildPiCliArgs`(`runtime.ts`)

```typescript
import {
  getLLMProviderOrDefault,
  getLLMModelOrDefault,
  getLLMReasoningEffortOrDefault,
} from "./env.js";
// 注:原 import 的 getLLMReasoningEffort 移除(改用 OrDefault 变体)

export function buildPiCliArgs(input: BuildPiCliArgsInput): string[] {
  const argv: string[] = ["-p", input.prompt];

  // provider: env > DEFAULT_LLM_PROVIDER(永远显式传,杜绝 pi 内置 fallback)
  // 非法值由 getLLMProviderOrDefault 内部 throw,这里不需要 try-catch
  const provider = getLLMProviderOrDefault();
  if (!process.env.LLM_PROVIDER || process.env.LLM_PROVIDER.trim() === "") {
    console.log(`[flower-providers] LLM_PROVIDER 未配置,fallback 到 "${provider}"`);
  }
  argv.push("--provider", provider);

  // model: env > DEFAULT_LLM_MODEL
  const modelId = getLLMModelOrDefault();
  if (!process.env.LLM_MODEL || process.env.LLM_MODEL.trim() === "") {
    console.log(`[flower-providers] LLM_MODEL 未配置,fallback 到 "${modelId}"`);
  }
  argv.push("--model", modelId);

  // reasoning effort: env > DEFAULT_LLM_REASONING_EFFORT
  const effort = getLLMReasoningEffortOrDefault();
  if (!process.env.LLM_REASONING_EFFORT || process.env.LLM_REASONING_EFFORT.trim() === "") {
    console.log(`[flower-providers] LLM_REASONING_EFFORT 未配置,fallback 到 "${effort}"`);
  }
  argv.push("--thinking", effort);

  return argv;
}
```

**行为变化总览**(对接入方实际可感知):

| env 配置 | 当前 argv | 改后 argv |
|---|---|---|
| 全空 | `["-p", PROMPT]` | `["-p", PROMPT, "--provider", "havefun-openai-responses", "--model", "gpt-5.5", "--thinking", "high"]` + 3 行 log |
| 只配 `LLM_MODEL=claude-opus-4-7` | `[..., "--model", "claude-opus-4-7"]` | `[..., "--provider", "havefun-openai-responses", "--model", "claude-opus-4-7", "--thinking", "high"]` ⚠️ 协议不匹配 → pi 启动期 throw |
| `LLM_PROVIDER=invalid` + 合法 model | `[..., "--model", X]`(吃错降级) | **throw** `/LLM_PROVIDER 非法值/` |
| 三个都配齐 | `[..., user-set...]` | 不变(用户值优先) |

## 2. 数据流

```
env (LLM_PROVIDER / LLM_MODEL / LLM_REASONING_EFFORT)
    ↓
buildPiCliArgs
    ├─ getLLMProviderOrDefault()        → "havefun-openai-responses"(若缺省)
    │                                      or 用户配的合法值;非法值 throw
    ├─ getLLMModelOrDefault()           → "gpt-5.5"(若缺省)
    │                                      or 用户配的字符串
    └─ getLLMReasoningEffortOrDefault() → "high"(若缺省)
                                          or 用户配的合法值;非法值 throw
    ↓
argv = ["-p", prompt, "--provider", X, "--model", Y, "--thinking", Z]
    ↓ (3 个 argv 项必然存在,不再有降级路径)
piMain(argv, ...)
    ↓
pi CLI 拿到显式 --provider/--model/--thinking → 走 register.ts 注册的 havefun-* provider
    ↓
LLM 请求走 havefun 网关 baseUrl + LLM_API_KEY,思考预算 = high
```

## 3. 兼容性 / 回滚

### 3.1 兼容性

- ops-bot 形态:**零影响**,`getDefaultModel`/`getLLMProvider`/`getLLMModel`/`getDefaultReasoningEffort`/`getLLMReasoningEffort` 行为完全不变
- code-reviewer 已配齐三个 env 的部署:**零影响**,fallback 路径走不到
- code-reviewer 未配 env 的部署:**行为改变**——从"侥幸命中 havefun + pi 内置 gpt-5.4 medium"变为"显式走 havefun-openai-responses + gpt-5.5 + high"。**这就是我们想要的变更**
- code-reviewer 配了**非法** `LLM_PROVIDER` 的部署:**行为改变**——从"吃错降级到只传 model"变为"显式 throw LLM_PROVIDER 非法值"。属于行为修正,commit message 加 BREAKING-NOTE 提示接入方

### 3.2 回滚

- `buildPiCliArgs` 包装层薄,回滚一个 commit 即可
- 没有 db / migration
- **极端兜底**:若默认值选错(havefun 网关临时没开 anthropic 协议),业务方可以**显式配** `LLM_PROVIDER` / `LLM_MODEL` 覆盖默认,本任务 commit 不用立刻 revert

### 3.3 不加 kill switch 的理由

考虑过加 `FLOWER_DISABLE_PROVIDER_DEFAULT=1` 关掉 fallback,但:
- fallback 失败 = LLM 调用失败 = 既有 `isLlmFailure` fail open 已经兜底
- 接入方覆盖默认的方式已经存在(显式配 env)
- 加 kill switch 反而增加心智负担

## 4. 跨包边界

| 跨包改动 | 是否需要 |
|---|---|
| `flower-providers` | ✅ 主体改动 |
| `flower-tools-gitlab` | ❌ 不动 |
| `flower-tools-common` | ❌ 不动 |
| `flower-compliance` | ❌ 不动 |
| `flower-code-reviewer` | ❌ 不动(消费方,默认值变化自动透传) |
| `flower-ops-bot` | ❌ 不动(走 SDK 路径,fail-fast 保留) |
| spec | ✅ 加节 `.trellis/spec/flower-providers/backend/index.md` |
