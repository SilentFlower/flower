# Type Safety

> severitySchema 联合字面量,客户端接口类型。

---

## Type Organization

| 类型 | 文件 | 导出 |
|------|------|------|
| `LineCommentInput` | `src/client.ts` | ✅ |
| `BotComment` | `src/client.ts` | ✅ |
| `GitlabClient` | `src/client.ts` | ✅(接口) |
| `severitySchema`(`Type.Union`) | `src/index.ts` | ❌(内部) |

---

## Validation

### 工具参数

从 `typebox` 导入 `Type` 命名空间，以 `Type.Object` 定义工具参数。pi 1.6.0 的 `defineTool` 从 TypeBox schema 推导参数类型，运行时由 pi-schema 校验。直接调用 `execute` 的测试使用 `ExtensionToolContext`，提供 `tools` 和 `executeTool` 字段。

### `severity` 三档

```typescript
const severitySchema = Type.Union([
  Type.Literal("blocker"),
  Type.Literal("major"),
  Type.Literal("minor"),
]);
```

参数 schema 将 `execute` 的 `params.severity` 推导为 `"blocker" | "major" | "minor"`。

### CI 环境变量

`readEnv()` 内做手工校验:

```typescript
const mrIid = Number.parseInt(mrIidRaw, 10);
if (Number.isNaN(mrIid)) {
  throw new Error(`CI_MERGE_REQUEST_IID 不是合法整数: ${mrIidRaw}`);
}
```

`projectId` 保留 string(GitLab API 接受 string / numeric;统一用 string 避免大数精度)。

---

## Common Patterns

### 客户端接口

```typescript
export interface GitlabClient {
  getMrDiff(projectId: string, mrIid: number): Promise<string>;
  getMrFiles(projectId: string, mrIid: number): Promise<string[]>;
  postMrComment(
    projectId: string,
    mrIid: number,
    body: string,
    severity: "blocker" | "major" | "minor",
  ): Promise<void>;
  postMrLineComment(projectId: string, mrIid: number, input: LineCommentInput): Promise<void>;
  getBotComments(projectId: string, mrIid: number): Promise<BotComment[]>;
}
```

要点:

1. **`projectId: string`**,**`mrIid: number`**(整数)
2. `severity` 直接用字面量联合(而非 `string`),编译期保证只有三档
3. `LineCommentInput` 把多个参数打包(避免 5 个 positional args)
4. `getBotComments` 返回 `BotComment[]`,接口稳定,真实实现可以变(从 REST API 字段映射)

### `BotComment` 接口

```typescript
export interface BotComment {
  id: number;
  body: string;
  file: string | undefined;
  line: number | undefined;
}
```

整体评论 → `file` / `line` 都是 `undefined`;行内评论 → 都有值。

### `LineCommentInput` 接口

```typescript
export interface LineCommentInput {
  file: string;
  line: number;
  body: string;
  severity: "blocker" | "major" | "minor";
}
```

与工具 schema 的字段对齐,便于 LLM `params` 直接当 `input` 传(参考 `src/index.ts:97-98`)。

---

## Forbidden Patterns

### ❌ `severity` 类型扩成 `string`

```typescript
// 错误
postMrComment(..., severity: string): Promise<void>;
```

破坏穷举性。必须保留字面量联合。

### ❌ `mrIid` 用 `string`

```typescript
// 错误
mrIid: string  // LLM 可能传 "100",但 GitLab API 接受 number
```

`readEnv()` 已经 parse 成 number,接口保持 number。

### ❌ `as Type` 强转 GitLab API 响应

真实接入时,GitLab 响应必须先 unknown,再窄化:

```typescript
const data = (await resp.json()) as unknown;
if (!isMrChanges(data)) throw new Error("MR changes 响应格式异常");
```

不要 `as MrChanges` 直接信任。

### ❌ `Optional<string>` 用 `?:` 而不是 `T | undefined`

项目 `exactOptionalPropertyTypes: false`,但仍建议显式 `T | undefined`(`BotComment` 已经这么写)。
