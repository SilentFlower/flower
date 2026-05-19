# Type Safety

> `flower-code-reviewer` 的类型策略与 `Type.Object` schema 使用约定。

---

## Overview

仓库统一 TypeScript strict 模式(见 `tsconfig.base.json`):

| 选项 | 影响 |
|------|------|
| `strict: true` | 全套严格,包含 `strictNullChecks` |
| `noUncheckedIndexedAccess: true` | 数组/对象 indexer 返回值默认 `T \| undefined` |
| `noImplicitOverride: true` | override 方法必须显式 `override` 关键字 |
| `noFallthroughCasesInSwitch: true` | `switch` case 缺 `break` 会报错 |
| `exactOptionalPropertyTypes: false` | 显式 `T \| undefined` 与 `?: T` 等价(允许传 `undefined`) |
| `module: "ESNext"` + `moduleResolution: "Bundler"` | 本地 import 必须带 `.js` 后缀 |

---

## Type Organization

### 类型放在哪里

- **入参 / 出参类型**:就近,与使用它的函数同一文件,**导出**
  - `args.ts: CliArgs`
  - `run.ts: ReviewResult`
  - `prompts.ts: BuildPromptInput`
- **跨包共享类型**:从源包 `index.ts` re-export
  - `@flower-ai/flower-tools-gitlab` 的 `LineCommentInput` / `BotComment`
- **第三方类型**:从原包 `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`,**带 `type` 关键字**

### `interface` vs `type`

- **对象形 / 可被 implements**:`interface`
- **联合类型 / 元组 / 映射类型**:`type`
- 默认偏 `interface`(允许后续扩展)

参考:`src/args.ts:8-15`(`CliArgs` 用 `interface`)

---

## Validation

### 工具参数:`Type.Object` schema(`@earendil-works/pi-ai`)

```typescript
parameters: Type.Object({
  body: Type.String({ description: "评论内容(Markdown)" }),
  severity: Type.Union([
    Type.Literal("info"),
    Type.Literal("warning"),
    Type.Literal("blocker"),
  ]),
})
```

约定:

1. **每个字段必加 `description`**(LLM 看 description 决定怎么传参)
2. **枚举用 `Type.Union(Type.Literal(...))`**,不用裸字符串
3. **可选字段** 用 `Type.Optional(...)`,不用 `?:`
4. **不要用 `Type.Any` / `Type.Unknown`**,这等于把校验交给 LLM 自由发挥

参考:`packages/flower-tools-gitlab/src/index.ts:65-81`(`gitlabPostCommentTool`)

### CLI 参数:手写 parse + `Number.parseInt` 校验

```typescript
const parsed = Number.parseInt(value, 10);
if (Number.isNaN(parsed)) throw new Error(`--mr-iid 必须是整数: ${value}`);
```

参考:`src/args.ts:30-32`

### 环境变量:就近校验,缺关键值直接抛

```typescript
const projectId = process.env.CI_PROJECT_ID;
const mrIidRaw = process.env.CI_MERGE_REQUEST_IID;
if (!projectId || !mrIidRaw) {
  throw new Error("CI_PROJECT_ID / CI_MERGE_REQUEST_IID 未设置,gitlab 工具只能在 CI 环境运行");
}
```

参考:`packages/flower-tools-gitlab/src/index.ts:135-148`

---

## Common Patterns

### `as const` 用于固定字面量类型

```typescript
input: ["text", "image"] as const,  // 类型变成 readonly ["text", "image"]
```

### Type guard 用 `is` 谓词

```typescript
function isBlockerSeverity(s: string): s is "blocker" {
  return s === "blocker";
}
```

### 默认值用 `??`,不用 `||`

```typescript
const limit = params.limit ?? 100;       // ✅ 0 不会被替换
const limit = params.limit || 100;       // ❌ 0 会被替换为 100
```

---

## Forbidden Patterns

### ❌ `any`(必要时附 `biome-ignore`)

`any` 几乎被禁。**唯一允许场景**:

- pi-coding-agent 与 pi-agent-core 在版本之间字段微调,跨包转换处临时用 `any`
- 必须加 `// biome-ignore lint/suspicious/noExplicitAny: <理由>` 注释

参考反例(合理使用):`packages/flower-ops-bot/src/tools.ts:51`

### ❌ `as Type` 强制类型断言绕过校验

```typescript
// 错误
const args = JSON.parse(body) as CliArgs;  // body 是任意字符串,断言之后无校验
```

要校验就老老实实写 `if (typeof x.field === "string")` 链或者用 `Type.Object` schema。

### ❌ Non-null assertion `!` 当魔法消除 undefined

```typescript
// 错误,strict 模式下 process.env.X 是 string | undefined
const apiKey = process.env.LLM_API_KEY!;
```

正确做法:

```typescript
const apiKey = process.env.LLM_API_KEY;
if (!apiKey) throw new Error("LLM_API_KEY 未配置");
```

### ❌ 用 `Object.keys()` 推断对象类型

`Object.keys(x)` 返回 `string[]` 而非 `keyof X`,要遍历 typed 对象用 `(Object.keys(x) as Array<keyof X>)` 显式断言并附 `biome-ignore` 说明。
