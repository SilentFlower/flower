# Logging Guidelines

> 不打 apiKey / baseUrl。

---

## Overview

本包**几乎不打日志**(初始化代码,正常路径无需输出)。

- 错误路径:`throw new Error("LLM_BASE_URL 未配置")`,无需再 console
- 成功路径:静默(由调用方在更高层决定是否日志"扩展加载成功")

---

## Log Levels

| 函数 | 何时用 |
|------|--------|
| `console.log` | **几乎不用**(本包不输出常规日志);**例外**:CLI 路径 `buildPiCliArgs` 在 env 缺省 fallback 时打提示,见下文 |
| `console.warn` | **不用** |
| `console.error` | **不用**(错误直接 throw,让顶层 catch 决定怎么打) |

`registerHavefunProviders` / `getDefaultModel` / `buildHavefunModel` 三个公开函数都遵守上述约束。

### 例外:CLI 路径 fallback 提示(2026-05-21 新增)

`buildPiCliArgs`(code-reviewer CLI 路径)在 env 缺省 fallback 时,**允许**调用 `console.log` 打提示:

```typescript
// 示例(env 全空时)
console.log(`[flower-providers] LLM_PROVIDER 未配置,fallback 到 "havefun-openai-responses"`);
console.log(`[flower-providers] LLM_MODEL 未配置,fallback 到 "gpt-5.5"`);
console.log(`[flower-providers] LLM_REASONING_EFFORT 未配置,fallback 到 "high"`);
```

理由:
- opt-in 给业务方接入的 CI 工具,需要让接入方明确感知"我在用默认值,改 env 可覆盖",避免"为什么 model 是 gpt-5.5?"类型的排查
- info 级(`console.log` 非 `console.warn`),避免被 SIEM 误报为告警
- 每次调用最多 3 行(provider / model / effort 各 1 行),不刷屏

约束(仍生效):
- **绝不**输出 `apiKey` / `baseUrl`(本任务的 fallback 日志只含 provider name / model id / effort 字符串,均非敏感)
- 前缀固定 `[flower-providers]`,便于业务方 grep
- env 配齐时**不**触发(`if (!process.env.X || process.env.X.trim() === "") console.log(...)`)

---

## Structured Logging

不适用。

---

## What to Log

正常路径:不打。

---

## What NOT to Log

### ❌ `LLM_BASE_URL`

虽然不算高敏感,但仍属于"内部基础设施信息",尽量不打。

### ❌ `LLM_API_KEY` 值

**绝对禁止**任何形式记录(包括掩码后):

```typescript
// 全部错误
console.log("api key:", apiKey);
console.log("api key prefix:", apiKey.slice(0, 5) + "***");
console.log("api key length:", apiKey.length);
```

第三种看起来无害,但泄漏长度信息有一定价值,统一禁止。

### ❌ 模型清单

```typescript
// 错误
console.log("registered models:", BUILTIN_MODELS);
```

模型清单不算敏感,但是噪音。如果一定要 debug,通过 `DEBUG_PROVIDERS` env 控制,**不要默认输出**。

### ❌ `appSource`

低敏感,但同样属于噪音。

---

## 例外:开发 debug

如果开发时确实需要排查(例如确认 `appSource` 是否传对):

```typescript
if (process.env.DEBUG_PROVIDERS === "1") {
  console.log("[providers] registered for appSource:", options.appSource);
}
```

要求:

- 用专门的 `DEBUG_PROVIDERS` env 控制
- 前缀 `[providers]`
- **绝不**输出 apiKey / baseUrl
- 提交代码前移除(或确认 env 默认未设置)
