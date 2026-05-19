# Logging Guidelines

> 不打 apiKey / baseUrl。

---

## Overview

本包**几乎不打日志**(初始化代码,正常路径无需输出)。

- 错误路径:`throw new Error("LLM_BASE_URL 环境变量未配置")`,无需再 console
- 成功路径:静默(由调用方在更高层决定是否日志"扩展加载成功")

---

## Log Levels

| 函数 | 何时用 |
|------|--------|
| `console.log` | **不用**(本包不输出常规日志) |
| `console.warn` | **不用** |
| `console.error` | **不用**(错误直接 throw,让顶层 catch 决定怎么打) |

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
console.log("registered models:", CUSTOM_MODELS);
```

模型清单不算敏感,但是噪音。如果一定要 debug,通过 `DEBUG=flower-providers` env 控制,**不要默认输出**。

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
