# Hook Guidelines

> `agent.subscribe` 事件订阅 + 工具装配。

---

## Overview

本包的"hook":

| 概念 | 实现 |
|------|------|
| 流式订阅 hook | `agent.subscribe((event) => { ... })`(`handler.ts`) |
| 工具装配 hook | `buildToolList(ctx)`(`tools.ts`) |
| 进程信号 hook | `process.on("SIGINT" / "SIGTERM", ...)`(`server.ts`) |

本包**不直接**调用 `pi.on(...)`,合规拦截由 `@flower-ai/flower-compliance` 接管。

---

## Custom Hook Patterns

### Agent 流式订阅

```typescript
const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
  if (event.type === "message_update") {
    const delta = extractDelta(event);
    if (delta) {
      accumulator += delta;
      await input.onChunk(accumulator, false);
    }
  } else if (event.type === "message_end") {
    await input.onChunk(accumulator, false);
  } else if (event.type === "agent_end") {
    await input.onChunk(accumulator, true);
  }
});

try {
  await agent.prompt([...]);
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
4. **`extractDelta` 是兜底**:pi 版本之间事件结构略有不同,集中在一个 helper 里处理

参考:`src/handler.ts:42-87`

### 工具装配

```typescript
export function buildToolList(ctx: { userId: string }): AgentTool<any>[] {
  void ctx;  // 当前未用,留给未来按用户筛工具
  return [
    toAgentTool(armsQueryLogsTool),
    toAgentTool(armsQueryMetricsTool),
    ...
  ];
}
```

约定:

1. **`ctx` 必传**,即使当前不用(`void ctx` 显式标记保留),便于将来按用户筛工具
2. **`toAgentTool`** 是 ToolDefinition → AgentTool 的最小转换(只重包 `name` / `description` / `parameters` / `execute`)
3. **工具顺序无关**,但保持"先 arms 后 common"的可读性

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

## Data Fetching

数据获取通过 LLM 的工具调用,具体由各 tools 包(`@flower-ai/flower-tools-arms`、`@flower-ai/flower-tools-common`)实现,本包不直接 fetch 外部 API。

例外:`pushToSession` 是**主动 POST 钉钉**,这是回写,不是获取。

---

## Naming Conventions

- 订阅 handler:匿名 lambda
- 事件类型分支:沿用 pi 上游字符串(`"message_update"` / `"message_end"` / `"agent_end"`)
- 工具转换 helper:`to<目标类型>`(`toAgentTool`)

---

## Common Mistakes

- ❌ 注册了 `agent.subscribe` 但忘了 `unsubscribe`(每个请求都泄漏一个订阅 → 内存涨)
- ❌ 在 subscribe handler 内部 `throw`(会污染 agent 调用栈)
- ❌ `extractDelta` 用 `as any` 强转后直接访问字段(应该用 `event?.assistantMessageEvent?.type === "text_delta"` 链式可选)
- ❌ 在 `buildToolList` 内部读 `process.env` 决定要不要加工具(应该让 `agent-factory.ts` / `extension.ts` 集中读环境)
- ❌ 在 `process.on("SIGINT")` 里同步退出而不关 Redis(连接泄漏 → 下次重启可能因 Redis 端连接数上限拒绝连接)
