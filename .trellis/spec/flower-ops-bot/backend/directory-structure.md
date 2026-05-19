# Directory Structure

> 见 `frontend/directory-structure.md`。本节聚焦后端模块边界。

---

## 后端核心模块

```
src/
├── handler.ts          # 消息处理主流程(input → agent.prompt + 持久化)
├── agent-factory.ts    # Agent 构造 / pickModel / persistAgent
├── session-store.ts    # Redis 后端 + 内存降级 + closeSessionStore
├── tools.ts            # 工具装配 + ToolDefinition → AgentTool
├── prompts.ts          # OPS_SYSTEM_PROMPT
└── dingtalk/
    └── signature.ts    # HMAC-SHA256 + 防重放
```

---

## 模块依赖关系

```
server.ts
   ▼
dingtalk/webhook.ts  ─── handler.ts ─── agent-factory.ts ─── session-store.ts
                            │                  │
                            ▼                  ▼
                       dingtalk/push.ts    tools.ts
                                              ▼
                                 @flower-ai/flower-tools-arms
                                 @flower-ai/flower-tools-common
```

**单向依赖**:webhook → handler → factory → store。**禁止反向 import**。

---

## Module Organization

- **`handler.ts`** 是协调者,集中了"订阅 agent 事件 → 调 onChunk → 持久化"流程
- **`agent-factory.ts`** 是装配点,**集中**了 Agent 构造、model 选择、状态恢复 / 持久化
- **`session-store.ts`** 隔离了存储实现,handler/factory **只用 `getSession` / `saveSession` / `closeSessionStore`**,不直接接 ioredis
- **`tools.ts`** 是适配层,把 `pi-coding-agent` 风格的 ToolDefinition 转成 `pi-agent-core` 风格的 AgentTool

---

## Naming Conventions

- module-level 单例:`backend`、`redis` 等用短名(无前缀)
- helper 私有:小写,不带前缀
- 工厂函数:`create<Backend>Backend`(`createRedisBackend`、`createInMemoryBackend`)
- 单例 getter:`get<Resource>`(`getBackend`)
- Redis key:`flower:ops-bot:session:<conversationId>`(`buildKey`)

---

## Examples

- 典型工厂函数 + 惰性单例:`session-store.ts:38-43`
- 典型转换层:`tools.ts:50-58` (`toAgentTool`)
- 典型订阅循环:`handler.ts:42-72`
