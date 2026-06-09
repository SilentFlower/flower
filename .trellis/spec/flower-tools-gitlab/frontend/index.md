# Frontend Development Guidelines

> `@flower-ai/flower-tools-gitlab` 的工具定义层(MR 评审工具集)开发规范。

---

## Overview

本目录(`frontend/`)指 **"对外暴露的工具定义层"**。

`flower-tools-gitlab` 提供 9 个 GitLab 工具,**仅供 `code-reviewer` 加载**:`ops-bot` 不应有写 GitLab 的能力(职责隔离)。

| 通用前端概念 | 本包对应 |
|------|------|
| 公开 API | 5 个 ToolDefinition + `registerGitlabTools` + `gitlabClient` |
| Hook | `pi.registerTool(def)`(由 `registerGitlabTools` 调用) |
| State | 客户端单例(`cachedClient`)+ CI 注入的 env(`CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID`) |

### 包定位

- 形态:**pi 工具集库**(单产品 — `code-reviewer`)
- 入口:`packages/flower-tools-gitlab/src/index.ts`
- 工具命名约定:
  - `get_xxx`:只读
  - `post_xxx`:写操作(**仅 MR 评论**,不允许其他写)
- 工具:
  - `gitlab_get_mr_diff` — 拿 MR 完整 diff
  - `gitlab_get_mr_files` — 列被修改文件
  - `gitlab_post_comment` — 整体评论(MR 讨论区)
  - `gitlab_post_line_comment` — 行内评论(文件+行号绑定)
  - `gitlab_get_previous_review` — 查历史评论(避免重复)
  - `gitlab_get_file_content` — 拉取任意 ref 的文件行窗
  - `gitlab_list_group_projects` — 列出允许 group 下的项目
  - `gitlab_list_project_branches` — 列出允许项目的分支
  - `gitlab_prepare_project_workspace` — 准备跨项目只读工作区

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | `src/index.ts` 工具层 + `src/client.ts` HTTP 客户端 |
| [Component Guidelines](./component-guidelines.md) | 工具结构与 severity 三档约束 |
| [Hook Guidelines](./hook-guidelines.md) | `registerGitlabTools(pi)` 装配 |
| [State Management](./state-management.md) | `cachedClient` 单例、CI 环境变量 |
| [Quality Guidelines](./quality-guidelines.md) | 严格限制写操作范围(仅 MR 评论);severity 三档 |
| [Type Safety](./type-safety.md) | `severitySchema` 联合字面量,`LineCommentInput` 出参类型 |

---

## 关键设计点

1. **写操作严格限制**:只允许 MR 评论(整体 + 行内)。**不**做 push commit、改 MR 标题、改 issue 状态等写操作
2. **`severity` 是契约**:`blocker` / `major` / `minor`,`blocker` 决定 pipeline 是否 fail
3. **环境变量从 CI 注入**:`CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID` 由 GitLab CI 自动设置,沿用官方变量名(不重命名)
4. **轻量 HTTP 客户端**:故意不引 `@gitbeaker/rest`,自己包 5-6 个 endpoint(可控、bundle 小、错误信息清晰)
5. **工具描述必须教育 LLM 使用正确行号**:`gitlab_get_mr_diff` description 必须说明 hunk 内有 `add` / `ctx` / `del` 标记;`gitlab_post_line_comment.parameters.line` 必须说明只能优先使用 `add` / `ctx` 对应的新文件行号,不要直接使用 `gitlab_get_file_content` 返回的普通文件行号

## 场景: 行内评论工具定位契约(2026-06-09)

### 1. 范围 / 触发

- 触发:工具层对外暴露 `gitlab_get_mr_diff` 和 `gitlab_post_line_comment`;LLM 只能通过工具 description / parameter description 理解行号来源。
- 若工具描述只写「文件 + 行号」,LLM 容易传普通文件行号,导致客户端降级整体评论或 GitLab position 失败。

### 2. 签名

- `gitlab_get_mr_diff({})`
- `gitlab_post_line_comment({ file: string, line: number, body: string, severity: "blocker" | "major" | "minor" })`

### 3. 契约

- `gitlab_get_mr_diff.content[0].text` 必须返回已标注的 MR diff,其中 hunk 行带新文件行号和 `add` / `ctx` / `del` 类型。
- `gitlab_post_line_comment.parameters.line.description` 必须明确:行号来自 MR diff 中 `add` / `ctx` 标记的新文件行号。
- `gitlab_post_line_comment` execute 必须把客户端返回的 `posted` / `reason` / `originalLine` / `actualLine` / `relocated` 透出到 `details`,便于 trace 和 LLM 看到重定位 / 降级结果。
- `result.posted === "note_fallback"` 时,工具文本必须说明「目标行不可行内评论,已降级发表整体评论」。
- `result.relocated === true` 时,工具文本必须说明原行号到实际行号的重定位。
- quick action sanitize 仍在工具 execute 层先执行,再交给 client 发表。

### 4. 校验与错误矩阵

| 条件 | 工具返回 |
|------|----------|
| 客户端返回 `{ posted:"line", actualLine }` | content 写「行内评论已发表」;details 含 `actualLine` |
| 客户端返回 `{ posted:"line", relocated:true, originalLine, actualLine }` | content 写「行内评论已重定位发表」;details 含 `relocated:true` |
| 客户端返回 `{ posted:"note_fallback", reason, originalLine }` | content 写「目标行不可行内评论,已降级发表整体评论」;details 含 `reason` |
| body 以 GitLab quick action 起头 | sanitize 后发表;不得把原始 quick action 透传给 GitLab |

### 5. 正常 / 基线 / 错误用例

- 正常:LLM 从 `gitlab_get_mr_diff` 选择 `+ 295 add` 行,调用 `gitlab_post_line_comment.line = 295`,工具返回「行内评论已发表」。
- 基线:LLM 选择同 hunk 的 `ctx` 行,工具仍允许行内评论。
- 错误:LLM 直接用 `gitlab_get_file_content` 的第 295 行,但该行不在 MR diff hunk 中;工具可能返回重定位或降级信息,LLM 需要在后续行动中尊重 `details.actualLine` / `posted`。

### 6. 必需测试

- `client.test.ts`:客户端层覆盖 diff 标注、重定位和降级。
- 工具层测试:覆盖 `gitlab_post_line_comment` 对 `details` 的诊断字段透出。
- prompt 测试:覆盖工具描述和 reviewer prompt 都强调 `add` / `ctx` 行号来源。

### 7. 错误与正确示例

#### 错误

```typescript
line: Type.Number({ description: "文件行号" });
```

#### 正确

```typescript
line: Type.Number({ description: "MR diff 中 add/ctx 标记的新文件行号;不要直接使用文件行窗里的普通行号" });
```
