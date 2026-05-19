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

`Type.Object` schema,详见 `flower-tools-arms/frontend/type-safety.md`。

### `severity` 三档

```typescript
const severitySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("blocker"),
]);
```

参数 schema 已限定,`execute` 内 `params.severity` 类型自动是 `"info" | "warning" | "blocker"`。

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
    severity: "info" | "warning" | "blocker",
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
  severity: "info" | "warning" | "blocker";
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
