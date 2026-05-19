# Directory Structure

> `@flower-ai/flower-compliance` 的目录布局。

---

## Directory Layout

```
packages/flower-compliance/
├── src/
│   ├── index.ts      # 唯一公开入口:registerCompliance + ComplianceMode + sendAudit (re-export)
│   └── audit.ts      # sendAudit 实现 + AuditRecord 类型
├── dist/             # tsc 产物
├── package.json
└── tsconfig.json
```

---

## Module Organization

- `src/index.ts`
  - **唯一公开入口**
  - 导出:`registerCompliance(pi, options)`、`ComplianceMode`、`sendAudit`(re-export)
  - 内部:`registerCiReadOnlyGuards`、`registerAudit` 两个 file-local 函数
- `src/audit.ts`
  - **审计上报实现**
  - 导出:`AuditRecord` 接口、`sendAudit(record)`
  - 内部:封装 `fetch(SIEM_INGEST_URL)` + 超时 + 失败仅 warn

---

## Naming Conventions

- 公开函数:`register<Domain>`(`registerCompliance`)
- file-local 函数:同样动词起头(`registerCiReadOnlyGuards`),但不导出
- 类型:`PascalCase`(`ComplianceMode`、`AuditRecord`)
- 环境变量:全大写(`SIEM_INGEST_URL`、`DEBUG_AUDIT`)

---

## 边界

- **不**包含具体业务规则。例如"ARMS project 白名单"这种业务级合规属于 `ops-bot`,不属于这里
- **不**处理凭证 / 配额 / 鉴权,这些是 product 层的职责
- **只关心**:工具调用合规拦截 + 审计上报
