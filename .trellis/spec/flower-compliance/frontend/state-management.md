# State Management

> 状态流向:从 `options` 闭包到 handler。

---

## Overview

**本包无可变状态。**

`registerCompliance` 把 `options.mode` / `options.product` 通过闭包传给 handler。
handler 内部只产生 side-effect(`pi.on` 注册、`sendAudit` 上报),不维护任何 module-level 变量。

---

## State Categories

| 类型 | 载体 | 生命周期 |
|------|------|----------|
| 配置参数 | `options` 对象 → 闭包 | 进程级,只读 |
| 拦截规则 | `module-level const bashAllowList` | 进程级,immutable |
| 环境变量 | `process.env.SIEM_INGEST_URL / DEBUG_AUDIT` | 进程级,只读 |

---

## When to Use Global State

**不使用。**

唯一允许的 module-level 常量是**不可变正则 / 字符串**(`bashAllowList`)。
任何 `let xxx = ...` 在本包内禁止。

---

## Server State

`sendAudit` 是单向 POST,**不读** SIEM 状态,不需要本地缓存。

---

## Common Mistakes

- ❌ 把 `options.product` 存进 module-level `let currentProduct`(同进程多次 `registerCompliance` 会串味;改用闭包参数)
- ❌ 用 module-level `Map` 累积审计记录然后批量上报(增加丢失风险;`sendAudit` 直接逐条 POST,SIEM 负责聚合)
- ❌ 通过环境变量在运行期切换 `mode`(`mode` 是 `registerCompliance` 调用时确定的,运行中不应改变)
