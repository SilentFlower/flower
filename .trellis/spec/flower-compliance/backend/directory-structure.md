# Directory Structure

> 见 `frontend/directory-structure.md`。

---

## Directory Layout

```
packages/flower-compliance/
├── src/
│   ├── index.ts      # registerCompliance + ComplianceMode + sendAudit (re-export)
│   └── audit.ts      # 后端(backend)层:sendAudit 实现 + AuditRecord 类型
├── dist/
├── package.json
└── tsconfig.json
```

---

## Module Organization

`audit.ts` 的职责边界:

- 接收一个 `AuditRecord`,通过 `fetch` 单向 POST 到 SIEM
- 自动注入 `user` / `host` 字段(来自 `process.env.USER` / `HOSTNAME`)
- 失败仅 `console.warn`,不抛错
- 无内部状态(每次调用独立)

**不属于**本模块的事:

- ❌ 决定哪些 event 要上报(那是 `index.ts` 里 handler 的事)
- ❌ 决定脱敏规则(那是各工具自己的事,如 `flower-tools-arms/src/mask.ts`)
- ❌ 批量缓冲(应该让 SIEM 负责聚合,本端不缓存)

---

## Naming Conventions

- 导出函数:`send<Action>`(`sendAudit`)
- 类型:`PascalCase`(`AuditRecord`)
- 环境变量:`SIEM_INGEST_URL`、`DEBUG_AUDIT`

---

## Examples

参考实现:`packages/flower-compliance/src/audit.ts:25-50`(完整的 `sendAudit`)
