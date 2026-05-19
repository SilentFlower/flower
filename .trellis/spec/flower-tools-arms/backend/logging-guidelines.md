# Logging Guidelines

> 不打 query / 日志原文 / 凭证。

---

## Overview

本包**几乎不打日志**:

- 正常路径:工具执行结果通过返回值传给 LLM,pi 框架 / `flower-compliance` 负责审计
- 错误路径:错误信息已经包在 `content` 里返回 LLM,无需再 console

唯一允许 console:**SDK 客户端初始化失败**(罕见,通常是凭证错)。

---

## Log Levels

| 函数 | 何时用 |
|------|--------|
| `console.log` | **不用** |
| `console.warn` | **不用** |
| `console.error` | 仅 SDK 严重错(rare),前缀 `[arms]` |

---

## Structured Logging

不适用。

---

## What to Log

正常路径:**完全不打**。

工具调用 / 结果由 `flower-compliance` 通过 `pi.on("tool_call" / "tool_result", ...)` 上报到 SIEM,本包不重复打。

---

## What NOT to Log

### ❌ 用户查询语句

```typescript
// 错误
console.log("[arms] query:", params.query);
```

`query` 可能含业务关键字(用户名、内部 ID),不该进容器日志。

### ❌ 日志原文 / 调用链数据

```typescript
// 错误
console.log("[arms] result:", rawResult);
```

可能含 PII / 密钥(即使有 maskSensitive,日志层不该做兜底)。

### ❌ 凭证

任何 `ALICLOUD_AK` / `SK` 的值。

### ❌ Project / Logstore 名

```typescript
// 错误
console.log("[arms] querying", params.project, params.logstore);
```

项目结构可能算敏感(内部应用拓扑)。

---

## 例外:debug 模式

如果一定要 debug,通过专门 env 控制:

```typescript
if (process.env.DEBUG_ARMS === "1") {
  console.log("[arms] tool=arms_query_logs project=", params.project);  // 仍不打 query
}
```

要求:

- 独立 env (`DEBUG_ARMS`)
- 前缀 `[arms]`
- 仍然不打凭证 / 原文 / query 内容
