# Backend Development Guidelines

> `@flower-ai/flower-ops-bot` 的内部实现层(会话存储、Agent 装配、工具适配)开发规范。

---

## Overview

本目录(`backend/`)关心**非对外接口的实现层**:

| 模块 | 职责 |
|------|------|
| `handler.ts` | 消息处理主流程,订阅事件,持久化会话 |
| `agent-factory.ts` | 按 conversationId 构造 / 持久化 Agent |
| `session-store.ts` | Redis 后端(降级内存),会话 messages 读写 |
| `tools.ts` | ToolDefinition → AgentTool 转换,装配工具列表 |
| `prompts.ts` | `OPS_SYSTEM_PROMPT` 系统提示词 |
| `dingtalk/signature.ts` | HMAC-SHA256 签名 + 防重放 |

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 与 frontend/ 共用一套布局,本节聚焦后端模块边界 |
| [Database Guidelines](./database-guidelines.md) | Redis(ioredis):key 规则、TTL、JSON 序列化、降级策略 |
| [Error Handling](./error-handling.md) | 后台 try/catch + push 错误降级、Redis fail-open |
| [Logging Guidelines](./logging-guidelines.md) | `[ops-bot]` / `[redis]` / `[session-store]` 前缀 |
| [Quality Guidelines](./quality-guidelines.md) | 共用一套约束,后端额外 checklist |

---

## 关键设计点

1. **Redis 一致性 > 内存性能**:多副本部署必须用 Redis,内存 backend 仅本地开发
2. **会话 TTL 24h**:超过自然过期,无需手工清理
3. **Agent 实例不缓存**:每次 webhook 重建 Agent(无 LRU)。简单可预测,代价是每条消息多一次 Redis 读
4. **`pickModel()` 当前写死**:真实接入后改为读 model registry
5. **`toAgentTool` 是兼容层**:`pi-coding-agent` 的 `ToolDefinition` vs `pi-agent-core` 的 `AgentTool` 字段重合度高,简单字段映射
