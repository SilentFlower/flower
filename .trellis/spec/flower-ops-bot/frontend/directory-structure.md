# Directory Structure

> `@flower-ai/flower-ops-bot` 的目录布局。

---

## Directory Layout

```
packages/flower-ops-bot/
├── src/
│   ├── server.ts             # HTTP 入口:监听端口、路由表、优雅关闭
│   ├── dingtalk/
│   │   ├── webhook.ts        # POST /dingtalk/webhook 处理(应答 + 后台跑)
│   │   ├── push.ts           # 流式推回钉钉 sessionWebhook(500ms 节流)
│   │   └── signature.ts      # 钉钉签名校验(HMAC-SHA256 + 防重放)
│   ├── handler.ts            # 消息处理主流程(agent.prompt + 流式订阅)
│   ├── agent-factory.ts      # 按 conversationId 构造 / 持久化 Agent
│   ├── session-store.ts      # Redis 后端 + 内存降级
│   ├── tools.ts              # ToolDefinition → AgentTool 转换 + 工具装配
│   └── prompts.ts            # OPS_SYSTEM_PROMPT(系统提示词)
├── dist/
├── Dockerfile                # 基础镜像 node:22,EXPOSE 3000
├── package.json
├── tsconfig.json
└── README.md
```

---

## Module Organization

### 入口层

- **`server.ts`**:监听端口,把 `req/res` 分发到 `route()`。路由表是手写 `if (method === ... && url === ...)`,**不用框架**(express / fastify)。
- **`dingtalk/webhook.ts`**:处理 `POST /dingtalk/webhook`,核心是"立即 200 应答 → `queueMicrotask` 跑 agent → 失败 push 错误提示"。

### 消息处理层

- **`handler.ts`**:`handleMessage(input)` 主流程。订阅 `agent` 事件 → 累积文本 → 调 `onChunk` 推回 → 持久化会话。
- **`agent-factory.ts`**:`getOrCreateAgent` / `persistAgent`。**当前实现是无缓存的**,每个请求重建 Agent。如果并发上去再考虑 LRU(注意多副本一致性)。

### 存储与外部 API

- **`session-store.ts`**:Redis 后端,环境无 `REDIS_URL` 时自动降级到内存 Map(仅本地开发)。
- **`tools.ts`**:把 `@flower-ai/flower-tools-arms` / `@flower-ai/flower-tools-common` 的 `ToolDefinition` 转成 `pi-agent-core` 的 `AgentTool`。
- **`dingtalk/push.ts`**:流式推送回钉钉 sessionWebhook。
- **`dingtalk/signature.ts`**:HMAC-SHA256 签名校验 + 1 小时防重放。

### 配置

- **`prompts.ts`**:`OPS_SYSTEM_PROMPT` 系统提示词,**写死**(只读、技术风、不啰嗦)。

---

## Naming Conventions

- 文件名 `kebab-case.ts`(`agent-factory.ts`、`session-store.ts`)
- 子目录按"外部协议域"切(`dingtalk/`),不按"层次"切(没有 `service/` / `controller/`)
- 函数名 `camelCase`(`handleMessage`、`getOrCreateAgent`、`pushToSession`)
- 类型 `PascalCase`(`AgentFactoryInput`、`DingTalkRequest`、`StoredSession`)
- 环境变量:`PORT` / `REDIS_URL` / `DINGTALK_BOT_SECRET` / `LLM_BASE_URL` / `LLM_API_KEY`
- Redis key:`flower:ops-bot:session:<conversationId>`(`flower:` 是项目前缀,`ops-bot:` 是产品域)

---

## Examples

- 干净的路由分发样例:`src/server.ts:46-64`
- 5 秒应答模式:`src/dingtalk/webhook.ts:65-89`(立即 `res.end()` 再 `queueMicrotask`)
- 节流推送:`src/dingtalk/push.ts:21-32`

---

## 反模式

- ❌ 在 `server.ts` 用 express / fastify(违反"故意只用 Node 内置 http"原则,见 `server.ts:6` 注释)
- ❌ 把消息处理逻辑写在 `webhook.ts`(应该在 `handler.ts`)
- ❌ 把 Redis client 实例放在 `handler.ts` module-level(应该集中在 `session-store.ts`,惰性初始化)
