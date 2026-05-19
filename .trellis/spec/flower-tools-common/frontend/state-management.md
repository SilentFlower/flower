# State Management

> 钉钉 accessToken 缓存策略。

---

## Overview

本包大部分**无运行时状态**。唯一例外:

- `dingtalk-doc.ts` 的 **accessToken 缓存**(因钉钉 API 限流要求)

---

## State Categories

| 类型 | 载体 | 生命周期 | 一致性 |
|------|------|----------|--------|
| 工具定义 | module-level `const` | 进程级,immutable | 自然一致 |
| 钉钉 accessToken | module-level `let _cachedToken` | 进程级,带过期 | 每副本独立缓存 |
| 凭证 | `process.env.*` | 进程级,只读 | 一致 |

---

## When to Use Global State

**钉钉 accessToken 缓存**是合理的 module-level mutable:

理由:

1. **必要**:钉钉 API 限流要求,不能每次工具调用都换 token
2. **副本独立可接受**:每副本独立换 token 是钉钉允许的(只要总频率不超限)
3. **简单**:不引入 Redis,降低运维复杂度

约束:

- **必须有过期判断**(`expiresAt > now + 60_000`)
- **必须凭证缺失就 throw**(不要 fallback 给空 token)
- **不要缓存其他东西**(用户身份 / spaceId 列表 / 搜索结果都不缓存)

---

## Server State

LLM 调工具就是远端查询。本包**不缓存查询结果**:

- 文档 / bug / 任务可能随时变化,缓存可能误导
- LLM 每次问题参数不同,命中率低

---

## Common Mistakes

- ❌ 缓存禅道查询结果(用户 / 状态 / 数据可能变,缓存会误导)
- ❌ 把 accessToken 缓存放在 `index.ts` 共享(应该归 `dingtalk-doc.ts`)
- ❌ accessToken 缓存到 Redis(过早共享,带来一致性 / 故障域问题)
- ❌ 缓存 token 时不带过期戳(到期了仍当合法 token 用)
- ❌ 用 `setInterval` 提前刷新 token(简单的"调用时检查"已够,没必要后台任务)
