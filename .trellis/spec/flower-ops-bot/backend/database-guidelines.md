# Database Guidelines

> Redis(ioredis)使用约定。

---

## Overview

`ops-bot` 唯一的"数据库"是 **Redis**,通过 `ioredis` 客户端访问。
**没有 ORM、没有 SQL、没有迁移**。所有"schema"通过 TypeScript 接口(`StoredSession`)在应用层定义。

---

## Query Patterns

### Key 规则

```
flower:ops-bot:session:<conversationId>
```

- `flower:` 项目前缀(预留未来其他产品共享 Redis)
- `ops-bot:` 产品域
- `session:` 资源类型
- `<conversationId>` 钉钉传入,不做编码(假设是安全 ID;若未来允许任意字符,需要 URL-encode 防 key 注入)

**新增 key 规则时**:

1. 必须遵循 `flower:<product>:<resource>:<id>` 四段
2. 在 `session-store.ts` 加 `buildKey` 风格的 helper,不要散落字符串拼接
3. 在 PRD / spec 同步记录

### 值规则

```typescript
interface StoredSession {
  messages: AgentMessage[];
  updatedAt: number;
}
```

- 用 `JSON.stringify` 序列化
- 反序列化必须 try/catch,失败返回 `undefined`(不要 throw)
- **不要**用 hash / list / set 等结构,简单 string + JSON 已经足够

### TTL

```typescript
const TTL_SECONDS = 60 * 60 * 24;  // 24 小时
redis.set(key, value, "EX", TTL_SECONDS);
```

- 所有 session key 必带 TTL
- 用户连续 24 小时不发消息,会话自然丢失(对运维场景可接受)

---

## Migrations

不适用(无 schema)。

如果未来 `StoredSession` 字段变化:

- **加字段**:旧数据反序列化后 field=undefined,在使用点兜底 → 无需迁移
- **删字段**:同上 → 无需迁移
- **改字段语义**:必须**改 key 前缀**(`flower:ops-bot:session-v2:`)切流,旧 key 自然 TTL 过期

---

## Naming Conventions

- key 段:`kebab-case` 或 `snake_case`?**当前用 kebab**(`session:` 单段),保持小写
- value 字段:`camelCase`(`messages`、`updatedAt`)

---

## 降级策略

```typescript
function getBackend(): SessionBackend {
  if (backend) return backend;
  const url = process.env.REDIS_URL;
  backend = url ? createRedisBackend(url) : createInMemoryBackend();
  return backend;
}
```

- `REDIS_URL` 未配置时降级到内存 Map(**仅本地开发**)
- 必须 `console.warn("[session-store] REDIS_URL 未设置,使用内存后端(仅本地开发)")`
- 生产环境部署脚本应该校验 `REDIS_URL` 存在,**不允许**意外走到内存 backend

---

## 连接管理

```typescript
const redis = new Redis(url, { maxRetriesPerRequest: 3 });
redis.on("error", (err) => console.error("[redis]", err));
```

- `maxRetriesPerRequest: 3`(超出后失败,避免 webhook 处理被无限重试拖住)
- `redis.on("error", ...)` 必加(否则 ioredis 内部 error 会让进程崩)
- 进程退出前 `redis.quit()`(`closeSessionStore` 里完成)

---

## Common Mistakes

- ❌ 在 handler 里直接 `new Redis(...)`(每次请求建连接;必须用 `session-store.ts` 单例)
- ❌ key 不带 `flower:` 前缀(可能与其他服务冲突)
- ❌ `set` 时不指定 TTL(永久 key 会让 Redis 越涨越大)
- ❌ 反序列化失败 throw(应该 `return undefined`,让上层视作"会话不存在"重新开始)
- ❌ 在 Redis 操作里 await 之前先做 `console.log`(I/O 阻塞 + 增加延迟;只在错误路径打日志)
