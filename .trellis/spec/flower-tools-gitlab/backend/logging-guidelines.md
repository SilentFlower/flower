# Logging Guidelines

> 不打 token / diff / 评论 body。

---

## Overview

本包**几乎不打日志**。stub 实现里有 `console.log("[Stub] ...")` 仅供本地测试,真实接入后应该移除。

---

## Log Levels

| 函数 | 何时用 |
|------|--------|
| `console.log` | **不用**(stub 阶段例外) |
| `console.warn` | **不用** |
| `console.error` | 仅意外错误;前缀 `[gitlab]` |

---

## Structured Logging

不适用。

---

## What to Log

正常路径:不打。

stub 阶段(当前 `createStubClient`):

```typescript
console.log(`[Stub] post comment to ${projectId}/${mrIid} severity=${severity}: ${body}`);
```

真实接入后**删除这些 `[Stub]` 日志**。

---

## What NOT to Log

### ❌ GITLAB_TOKEN

```typescript
// 错误
console.log("[gitlab] token=", token);
```

凭证级敏感。

### ❌ MR diff

```typescript
// 错误
console.log("[gitlab] diff:", diff);
```

MR diff 是用户代码,可能包含未发布的业务逻辑 / 敏感配置。绝不打。

### ❌ 评论 body

```typescript
// 错误
console.log("[gitlab] posting comment:", body);
```

LLM 生成的评论可能引用代码片段(可能含敏感)。

### ❌ MR / project 标识(慎重)

```typescript
// 当前 stub 是 OK 的(对调试有用)
console.log(`[Stub] line comment ${projectId}/${mrIid} ${input.file}:${input.line}`);
```

真实接入时,生产日志最好不要打 project / file / line(虽然敏感度低,但属于业务信息)。

---

## 例外:debug 模式

```typescript
if (process.env.DEBUG_GITLAB === "1") {
  console.log("[gitlab] called", method, projectId, mrIid);
}
```

要求:

- 独立 env(`DEBUG_GITLAB`)
- 前缀 `[gitlab]`
- 仍不打 token / diff / body
- 默认关闭

---

## 当前 stub 的 `[Stub]` 日志

文件 `src/client.ts` 当前的 `console.log("[Stub] ...")` 是**临时**的:

- 用于本地 dev 时验证 stub 被调用
- 真实接入后**统一删除**

不要把 `[Stub]` 当 logging 范例参考。
