# Database Guidelines

> **不适用** — `flower-compliance` 无持久化层。

---

## Overview

本包不连数据库、不写文件、不维护进程内缓存。
所有审计记录都是单向 fire-and-forget POST 到 SIEM 端点(`SIEM_INGEST_URL`)。

---

## 为什么没有数据库

1. **职责单一**:本包就是"事件拦截 + 转发",存储是 SIEM 的事
2. **fail-open**:即使 SIEM 短暂不可用,主流程仍要继续运转
3. **无重试**:本端不缓存,丢就丢了(替代方案:SIEM 端做幂等接收 / 日志重放)

---

## 如果未来要加缓冲

应作为**独立的可选组件**,不耦合到本包当前实现:

- 可考虑 Redis Stream / Kafka 作为审计中转层
- 在那时为审计上报增加 `traceId` 字段
- 在那时考虑 batch upload,但要保持 fail-open 语义

---

## Query Patterns / Migrations / Naming Conventions

不适用。
