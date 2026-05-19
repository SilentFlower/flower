# State Management

> conversationId / Redis / 进程内节流的状态划分。

---

## Overview

`ops-bot` 是长驻 HTTP 服务,有 3 类状态:

| 类型 | 载体 | 生命周期 | 多副本一致性 |
|------|------|----------|--------------|
| 会话(messages) | Redis(降级内存) | 24h TTL | Redis 一致;内存仅本地 |
| 节流时间戳 | 进程内 `Map<sessionWebhook, lastPushAt>` | 进程级 | **副本间不共享**(可接受,每个会话通常落在同一副本) |
| 进程级单例 | `agentFactory` 缓存(目前无) / Redis client | 进程级 | 单进程 |

---

## State Categories

### 1. 会话 messages(Redis)

```
key:   flower:ops-bot:session:<conversationId>
value: JSON.stringify({ messages: AgentMessage[], updatedAt: number })
TTL:   86400  (24 小时)
```

- **谁写**:`persistAgent(conversationId, agent)` 在 `handleMessage` 末尾
- **谁读**:`getOrCreateAgent` 在 webhook 进来时
- **失败语义**:Redis 抖动时,**当前请求处理仍要继续**(可能丢一次会话上下文,但比阻塞服务好)

### 2. 节流时间戳(进程内 Map)

```typescript
const lastPushAt = new Map<string, number>();
```

- **谁写**:`pushToSession` 每次非 final 推送
- **谁清**:`isFinal: true` 时 `delete`
- **多副本**:不共享。**但**一个 conversationId 通常 sticky 到同一副本(钉钉重试默认走同一路径),不共享通常不构成问题
- **内存**:每个未结束的 session 占一个 entry,正常情况 5 分钟内会被 delete,内存压力很小

### 3. Redis client(单例)

```typescript
let backend: SessionBackend | undefined;
```

惰性初始化,通过 `getBackend()` 拿。**进程退出时 `closeSessionStore()` 必调用**。

---

## When to Use Global State

允许 module-level mutable 的**唯一场景**:

- 单例外部连接(Redis client)
- 短生命周期的进程内节流(`lastPushAt`)

**禁止**:

- ❌ 用全局对象存"当前用户"(应该走参数传递)
- ❌ 用全局 Map 存会话(应该走 Redis;在 `session-store.ts` 的内存降级里只是 fallback)

---

## Server State

钉钉是**事件驱动**模型,本服务没有"轮询钉钉拉数据"的需求。

- **入站**:钉钉 webhook 触发 → 我们 200 应答 + 后台处理
- **出站**:`pushToSession` 主动 POST 钉钉 sessionWebhook

### 多副本部署

- **必须**用 Redis(`REDIS_URL` 必填)。内存降级**仅本地开发**
- **不需要**严格的连接 sticky,因为消息处理完成后状态就在 Redis 了
- **不要**用 `pubsub` 来跨副本同步状态(过早优化)

---

## Common Mistakes

- ❌ 把 Redis 失败 throw 出去(导致 webhook 5 秒超时;Redis 是辅助状态,失败时 messages = [] 让 LLM 重新开始一次对话也比不响应好)
- ❌ 在 `agent-factory.ts` 加 LRU 缓存 `Agent` 实例(当前无缓存 = 简单可预测;真要加,先在 PRD 里把多副本一致性策略写明)
- ❌ 把 `lastPushAt` 大小不设上限(理论上恶意 sessionWebhook 可以撑爆内存;实际有 5 分钟有效期 + delete on final,但仍可考虑加上限)
- ❌ 用进程内 `Map<conversationId, AgentInstance>` 实现"会话粘性"(违反"无状态服务"原则,多副本会失忆)
