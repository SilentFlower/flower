# Component Guidelines

> route / handler / push 的签名约定。

---

## Overview

本包"组件"指 **入口处理函数**:`route`、`handleDingTalkWebhook`、`pushToSession`、`handleMessage`。

---

## Component Structure

### HTTP 路由

```typescript
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { method, url } = req;

  if (method === "GET" && url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === "POST" && url === "/dingtalk/webhook") {
    await handleDingTalkWebhook(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}
```

约定:

1. **顶层 `try/catch` 在 `createServer` 回调里统一处理**,`route()` 自己不再包 try/catch
2. **每个分支单独 `return`**,不要 fall-through
3. **JSON 响应固定结构**:成功 `{ ok: true, ... }`,失败 `{ error: "<code>" }`(snake_case)
4. **HTTP 状态码语义化**:404 not_found / 401 invalid_signature / 400 bad_json / 500 internal_error

### Webhook 处理(关键模式:立即应答)

```typescript
export async function handleDingTalkWebhook(req, res): Promise<void> {
  // 1. 鉴权
  if (!verifySignature(...)) {
    res.writeHead(401, ...); res.end(...);
    return;
  }

  // 2. 解析(失败 400)
  let payload: DingTalkRequest;
  try { payload = JSON.parse(body); } catch { res.writeHead(400, ...); return; }

  // 3. 立即应答 200,避免 5 秒超时
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({}));

  // 4. 后台跑
  queueMicrotask(async () => { ... });
}
```

**核心约束**:

- **`res.end({})` 必须在调用 agent 之前**。钉钉 5 秒超时 = 5 秒内没收到 200 就会重发,造成重复处理
- **后台任务用 `queueMicrotask`**,不要 `setImmediate`(语义不同;`queueMicrotask` 在当前事件循环 tick 末尾立刻执行)
- **后台 try/catch 必须自己处理**,主流程已经 `res.end()` 没法再传错回去

### Push 推送

```typescript
export async function pushToSession(
  sessionWebhook: string,
  text: string,           // 累积全文,不是 delta
  isFinal: boolean,
): Promise<void>
```

约定:

- 入参 `text` 是**累积全文**(钉钉 API 的契约,每次推送都是替换前一次)
- 节流 500ms,但 **`isFinal: true` 必须无条件推**(否则最后一次更新会丢)
- 失败仅 `console.warn`,不向上传播

---

## Props Conventions

| handler | 入参 | 说明 |
|---------|------|------|
| `route(req, res)` | Node 内置 `IncomingMessage / ServerResponse` | 不要包装 |
| `handleDingTalkWebhook(req, res)` | 同上 | 同上 |
| `handleMessage(input)` | `HandleMessageInput` 对象 | `conversationId` / `userId` / `userName` / `text` / `onChunk` 必填 |
| `getOrCreateAgent(input)` | `AgentFactoryInput` 对象 | `conversationId` / `userId` / `userName` 必填 |
| `pushToSession(url, text, isFinal)` | 位置参数 | URL → 内容 → 是否结束,固定顺序 |

新增 handler 时:

- 超过 2 个参数 → 改 `input` 对象
- 入参类型必须导出(`HandleMessageInput`、`AgentFactoryInput`),便于测试时手动构造

---

## Styling Patterns

不适用。Biome 配置统一。

---

## Accessibility

钉钉用户体验:

- **5 秒内必须 200**(否则钉钉重发,用户看到双倍消息)
- **错误降级提示**:agent 跑错时 push 一条"抱歉,处理出错了:..."(见 `webhook.ts:81-87`)
- **流式输出节流 500ms**:既要"看起来在打字"也要别让钉钉限流
- **不复述敏感数据**:LLM 系统提示词里写明,但本层不做校验(`flower-tools-arms` 在工具结果里已脱敏)

---

## Common Mistakes

- ❌ 在 `handleDingTalkWebhook` 里 `await handleMessage(...)` 后再 `res.end()`(必然超 5 秒;**先 end 再后台跑**)
- ❌ 在 push 节流逻辑里把 `isFinal` 当一般情况处理(漏掉最后一帧 → 用户看到的是中间状态)
- ❌ 把 Redis 错误 throw 出来阻塞 webhook 响应(应该降级到内存或者忽略,会话状态丢一次比阻塞服务好)
- ❌ 在 `pushToSession` 失败时重试(钉钉 sessionWebhook 5 分钟有效,重试也没用,丢了就丢了;最后通过 `isFinal` 兜底)
- ❌ 把 `OPS_SYSTEM_PROMPT` 改成"如果对方问写操作,可以尝试……"(系统提示词必须保持只读限制,不能给口子)
