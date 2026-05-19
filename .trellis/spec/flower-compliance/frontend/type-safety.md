# Type Safety

> 类型约定。

---

## Type Organization

- `ComplianceMode`:**联合字面量**,放在 `index.ts` 顶部,直接导出
- `AuditRecord`:**开放接口**,放在 `audit.ts`,导出
- file-local 接口(如内部 helper 的临时类型):**不导出**

---

## Validation

### 配置参数

`registerCompliance(pi, options)` 的 `options.mode` 通过 TypeScript 联合类型保证,不再运行期校验。
`options.product` 是字符串,运行期不校验(用错了审计字段是 caller 责任)。

### 环境变量

`SIEM_INGEST_URL`:**允许缺失**(无 url 就什么都不做)。

```typescript
const url = process.env.SIEM_INGEST_URL;
if (!url) {
  if (process.env.DEBUG_AUDIT === "1") {
    console.log("[audit]", JSON.stringify(record));
  }
  return;
}
```

---

## Common Patterns

### `AuditRecord` 用 index signature 保持开放

```typescript
export interface AuditRecord {
  kind: string;
  product: string;
  ts: number;
  [key: string]: unknown;  // 允许任意附加字段
}
```

要点:

- `kind` / `product` / `ts` 是**契约字段**,所有上报必须有
- 其他字段开放,但只能用 `unknown`,避免无意中带敏感 typed 字段

---

## Forbidden Patterns

### ❌ `any` 用于 event

```typescript
// 错误
pi.on("tool_call", async (event: any) => { ... });
```

`pi.on` 的类型由 pi 上游推断,不要主动 `: any`。
真有 pi 版本差异问题,加 `// biome-ignore lint/suspicious/noExplicitAny: pi 版本字段微调` 并注明。

### ❌ Non-null assertion 处理可能缺失的 env

```typescript
// 错误
const url = process.env.SIEM_INGEST_URL!;
```

`SIEM_INGEST_URL` **允许缺失**,必须 `if (!url) return`。

### ❌ 把 `mode` 类型扩成 `string`

```typescript
// 错误:破坏穷举性
function registerCompliance(pi: ExtensionAPI, options: { mode: string }): void { ... }
```

必须保持 `ComplianceMode` 联合字面量,新增模式时显式扩。
