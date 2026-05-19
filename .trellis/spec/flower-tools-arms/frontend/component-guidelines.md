# Component Guidelines

> 工具定义的 5 字段结构。

---

## Overview

本包"组件"指 **ToolDefinition**(由 `defineTool({...})` 创建)。

每个工具有 5 个核心字段:`name` / `label` / `description` / `parameters` / `execute`。

---

## Component Structure

### 标准 ToolDefinition 模板

```typescript
export const armsQueryLogsTool = defineTool({
  name: "arms_query_logs",
  label: "ARMS 日志查询",
  description:
    "在阿里云 SLS 中查询日志。支持 SLS 查询语法,例如 'level:ERROR | select count(*)'",
  parameters: Type.Object({
    project: Type.String({ description: "SLS project 名,例如 'prod-app'" }),
    logstore: Type.String({ description: "logstore 名" }),
    query: Type.String({ description: "SLS 查询语句" }),
    from: Type.String({ description: "起始时间,ISO 字符串或相对时间('1h ago' / '15m ago')" }),
    to: Type.Optional(Type.String({ description: "结束时间,默认 'now'" })),
    limit: Type.Optional(Type.Number({ description: "返回行数上限,默认 100" })),
  }),
  async execute(_id, params, _signal) {
    // TODO: 接入真实 SDK
    const stub = `[Stub] arms_query_logs\n  project=${params.project}\n  ...`;
    return {
      content: [{ type: "text", text: maskSensitive(stub) }],
      details: { total: 0 },
    };
  },
});
```

### 字段约定

| 字段 | 类型 | 用途 |
|------|------|------|
| `name` | snake_case string | 全局唯一,LLM 通过此名调用 |
| `label` | 中文可读名 | UI / 日志展示 |
| `description` | LLM 可懂的工具说明 | 直接影响 LLM 调用决策 |
| `parameters` | `Type.Object({...})` | 参数 schema,每字段必带 description |
| `execute` | `async (id, params, signal?) => { content, details }` | 真正的工具执行逻辑 |

### `execute` 返回值结构

```typescript
{
  content: [{ type: "text", text: maskSensitive(...) }],
  details: { total: ..., /* 仅数值统计 */ }
}
```

- **`content`** 是给 LLM 看的(必须脱敏)
- **`details`** 是给 pi 框架 / 调用方看的(用于显示/审计;不放原文)

---

## Props Conventions

### `description` 是 prompt 的一部分

LLM 看 `description` 决定调不调这个工具、怎么传参。

**好**:`"在阿里云 SLS 中查询日志。支持 SLS 查询语法,例如 'level:ERROR | select count(*)'"`

**差**:`"查 SLS 日志"`(LLM 不知道支持什么语法、传什么参)

### 参数 `description` 是 schema 的一部分

LLM 看每个参数的 `description` 决定怎么传。

**好**:`Type.String({ description: "起始时间,ISO 字符串或相对时间('1h ago' / '15m ago')" })`

**差**:`Type.String({ description: "起始时间" })`(LLM 不知道格式)

### 时间参数约定

`from` / `to` 用字符串(不用 number 时间戳),支持:

- ISO 字符串(`"2026-01-01T00:00:00Z"`)
- 相对时间(`"1h ago"` / `"15m ago"` / `"now"`)

`to` 默认 `now`,作为 optional。

### `limit` 参数约定

- 类型 `Type.Number`
- Optional,默认值在 description 里写明(如 `"默认 100"`)
- 实际默认在 `execute` 里 `params.limit ?? 100`

---

## Styling Patterns

不适用。

---

## Accessibility

LLM 看到的"工具列表"是它的"UI",因此:

- `description` 要**自包含**(不要"详见文档"这种引用)
- `description` 要包含**典型用例**(让 LLM 知道何时该调)
- 参数 `description` 要**举例**(`例如 'prod-app'`)
- 工具失败时 `content` 应该返回**人类可读错误**(不是 JSON dump),让 LLM 给用户合理回复

---

## Common Mistakes

- ❌ 工具 `name` 用 camelCase(`armsQueryLogs`) — 必须 snake_case
- ❌ `description` 太短或太抽象(LLM 不知何时调)
- ❌ 参数没有 `description`(LLM 不知道怎么传)
- ❌ 返回 `content` 时漏掉 `maskSensitive(...)`(原始日志可能含 PII / 密钥)
- ❌ 在 `details` 里塞原始日志(`details` 不脱敏,且会经审计上报)
- ❌ `execute` 内自己写 try/catch swallow 错误(应该让 pi 框架接住,以便审计可见;真实接入时遇到 SDK 错误才在边界处转 user-friendly 错误)
- ❌ 把第三个参数 `signal: AbortSignal` 忽略(真实接入 SDK 时要把 signal 传给 SDK,允许 pi 框架取消)
