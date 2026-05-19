# Backend Development Guidelines

> `@flower-ai/flower-tools-arms` 的内部实现层(脱敏规则、未来的 SDK 客户端)规范。

---

## Overview

`flower-tools-arms` 当前内部只有一个真实实现模块:`src/mask.ts`(脱敏)。
真实接入 ARMS / SLS SDK 后会再加 `src/client.ts`。

| 模块 | 职责 |
|------|------|
| `src/mask.ts` | `maskSensitive(text)` + `RULES` 常量 |
| `src/client.ts`(未来) | SDK 客户端单例、`signal` 透传、超时 |

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 当前布局与未来拆分点 |
| [Database Guidelines](./database-guidelines.md) | 不适用 |
| [Error Handling](./error-handling.md) | SDK 错误转 user-friendly content,凭证缺失 throw |
| [Logging Guidelines](./logging-guidelines.md) | 不打 query / 日志原文 / 凭证 |
| [Quality Guidelines](./quality-guidelines.md) | 与 frontend/ 共用 + backend 强约束 |

---

## 关键设计点

1. **`maskSensitive` 是表驱动**:`RULES` 数组易扩展、易测试
2. **脱敏是"防御纵深"**:不是替代权限边界(那是 `flower-compliance` / `ops-bot/auth` 的职责)
3. **SDK 客户端必须惰性单例**:`import` 时不连接,首次 `execute` 时初始化
4. **凭证从 env 读**:缺 `ALICLOUD_AK` / `SK` 在 `getClient()` 首次调用时 throw
