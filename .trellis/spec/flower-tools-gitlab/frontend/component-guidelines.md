# Component Guidelines

> 工具结构与 severity 三档约束。

---

## Overview

本包工具沿用 `flower-tools-arms` 的 5 字段结构,本节强调本包特有的:

- 工具按 `get_*` / `post_*` 命名区分只读 / 写
- `severity` 三档是契约
- `readEnv()` 集中读 CI 注入变量

---

## Component Structure

### 标准工具

```typescript
export const gitlabPostLineCommentTool = defineTool({
  name: "gitlab_post_line_comment",
  label: "发表行内评论",
  description: "在 MR 的具体文件、具体行号上发表评论。必须传文件路径和行号",
  parameters: Type.Object({
    file: Type.String({ description: "文件路径(相对仓库根)" }),
    line: Type.Number({ description: "行号(变更后的行号)" }),
    body: Type.String({ description: "评论内容(Markdown)" }),
    severity: severitySchema,
  }),
  async execute(_id, params) {
    const { projectId, mrIid } = readEnv();
    await gitlabClient().postMrLineComment(projectId, mrIid, params);
    return {
      content: [{ type: "text", text: `行内评论已发表: ${params.file}:${params.line}` }],
      details: { severity: params.severity, file: params.file, line: params.line },
    };
  },
});
```

要点:

1. **`readEnv()` 在 `execute` 内调**(而非顶层 import time),让缺 env 时工具单独失败而非整个 import 崩
2. **写工具的成功 content 给出操作摘要**(`行内评论已发表: file:line`),让 LLM 知道做了什么
3. **`details` 暴露 severity / file / line** 给 pi 框架,审计上报会用到
4. **行内评论的 `line`** 是**变更后的行号**(GitLab `new_line`),不是原行号

---

## Props Conventions

### severity 三档

```typescript
const severitySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("blocker"),
]);
```

| 档位 | 何时使用 |
|------|----------|
| `info` | 风格 / 命名 / 建议性 |
| `warning` | 一般问题(性能、设计、可读性) |
| `blocker` | 安全漏洞、逻辑错误、合规硬要求 |

`blocker` 触发 pipeline fail。**严格使用**,不轻易打 blocker(prompt 里已强约束)。

### `file` 路径

- 相对仓库根(`packages/foo/src/bar.ts`),**不**绝对路径
- 不带 `/` 前缀
- 描述里明确说明(LLM 会按描述传)

### `line` 行号

- `Type.Number`(允许 LLM 传整数)
- 描述说明"变更后的行号"(避免传旧行号)

### body

- Markdown 字符串
- 描述要说明"评论内容(Markdown)"
- 长度不强制限制(GitLab 支持长评论)

---

## Styling Patterns

不适用。

---

## Accessibility

工具给 LLM 的"可访问性":

- description 写明"在 MR 的讨论区"vs"在具体文件、具体行号",LLM 才知道选哪个
- 行内评论的"必须传文件路径和行号"显式提示,避免 LLM 把行号留空
- 严格 severity 三档,LLM 不会随意发明新档位

---

## Common Mistakes

- ❌ 新增 `gitlab_update_mr_title` 等写工具(职责范围只允许评论)
- ❌ `readEnv()` 放在模块 top level(`import` 时就需要 env,但 `code-reviewer` import 本包未必有 CI env)
- ❌ `line` 字段用 `Type.String`(LLM 会传 "100" 而非 100)
- ❌ 行内评论的 `line` 误用旧行号(应该用变更后的 new_line)
- ❌ severity 增加第四档(`hint` / `critical` 等;只允许三档,改要先改 prompts.ts)
- ❌ 写工具 content 返回失败信息时 throw(应该让上游处理或转 content)
