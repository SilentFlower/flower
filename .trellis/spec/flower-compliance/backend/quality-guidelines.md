# Quality Guidelines

> 见 `frontend/quality-guidelines.md`(本包前后端共用一套约束)。

---

## Backend 专项强约束

### ✅ `sendAudit` 必须 timeout

```typescript
signal: AbortSignal.timeout(2000)
```

无超时 = SIEM 挂时整个进程被拖死。

### ✅ `sendAudit` 必须 try/catch

`fetch` 在网络层抖动会抛,**必须**就地 catch + warn,不向上传播。

### ✅ `USER` / `HOSTNAME` 注入

```typescript
body: JSON.stringify({
  ...record,
  user: process.env.USER ?? process.env.USERNAME ?? "unknown",
  host: process.env.HOSTNAME ?? "unknown",
}),
```

让 SIEM 端能追溯到具体容器 / 用户身份,无需依赖 caller。

---

## Forbidden Patterns

- ❌ 在 `audit.ts` 里 `console.error("...", err); throw err;`(应只 `console.warn`,不传播)
- ❌ 给 `sendAudit` 增加返回值(调用方应 `void sendAudit(...)`,有返回值会鼓励 `await`)
- ❌ 在 `audit.ts` 里读外部模块的全局变量(`audit.ts` 应是纯函数 + 一个 helper 模块,无 import 项目其他文件)

---

## Testing Requirements

同 `frontend/quality-guidelines.md`:

- `npm run typecheck`
- `npm run check`
- `npm run build`

新增审计字段时,**手工**验证一次:`DEBUG_AUDIT=1 node packages/flower-code-reviewer/dist/cli.js --dry-run --mr-iid 1`,确认 console 中出现新字段。

---

## Code Review Checklist

- [ ] `sendAudit` 是否设置 `signal: AbortSignal.timeout(...)`
- [ ] `fetch` 是否有 `try / catch`
- [ ] 失败是否只 `console.warn`(不抛、不 error)
- [ ] 是否注入 `user` / `host` 字段
- [ ] 调用方是否用 `void sendAudit(...)`(非 await)
