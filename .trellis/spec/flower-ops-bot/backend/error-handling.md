# Error Handling

> 后端错误处理策略。

---

## Overview

`ops-bot` 后端的错误处理原则:

1. **fail-open**:Redis / SIEM / 流式推送失败,不影响主流程
2. **用户感知必须降级**:agent 处理失败必须 push 错误提示,不能让用户一直等
3. **抛错限制在 fail-fast 启动期**:`pickModel` 缺凭证 / `LLM_API_KEY` 缺 → 进程退出

---

## Error Types

不定义自定义错误类。统一用 JavaScript 内置 `Error`。

理由:错误处理策略由 **位置** 决定(webhook 内 / 后台内 / 启动期),不由 **类型** 决定。多写一层错误类反而模糊责任。

---

## Error Handling Patterns

### 1. webhook 主路径 try/catch

```typescript
const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error("[ops-bot] 处理请求出错:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
  }
});
```

- 外层 catch 兜底
- `headersSent` 守卫,避免 "Cannot set headers after they are sent" 二次报错

### 2. 后台 agent 任务 try/catch + push 错误

```typescript
queueMicrotask(async () => {
  try {
    await handleMessage({ ... });
  } catch (err) {
    console.error("[ops-bot] 处理消息失败:", err);
    await pushToSession(
      payload.sessionWebhook,
      `抱歉,处理出错了:${err instanceof Error ? err.message : String(err)}`,
      true,
    ).catch(() => {});
  }
});
```

约定:

- **必须 push 用户可见错误**(不要让用户在那干等)
- **`err.message` 是 LLM 系统错误的描述,不是 PII**(可以直接展示)
- **push 失败再 catch 一次**(`.catch(() => {})`),避免日志噪音

### 3. Redis 失败:就近 try/catch + 返回兜底值

```typescript
async get(key) {
  const value = await redis.get(key);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as StoredSession;
  } catch {
    return undefined;
  }
},
```

- `redis.get` 网络失败 → 在 `getSession` 调用点会向上传播
- `JSON.parse` 失败 → 内部兜底为 `undefined`
- 上层 `getOrCreateAgent` 收到 `undefined` → 当作新会话处理

### 4. 流式推送失败:warn 不抛

```typescript
try {
  await fetch(sessionWebhook, ...);
} catch (err) {
  console.warn("[ops-bot] 推送钉钉失败:", err);
}
```

- 钉钉 sessionWebhook 5 分钟有效,失败重试也没用
- 仅 warn,绝不重试,绝不抛错阻塞 subscribe handler

### 5. 启动期失败:fail-fast

```typescript
if (!baseUrl) {
  throw new Error("LLM_BASE_URL 环境变量未配置");
}
```

- 缺关键凭证 / URL 直接 throw,进程退出码 ≠ 0,容器编排会拉起 / 报警
- **不要**在运行时反复检查并 fallback(凭证不会突然出现)

---

## API Error Responses

JSON 固定结构:

```json
{ "error": "<snake_case_code>" }
```

| 状态码 | code | 何时返回 |
|--------|------|---------|
| 400 | bad_json | request body 不是合法 JSON |
| 401 | invalid_signature | 钉钉签名校验失败 |
| 404 | not_found | URL 不匹配任何路由 |
| 500 | internal_error | 顶层 catch 兜底 |

新增错误码必须用 snake_case,不要 mix camelCase。

---

## Common Mistakes

- ❌ 后台任务漏 try/catch → 用户一直等,进程内部出现 unhandledRejection
- ❌ Push 失败再 throw → 污染 subscribe 调用栈,后续 chunk 丢失
- ❌ 把 `err.stack` 直接 push 给用户(用户体验差;只 push `err.message`)
- ❌ Redis 失败 throw 阻塞 webhook(应该让 `getSession` 在网络失败时返回 undefined,等于"新会话")— 当前实现传播到上层,可在 `agent-factory.ts:getOrCreateAgent` 处加防御 catch
- ❌ webhook 校验失败 throw 让外层 catch(应该当场 `res.writeHead(401)` 返回)
