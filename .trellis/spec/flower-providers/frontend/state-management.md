# State Management

> 无状态原则。

---

## Overview

**本包完全无状态。**

- 没有缓存
- 没有连接池
- 没有可变全局变量
- `CUSTOM_MODELS` 是 module-level **immutable** `const`

调用 `registerCompanyProviders` 是 fire-and-forget 的副作用(注册到 pi 内部状态),本包不持有任何引用。

---

## State Categories

| 类型 | 载体 | 生命周期 |
|------|------|----------|
| 模型清单 | `module-level const CUSTOM_MODELS` | 进程级,immutable |
| 环境变量 | `process.env.LLM_BASE_URL` / `LLM_API_KEY` | 进程级,只读 |
| 注册结果 | pi 内部 | pi 框架管理 |

---

## When to Use Global State

**不使用。**

唯一允许的 module-level 是**不可变常量**(`CUSTOM_MODELS`)。
未来如果有"按 appSource 缓存 provider 配置"的需求,要在 PRD 里先说明:

- 为什么需要?(性能?多次注册场景?)
- 多副本一致性怎么办?
- 怎么失效?

通常的答案是"不需要"。

---

## Server State

不适用。

---

## Common Mistakes

- ❌ 在 `registerCompanyProviders` 内累加 module-level counter(用于审计/计数)— 应该让 SIEM 端做计数
- ❌ 把 `CUSTOM_MODELS` 改成 `let` 并支持运行时增删(模型清单是配置,改了就重启)
- ❌ 用 module-level `Map<appSource, providerConfig>` 做缓存(过早优化,本包调用只在启动期一次)
