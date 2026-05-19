# Hook Guidelines

> `pi.on` 拦截 / 上报的写法。

---

## Overview

本包就是一组 pi 事件订阅。涉及的事件:

| 事件 | 用途 | 返回值约定 |
|------|------|-----------|
| `session_start` | 上报会话开始 | 无需返回(纯 side-effect) |
| `tool_call` | ① 拦截 write/edit/bash(`ci-readonly`)② 上报工具调用 | `{ block: true, reason }` 拦截 / `undefined` 放行 |
| `tool_result` | 上报工具结果 | `undefined` |

---

## Custom Hook Patterns

### 拦截 handler

```typescript
pi.on("tool_call", async (event) => {
  if (event.toolName === "write" || event.toolName === "edit") {
    return { block: true, reason: "CI 只读模式:禁止使用 write / edit 工具" };
  }
  if (event.toolName === "bash") {
    const cmd = String(event.input.command ?? "").trim();
    const firstWord = cmd.split(/\s+/)[0] ?? "";
    if (!bashAllowList.test(cmd)) {
      return {
        block: true,
        reason: `CI 只读模式:bash 命令 "${firstWord}" 不在白名单内`,
      };
    }
  }
  return undefined;
});
```

要点:

1. **返回 `undefined` 表示放行**,不要 `return true` / `return null`
2. **`reason` 要给 LLM 可读的说明**(LLM 会看到 reason 决定怎么改),写中文 OK
3. **`event.input` 字段先用 `String(... ?? "")` 兜底**,避免 LLM 传非字符串导致崩
4. **白名单用 module-level `const RegExp`**(避免每次 handler 重建)
5. **handler 必须是 async**,即使内部全同步

### 上报 handler

```typescript
pi.on("tool_call", async (event) => {
  void sendAudit({
    kind: "tool_call",
    product,
    tool: event.toolName,
    inputKeys: Object.keys(event.input ?? {}),  // 故意不上报 input 全量(可能含敏感)
    ts: Date.now(),
  });
  return undefined;
});
```

要点:

1. **`void sendAudit(...)`** —— fire and forget。**禁止 `await sendAudit(...)`**,否则 SIEM 抖动会拖垮主流程
2. **不上报 `event.input` 全量**,只上报 `Object.keys(event.input)`(防 PII 泄漏到审计)
3. **`ts: Date.now()`** —— 上报方时间戳,SIEM 自己再加接收时间
4. **`product`** 来自闭包(`registerCompliance` 的入参),不要从 event 里取

---

## Data Fetching

本包无主动数据获取,只有"被动接收 pi 事件 + 主动 POST 到 SIEM"。

`sendAudit` 内部:

```typescript
await fetch(url, {
  method: "POST",
  ...
  signal: AbortSignal.timeout(2000),  // 2 秒超时
});
```

约定:**审计请求必须有超时**(`AbortSignal.timeout`),失败仅 warn 不抛。

---

## Naming Conventions

- 拦截规则 module-level 常量:`<功能>AllowList` / `<功能>BlockList`(`bashAllowList`)
- handler 不需要命名(用 lambda)
- 事件类型名沿用 pi 上游(`"tool_call"` / `"tool_result"` / `"session_start"`)

---

## Common Mistakes

- ❌ `await sendAudit(...)` 阻塞主流程(SIEM 抖动会让所有工具调用变慢)
- ❌ 把白名单 `RegExp` 写在 handler 里(每次 handler 调用都新建对象;放 module-level `const`)
- ❌ 拦截 handler 在判断后 `throw new Error("不允许")`(应该 `return { block: true, reason }`)
- ❌ 上报全量 `event.input` 到 SIEM(可能含 token / 密码 / PII;只上报 keys)
- ❌ 给 `tool_result` 注册 handler 时,**修改** `event` 字段以"过滤敏感数据"(handler 不应该修改 event;脱敏交给具体工具的 `execute` 在返回前做,例如 `flower-tools-arms` 的 `maskSensitive`)
