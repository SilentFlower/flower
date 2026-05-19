# Logging Guidelines

> 日志前缀与禁打印内容。

---

## Overview

本包**只用 `console`**(不引入 pino / winston)。
通过前缀区分模块,便于容器日志检索。

---

## Log Levels

| 函数 | 何时用 |
|------|--------|
| `console.log` | 服务启动 / 关闭通知 |
| `console.warn` | 可恢复故障(推送钉钉失败、内存 backend 降级、签名缺失) |
| `console.error` | 不可恢复 / 意外异常(Redis 严重错、webhook 处理顶层 catch) |

---

## Structured Logging

不强制结构化。但日志必须有**前缀**:

| 前缀 | 用于 |
|------|------|
| `[ops-bot]` | server 启动 / 关闭 / 顶层 catch |
| `[ops-bot] 推送钉钉失败:` | push.ts |
| `[redis]` | ioredis error 事件 |
| `[session-store]` | 降级到内存 backend 时的 warn |

---

## What to Log

启动期:

```typescript
console.log(`[ops-bot] 监听 :${PORT}`);
console.log(`[ops-bot] 收到 ${signal},准备关闭`);
```

故障路径:

```typescript
console.error("[ops-bot] 处理请求出错:", err);
console.error("[ops-bot] 处理消息失败:", err);
console.warn("[ops-bot] 推送钉钉失败:", err);
console.warn("[session-store] REDIS_URL 未设置,使用内存后端(仅本地开发)");
console.error("[redis]", err);
```

---

## What NOT to Log

### ❌ 用户消息文本

```typescript
// 错误
console.log("[ops-bot] 收到消息:", input.text);
```

可能含敏感数据(查询 ARMS 时可能带凭证 / 业务数据)。`text` 永远不进日志。

### ❌ Agent 输出累积器

```typescript
// 错误
console.log("[handler] accumulator:", accumulator);
```

LLM 输出可能含 ARMS 日志原文,即使经过 maskSensitive 也不保证 100% 干净。
**审计走 SIEM,日志只保留控制流信息**。

### ❌ 凭证

任何 `LLM_API_KEY` / `DINGTALK_BOT_SECRET` / `REDIS_URL`(可能含密码)的值。
即使 debug,也不要 `console.log(process.env)`。

### ❌ Redis value

```typescript
// 错误
console.log("[session-store] saved", value);  // value 内含 messages,可能 PII
```

### ❌ conversationId 之外的钉钉信息

只打 `conversationId`(已脱敏 ID),不打 `senderStaffId` / `senderNick`(关联到真实员工)。

---

## 实例对照

| 场景 | 正确 | 错误 |
|------|------|------|
| webhook 进来 | (不打) | `console.log("收到", payload)` |
| webhook 应答 | (不打) | `console.log("已应答", conversationId)` |
| 处理失败 | `console.error("[ops-bot] 处理消息失败:", err)` | `console.error("text=", text, err)` |
| Redis 失败 | `console.error("[redis]", err)` | `console.error("[redis] key=", key, "value=", value)` |
| 启动 | `console.log("[ops-bot] 监听 :${PORT}")` | `console.log("env=", process.env)` |
