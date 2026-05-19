# Component Guidelines

> ToolDefinition 结构与 description 写作。

---

## Overview

本包工具沿用 `flower-tools-arms` 的 5 字段结构(`name` / `label` / `description` / `parameters` / `execute`)。本节强调**跨外部系统**的工具差异。

---

## Component Structure

### 禅道工具

```typescript
export const zentaoSearchTool = defineTool({
  name: "zentao_search",
  label: "禅道搜索",
  description: "在禅道中搜索 bug / 任务 / 需求 / 用例。支持按关键词、产品、状态过滤",
  parameters: Type.Object({
    query: Type.String({ description: "搜索关键词,匹配标题与描述" }),
    type: Type.Optional(zentaoEntityType),
    product: Type.Optional(Type.Number({ description: "限定产品 ID(数字),不填则全局搜索" })),
    status: Type.Optional(
      Type.String({
        description: "限定状态:active / closed / resolved / pause 等,具体取值看禅道配置",
      }),
    ),
    limit: Type.Optional(Type.Number({ description: "返回数量,默认 10" })),
  }),
  async execute(_id, params, _signal) { ... },
});
```

### 钉钉文档工具

```typescript
export const dingtalkDocSearchTool = defineTool({
  name: "dingtalk_doc_search",
  label: "钉钉文档搜索",
  description:
    "在钉钉知识库 / 文档中搜索内容。可限定某个知识库空间,或全局搜索整个企业的文档",
  parameters: Type.Object({
    query: Type.String({ description: "搜索关键词" }),
    spaceId: Type.Optional(
      Type.String({ description: "限定钉钉知识库空间 ID(可选,不填则全局搜)" }),
    ),
    limit: Type.Optional(Type.Number({ description: "返回数量,默认 10" })),
  }),
  async execute(_id, params, _signal) { ... },
});
```

---

## Props Conventions

### 通用约束

| 字段 | 共性 |
|------|------|
| `query` | 关键词,必填,描述要说明"匹配什么"(标题/描述/全文) |
| `limit` | 必带,Optional,默认 10 |
| `<system>` 特有字段 | 通过 description 说明取值规则,例如禅道的 `status` 描述里附"具体取值看禅道配置" |

### 工具描述的"边界文字"

LLM 看 description 决定调不调。**写法关键**:

- 列出工具的核心能力(支持的过滤维度、返回内容)
- 不要写得太抽象(`"搜索内容"`)
- 不要写得太具体(`"调用 GET /api/v4/search 接口"` — 实现细节)

---

## Styling Patterns

不适用。

---

## Accessibility

工具应当**对 LLM 友好**:

- description 说明何时该调(`"在禅道中关联 bug / 任务时使用"`)
- 描述返回字段(`"返回:标题、ID、负责人、状态、链接"`,见 `zentao.ts` execute 内的 stub summary)
- 失败时的 content 应该是人类语言("禅道未配置,请联系管理员"),不要 JSON dump

---

## Common Mistakes

- ❌ 不同工具的 description 风格不一致(LLM 决策时困惑;尽量按 `flower-tools-arms` 风格统一)
- ❌ 工具 `name` 漏掉系统前缀(`search` vs `zentao_search`)— 必须有 system 前缀避免冲突
- ❌ 在 execute 里把禅道 API 错误 throw 出去(应该转 content;参考 `flower-tools-arms/backend/error-handling.md`)
- ❌ 用 `Type.Any` 表示"过滤条件"(应该展开为具体字段)
- ❌ 工具实现里硬编码禅道版本判断(应该走 env / 配置驱动)
