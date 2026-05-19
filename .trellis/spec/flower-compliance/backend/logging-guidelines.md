# Logging Guidelines

> 日志格式与禁打印内容。

---

## Overview

本包**只用 console**(`console.log` / `console.warn` / `console.error`)。
不引入 winston / pino 等日志库,因为本包就 2 个文件,简单的 prefix + console 已经够了。

---

## Log Levels

| 函数 | 何时用 |
|------|--------|
| `console.log` | 仅 debug 用(`DEBUG_AUDIT=1` 时打印记录本身) |
| `console.warn` | 审计上报失败 |
| `console.error` | **本包不主动调用**(主调用方在顶层 catch 时再用 error) |

---

## Structured Logging

不强制结构化日志。但日志必须有**前缀标识**,便于 CI / 容器日志检索。

| 模块 | 前缀 |
|------|------|
| 审计上报 | `[audit]` |
| 拦截规则 | (不打印,reason 通过 `return { block, reason }` 给 LLM) |

例:

```typescript
console.log("[audit]", JSON.stringify(record));
console.warn("[audit] 上报失败:", err);
```

---

## What to Log

- **调试模式**(`DEBUG_AUDIT=1`):打印完整 record(本地排错用,不会到生产)
- **审计上报失败**:`console.warn("[audit] 上报失败:", err)`

---

## What NOT to Log

- ❌ **审计 record 全量**(生产环境):`record` 字段开放,可能含来自上游 handler 的敏感数据;只在 `DEBUG_AUDIT=1` 时打印
- ❌ **凭证 / token**:`SIEM_INGEST_URL` 本身不算敏感,但如果未来加 token / auth header,绝不要打印
- ❌ **PII**:本包不直接接触 PII,但如果上层 handler 不小心把 PII 放进 `record`,**本包不做兜底**(防御纵深的责任在调用方,不在 logging)
- ❌ **业务数据**(如 MR diff、ARMS 日志原文):本包不应该有这些数据,如果出现说明上层职责越界

---

## 实例

参考 `packages/flower-compliance/src/audit.ts:30-48`:

```typescript
if (!url) {
  if (process.env.DEBUG_AUDIT === "1") {
    console.log("[audit]", JSON.stringify(record));
  }
  return;
}

try {
  await fetch(url, { ..., signal: AbortSignal.timeout(2000) });
} catch (err) {
  console.warn("[audit] 上报失败:", err);
}
```
