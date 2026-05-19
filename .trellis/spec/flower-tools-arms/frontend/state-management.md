# State Management

> 无业务状态;脱敏规则是 module-level immutable。

---

## Overview

**本包无运行时业务状态。**

工具定义是静态 `const`,脱敏规则是不可变数组。
真实接入 SDK 后,允许有 module-level 客户端单例(网络连接复用)。

---

## State Categories

| 类型 | 载体 | 生命周期 |
|------|------|----------|
| 工具定义 | module-level `const armsXxxTool` | 进程级,immutable |
| 脱敏规则 | `module-level const RULES` | 进程级,immutable |
| SDK 客户端(未来) | module-level `let slsClient` 单例 | 进程级,惰性 |
| 凭证 | `process.env.*` | 进程级,只读 |

---

## When to Use Global State

允许 module-level mutable **唯一场景**:

- SDK 客户端单例(网络连接复用)

```typescript
let _slsClient: SLS20201230 | undefined;
function getSlsClient(): SLS20201230 {
  if (_slsClient) return _slsClient;
  const ak = process.env.ALICLOUD_AK;
  const sk = process.env.ALICLOUD_SK;
  if (!ak || !sk) throw new Error("ALICLOUD_AK / SK 未配置");
  _slsClient = new SLS20201230(ak, sk);
  return _slsClient;
}
```

---

## Server State

LLM 调工具就是"远端状态查询"。本包**不缓存**远端结果:

- 监控数据时效性要求高,缓存可能误导
- 缓存命中率低(LLM 每次问题的参数都不同)
- 简单实现优于过度优化

---

## Common Mistakes

- ❌ 缓存 ARMS 查询结果到 module-level Map(可能误导用户看到"陈旧"数据)
- ❌ 在 `execute` 内 `new Client(...)` 而非用单例(每次重建连接)
- ❌ 把 SDK 单例放进 `index.ts` module top level 同步初始化(应该惰性,缺凭证时只有真用工具才报错,而非 `import` 时就崩)
