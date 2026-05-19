# Logging Guidelines

> 不打 token / 文档原文 / 凭证。

---

## Overview

本包**几乎不打日志**。
正常调用通过返回值传 LLM,审计走 `flower-compliance`。

---

## Log Levels

| 函数 | 何时用 |
|------|--------|
| `console.log` | **不用** |
| `console.warn` | **不用**(可选:token 刷新失败可 warn 一次,但 throw 已经够了) |
| `console.error` | 仅意外错误(几乎不发生);前缀 `[zentao]` / `[dingtalk-doc]` |

---

## Structured Logging

不适用。

---

## What to Log

正常路径:不打。

---

## What NOT to Log

### ❌ accessToken

```typescript
// 错误
console.log("[dingtalk-doc] got token:", accessToken);
```

token 是凭证级别敏感。

### ❌ 用户查询

```typescript
// 错误
console.log("[zentao] query:", params.query);
```

query 可能含业务关键字。

### ❌ API 响应内容

```typescript
// 错误
console.log("[zentao] result:", data);
```

数据敏感性高(人员信息、内部 ID、文档内容)。

### ❌ 凭证

任何 `ZENTAO_TOKEN` / `DINGTALK_APP_SECRET` 的值。

### ❌ URL 全文

```typescript
// 错误
console.log("[zentao] fetching:", url);
```

URL 可能含查询参数和 token(虽然我们用 Authorization header,但万一某天有人改用 URL token,日志就泄露了)。

---

## 例外:debug 模式

```typescript
if (process.env.DEBUG_TOOLS_COMMON === "1") {
  console.log("[zentao] tool=zentao_search type=", params.type ?? "all");
}
```

仍不打 query 内容、token、响应。
