# Error Handling

> 审计与拦截的错误处理策略。

---

## Overview

本包错误处理的**核心原则**:

> **合规与审计是辅助通道,绝不能阻塞主流程。**

---

## Error Types

不定义自定义错误类。统一使用 JavaScript 内置 `Error`,通过 `console.warn / console.error` 输出。

---

## Error Handling Patterns

### 审计失败:默认静默,调试时 warn

```typescript
try {
  await fetch(url, { ..., signal: AbortSignal.timeout(2000) });
} catch (err) {
  if (process.env.DEBUG_AUDIT === "1") {
    console.warn(`[audit] 上报失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

**约定**:

1. **try/catch 必须包住 fetch**(网络抖动 / 超时 / DNS 解析失败都要兜住)
2. **默认静默,`DEBUG_AUDIT=1` 时才 `console.warn`**,不向上传播,不抛 Error
3. **不重试**(失败就丢,主流程不能被审计拖慢)

### 拦截失败:`return { block, reason }`,不要 `throw`

```typescript
pi.on("tool_call", async (event) => {
  if (event.toolName === "write") {
    return { block: true, reason: "CI 只读模式:禁止 write" };
  }
  return undefined;
});
```

**约定**:

1. **判断不通过时 `return { block: true, reason: "..." }`**,reason 是给 LLM 看的可读说明
2. **绝不 `throw new Error("...")`**(会污染 pi 调用栈,LLM 看不到原因)
3. **判断逻辑必须同步**(handler 是 async 但内部不 await 外部 IO)

### 输入兜底:`String(... ?? "")` 而不是断言

```typescript
const cmd = String(event.input.command ?? "").trim();
```

LLM 偶尔会传非字符串,断言 `as string` 会运行期崩。

---

## API Error Responses

本包无 API。

`sendAudit` 是单向调用,失败不向调用方传播。

---

## Common Mistakes

- ❌ `await sendAudit(...)` 阻塞主流程(SIEM 抖动会让所有工具调用变慢)
- ❌ 拦截规则失败 `throw new Error("禁止 X")`(应 `return { block: true, reason }`)
- ❌ 给 `fetch` 不配 `AbortSignal.timeout`(网络挂时进程会一直 hang)
- ❌ 默认情况下打印审计失败日志(SIEM 抖动不应刷屏 CI;需要 `DEBUG_AUDIT=1` 才 warn)
- ❌ 把 `err instanceof Error` 当兜底逻辑(`console.warn("...", err)` 直接传 err 即可,Node 会自动 stringify)
