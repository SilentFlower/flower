# Hook Guidelines

> `agent.subscribe` 流式事件订阅与进程信号。

---

## Overview

本包的"hook":

| 概念 | 实现 |
|------|------|
| 流式订阅 hook | `agent.subscribe((event) => { ... })`(`handler.ts`) |
| 进程信号 hook | `process.on("SIGINT" / "SIGTERM", ...)`(`server.ts`) |

---

## Custom Hook Patterns

### Agent 流式订阅

```typescript
let modelFailure: string | undefined;
const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" && update.delta) {
      accumulator += update.delta;
      await input.onChunk(accumulator, false);
    }
  } else if (event.type === "message_end" && accumulator) {
    await input.onChunk(accumulator, false);
  } else if (event.type === "agent_end") {
    const message = event.messages.at(-1);
    if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
      modelFailure = message.stopReason === "aborted" ? "模型请求已取消" : "模型请求失败";
    } else {
      await input.onChunk(accumulator, true);
    }
  }
});

try {
  await agent.prompt([...]);
  if (modelFailure) throw new Error(modelFailure);
  await persistAgent(input.conversationId, agent);
} finally {
  unsubscribe();    // 必须解订阅
  dispose();
}
```

约定:

1. **`agent.subscribe` 必须在 `try` 之前注册**,在 `finally` 中 `unsubscribe()`
2. **handler 是 async**,内部 `await input.onChunk(...)` 让上层节流生效
3. **事件类型分支用 `else if`**,不要 fall-through
4. **终止失败交回 webhook**。`agent_end` 可以携带 `error` 或 `aborted`，由 `handleMessage` 在 `prompt` 返回后抛错。失败回复沿用 webhook 的处理入口，原会话记录保留。

参考 `apps/ops-bot/src/handler.ts`。本地验收检查累积回复、失败回复、取消信号与旧 Redis 记录。

### 进程信号

```typescript
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`[ops-bot] 收到 ${signal},准备关闭`);
    server.close();
    await closeSessionStore();
    process.exit(0);
  });
}
```

约定:

- **必须处理 SIGTERM**(容器编排会用这个)
- **顺序**:`server.close()` → `await closeSessionStore()` → `process.exit(0)`
- **`process.exit(0)`** 不是 1,因为这是正常关闭

---

## Naming Conventions

- 订阅 handler:匿名 lambda
- 事件类型分支:沿用 pi 上游字符串(`"message_update"` / `"message_end"` / `"agent_end"`)

---

## Common Mistakes

- ❌ 注册了 `agent.subscribe` 但忘了 `unsubscribe`(每个请求都泄漏一个订阅 → 内存涨)
- ❌ 在 subscribe handler 内部 `throw`(会污染 agent 调用栈)
- 读取文本增量时使用 `AgentEvent` 与 `assistantMessageEvent` 的判别字段收窄类型。
- ❌ 在 `process.on("SIGINT")` 里同步退出而不关 Redis(连接泄漏 → 下次重启可能因 Redis 端连接数上限拒绝连接)
