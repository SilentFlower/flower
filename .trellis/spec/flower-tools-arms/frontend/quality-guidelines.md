# Quality Guidelines

> `flower-tools-arms` 的代码质量底线。

---

## Forbidden Patterns

### ❌ 工具实现写操作

```typescript
// 错误:违反"只读"约束
export const armsMuteAlertTool = defineTool({
  name: "arms_mute_alert",
  ...
});
```

**所有 arms_* 工具必须只读**。监控 / 告警的写操作走人工工单流程,LLM 不应该有这个能力。

### ❌ 返回 `content` 时漏脱敏

```typescript
// 错误
return {
  content: [{ type: "text", text: rawLogText }],  // 原始日志可能含 PII
  details: { total: 100 },
};
```

必须 `maskSensitive(rawLogText)`。

### ❌ `details` 放原文

```typescript
// 错误
details: { rawLog: rawLogText, total: 100 }
```

`details` 暴露给 pi 框架和审计上报,**只放数值统计**(total / count / max / min)。

### ❌ 参数没有 description

```typescript
// 错误
parameters: Type.Object({
  project: Type.String(),
  ...
});
```

LLM 不知道传什么。每个参数必须 `Type.String({ description: "..." })`。

### ❌ 工具 `name` 用 camelCase

```typescript
// 错误
name: "armsQueryLogs"
```

必须 `arms_query_logs`(snake_case + 下划线分隔)。

### ❌ 在 `execute` 内 throw 业务错误

```typescript
// 错误
async execute(_id, params) {
  if (!params.project.startsWith("prod-")) {
    throw new Error("只能查 prod-* 项目");  // 业务校验应该在工具调用前
  }
}
```

工具是数据获取层。业务限制(白名单 / 用户权限)应该在 `flower-compliance` / `flower-ops-bot/auth` 层做。
工具内只允许 SDK / 网络错误 throw。

---

## Required Patterns

### ✅ 工具命名规则

| 规则 | 例子 |
|------|------|
| `<domain>_<action>` | `arms_query_logs` |
| `<action>` 是只读动词 | `query` / `list` / `get` / `search` |

### ✅ 参数 schema 必带 description

```typescript
project: Type.String({ description: "SLS project 名,例如 'prod-app'" })
```

### ✅ 必须脱敏

```typescript
return {
  content: [{ type: "text", text: maskSensitive(text) }],
  ...
};
```

### ✅ 注册集中入口

```typescript
export function registerArmsTools(pi): void { ... }
```

不要让 caller 一个个 `pi.registerTool(...)`。

### ✅ 公开 API 必有 JSDoc

每个 ToolDefinition 上方必有中文 JSDoc。

---

## Testing Requirements

- `npm run typecheck`
- `npm run check`
- `npm run build`

新增工具时:

- [ ] LLM 拿到 description 能正确决定调不调
- [ ] 参数 schema 与 SDK 真实参数一致
- [ ] 脱敏覆盖了关键场景(手机、身份证、邮箱、IP、密钥)
- [ ] 工具调用后 SIEM 审计能看到

---

## Code Review Checklist

- [ ] 工具是否只读(name / description / 实现都没有写动作)
- [ ] 参数 schema 每个字段是否都有 description
- [ ] 返回 `content` 是否 `maskSensitive` 包裹
- [ ] `details` 是否只放数值统计
- [ ] 是否新建 SDK client(应该用单例)
- [ ] `signal` 是否传给 SDK
- [ ] 工具名 / label / 描述风格是否一致
