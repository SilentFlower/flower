# Error Handling

> 启动期错误处理。

---

## Overview

本包的所有错误都在**启动期**(`registerCompanyProviders` 调用时)发生。
策略是 **fail-fast**:有问题立刻退出,绝不带病运行。

---

## Error Types

不定义自定义错误类,统一用 JavaScript 内置 `Error`。

---

## Error Handling Patterns

### 启动期校验

```typescript
const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;

if (!baseUrl) throw new Error("LLM_BASE_URL 环境变量未配置");
if (!apiKey) throw new Error("LLM_API_KEY 环境变量未配置");
```

约定:

1. **每个缺失变量单独 throw**,错误信息含具体变量名
2. **顺序检查**(先 baseUrl 再 apiKey),便于用户按提示一步步配
3. **不 fallback**(无默认 URL、无空 apiKey)

### `pi.registerProvider` 本身失败

pi 上游的 `registerProvider` 在重复注册同名 provider 时会**静默覆盖**(根据 pi 0.75 行为),
不抛错。

如果未来需要严格检查"是否已注册",在 `registerCompanyProviders` 入口加一个 `if (pi.hasProvider("company")) throw ...`(当前 pi 不一定有这个 API,先不做)。

---

## API Error Responses

不适用(本包无 API)。

---

## Common Mistakes

- ❌ 缺凭证时 `console.warn` 后继续(pi 后续会拿不到 model 而崩,错误源被掩盖)
- ❌ 把 `LLM_API_KEY` 缺失当作"可选"(凭证必填,无默认)
- ❌ 多次调用 `registerCompanyProviders(pi, ...)` 注册同一 provider(pi 会静默覆盖,导致 `appSource` 串味;每个 caller 只调一次)
- ❌ 在 `getDefaultModelId` 内 throw(策略函数应该总是返回可用默认值;查不到就用保守 mini)
