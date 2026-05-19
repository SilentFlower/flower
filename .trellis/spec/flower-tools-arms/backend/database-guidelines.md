# Database Guidelines

> **不适用** — `flower-tools-arms` 无自己的数据库。

---

## Overview

本包是 ARMS / SLS 的**远端只读客户端**:

- 不连数据库
- 不缓存远端结果
- 不写本地文件

所有数据来自远端 ARMS API,LLM 单次问题里通过工具调用即时获取。

---

## 为什么不缓存

1. **监控数据时效性高**:缓存可能误导(用户问"现在错误率多少",拿到 5 分钟前数据没意义)
2. **缓存命中率低**:LLM 每次问题的 `query` / `app` / `from` 参数都不同
3. **存储是另一层职责**:如果真需要历史对比,应该在 ARMS / SLS 本身做(它们就是时序存储)

---

## 远端访问对应物

虽然不是数据库,但 ARMS / SLS 访问应**像数据库一样**严格:

| 数据库约定 | 本包对应 |
|--------------|----------|
| ORM | SDK(`@alicloud/sls20201230`、`@alicloud/arms20190808`) |
| 连接池 | SDK 客户端单例(`getSlsClient()`) |
| 凭证 | `process.env.ALICLOUD_AK` / `ALICLOUD_SK` |
| 慢查询日志 | 由 ARMS 端做,本包不监控 |
| 限流 | SDK 自带,本包不重复 |

---

## Query Patterns

- **总是带时间范围**:不允许"查所有时间"的工具参数
- **总是带 limit**:工具 schema 允许 optional `limit`,内部默认 100
- **支持 `signal` 取消**:LLM 决定中止时,正在进行的查询要能取消

---

## Migrations / Naming Conventions

不适用。
