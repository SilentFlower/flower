# Design · flower-providers env 缺省 fallback

> 三件套之 design.md。承接 `prd.md` 的 R1-R6 / AC1-AC4。
> 实施 checklist 见 `implement.md`。

## 0. Overview

### 0.1 改动范围

```
packages/flower-providers/src/
  env.ts        ← + getLLMProviderOrDefault / getLLMModelOrDefault
  runtime.ts    ← + DEFAULT_LLM_PROVIDER / DEFAULT_LLM_MODEL 常量
                  + buildPiCliArgs 改用 OrDefault helper + fallback 日志
  index.ts      ← 视情况 re-export 默认常量(如需)
  __tests__/
    env.test.ts        ← + 5 case(AC1.1-1.5)
    runtime.test.ts    ← + 4 case(AC1.6-1.9)
```

完全不动:`catalog.ts`、`register.ts`(SDK 路径不变)。

### 0.2 关键设计选择

| 选择 | 决定 | 理由 |
|---|---|---|
| 默认 provider | `havefun-anthropic` | 速度+准确性折中,已存在,protocol 自动匹配 |
| 默认 model | `claude-sonnet-4-6` | 同上;reasoning=true,适合 reviewer |
| API 形态 | 新增 `OrDefault` 变体,不改原函数 throw | 不破坏 ops-bot 形态对 fail-fast 的依赖 |
| 日志级别 | `console.log`(info) | 不被 SIEM 误报告警;但能在 GitLab CI 日志 grep 到 |
| 日志位置 | `buildPiCliArgs` 内,fallback 时打 | 不在 helper 内打,避免 helper 在测试中被多次调用时刷屏 |

## 1. 接口签名

### 1.1 新增常量(`runtime.ts` 顶部 export)

```typescript
import type { ProviderName } from "./catalog.js";

/**
 * code-reviewer CLI 路径在 env 缺省时使用的默认 provider
 *
 * 选择理由(见 prd.md §3 R1):
 * - havefun-anthropic:速度+准确性折中,reviewer 主流使用面
 * - BUILTIN_MODELS 中已存在,baseUrl 自动拼对 havefun 网关
 * - 不会走 pi 内置 openai/azure provider 的官方 URL
 */
export const DEFAULT_LLM_PROVIDER: ProviderName = "havefun-anthropic";

/**
 * code-reviewer CLI 路径在 env 缺省时使用的默认 model id
 *
 * 与 DEFAULT_LLM_PROVIDER 协议匹配(claude-sonnet-4-6.nativeApi === "anthropic")。
 * 选择 sonnet 而非 opus 是为了平衡接入方默认成本。
 */
export const DEFAULT_LLM_MODEL = "claude-sonnet-4-6";
```

### 1.2 新增 helper(`env.ts`)

```typescript
import { DEFAULT_LLM_PROVIDER, DEFAULT_LLM_MODEL } from "./runtime.js";
// ⚠️ runtime.ts 和 env.ts 互相依赖:env.ts 已 import runtime 的常量,
//    runtime.ts 也需要 import env.ts 的 helper。
//    解决:把 DEFAULT_* 常量放在 env.ts 顶部(同 ALLOWED_REASONING_EFFORTS 的位置),
//    避免循环依赖。runtime.ts 仅在 buildPiCliArgs 内 import 这两个常量即可。

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
```

**调整**:为避免 env.ts ↔ runtime.ts 循环依赖,**把 `DEFAULT_LLM_PROVIDER` / `DEFAULT_LLM_MODEL` 定义在 `env.ts` 顶部**(贴近其他默认 / 合法值常量),runtime.ts 通过 `import { ... } from "./env.js"` 复用。

最终 placement:
```typescript
// env.ts 顶部(在 ALLOWED_REASONING_EFFORTS 附近)
export const DEFAULT_LLM_PROVIDER: ProviderName = "havefun-anthropic";
export const DEFAULT_LLM_MODEL = "claude-sonnet-4-6";
```

### 1.3 修改 `buildPiCliArgs`(`runtime.ts`)

```typescript
import {
  getLLMReasoningEffort,
  getLLMProviderOrDefault,
  getLLMModelOrDefault,
} from "./env.js";

export function buildPiCliArgs(input: BuildPiCliArgsInput): string[] {
  const argv: string[] = ["-p", input.prompt];

  // provider: env > DEFAULT_LLM_PROVIDER(永远显式传,杜绝 pi 内置 fallback)
  let provider: ProviderName;
  try {
    provider = getLLMProviderOrDefault();
  } catch (err) {
    // env 非法值 fail-fast,沿用 getLLMProvider 抛错
    throw err;
  }
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

  // reasoning effort:缺省继续透传(pi 自己走 medium)
  const effort = getLLMReasoningEffort();
  if (effort !== undefined) {
    argv.push("--thinking", effort);
  }

  return argv;
}
```

## 2. 数据流

```
env (LLM_PROVIDER / LLM_MODEL / LLM_REASONING_EFFORT)
    ↓
buildPiCliArgs
    ├─ getLLMProviderOrDefault()  → "havefun-anthropic"(若缺省)
    │                                or 用户配的合法值
    ├─ getLLMModelOrDefault()     → "claude-sonnet-4-6"(若缺省)
    │                                or 用户配的字符串
    └─ getLLMReasoningEffort()    → undefined(若缺省) or 合法值
    ↓
argv = ["-p", prompt, "--provider", X, "--model", Y, ("--thinking", Z)?]
    ↓
piMain(argv, ...)
    ↓
pi CLI 拿到显式 --provider/--model → 走 register.ts 注册的 havefun-* provider
    ↓
LLM 请求走 havefun 网关 baseUrl + LLM_API_KEY
```

## 3. 兼容性 / 回滚

### 3.1 兼容性

- ops-bot 形态:**零影响**,`getDefaultModel`/`getLLMProvider`/`getLLMModel` throw 行为不变
- code-reviewer 已配齐 env 的部署:**零影响**,fallback 路径走不到
- code-reviewer 未配 env 的部署:**行为改变**——从"侥幸命中 havefun 或走 pi 内置"变为"显式走 havefun + sonnet-4-6"。**这就是我们想要的变更**

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
