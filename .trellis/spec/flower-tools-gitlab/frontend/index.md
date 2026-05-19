# Frontend Development Guidelines

> `@flower-ai/flower-tools-gitlab` 的工具定义层(MR 评审工具集)开发规范。

---

## Overview

本目录(`frontend/`)指 **"对外暴露的工具定义层"**。

`flower-tools-gitlab` 提供 5 个 GitLab 工具,**仅供 `code-reviewer` 加载**:`ops-bot` 不应有写 GitLab 的能力(职责隔离)。

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
2. **`severity` 是契约**:`info` / `warning` / `blocker`,`blocker` 决定 pipeline 是否 fail
3. **环境变量从 CI 注入**:`CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID` 由 GitLab CI 自动设置,沿用官方变量名(不重命名)
4. **轻量 HTTP 客户端**:故意不引 `@gitbeaker/rest`,自己包 5-6 个 endpoint(可控、bundle 小、错误信息清晰)
5. **当前是 stub 实现**:真实接入 GitLab REST API 是 TODO,但工具接口已经稳定
