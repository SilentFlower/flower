# Frontend Development Guidelines

> `@flower-ai/flower-tools-common` 的工具定义层(禅道 + 钉钉文档搜索)开发规范。

---

## Overview

本目录(`frontend/`)指 **"对外暴露的工具定义层"**。

`flower-tools-common` 提供两个**跨产品通用**的工具:

- `zentao_search` — 禅道项目管理搜索(bug / 任务 / 需求 / 用例)
- `dingtalk_doc_search` — 钉钉知识库 / 文档搜索

两个产品(`code-reviewer` / `ops-bot`)都加载本包,场景:

- `code-reviewer` 评审时关联 bug / 任务
- `ops-bot` 运维问答时查规范 / SOP / 架构文档

| 通用前端概念 | 本包对应 |
|------|------|
| 公开 API | 2 个 ToolDefinition + `registerCommonTools` |
| Hook | `pi.registerTool(def)` |
| State | 无业务状态;访问令牌缓存(惰性,2 小时有效) |

### 包定位

- 形态:**pi 工具集库**(跨产品)
- 入口:`packages/flower-tools-common/src/index.ts`
- 子模块:`zentao.ts` / `dingtalk-doc.ts`

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 按外部系统切分文件(zentao / dingtalk-doc) |
| [Component Guidelines](./component-guidelines.md) | `defineTool` 结构,description 写作 |
| [Hook Guidelines](./hook-guidelines.md) | `registerCommonTools(pi)` 装配 |
| [State Management](./state-management.md) | 钉钉 accessToken 缓存策略(2h 有效) |
| [Quality Guidelines](./quality-guidelines.md) | 只读、参数 description 必填 |
| [Type Safety](./type-safety.md) | `Type.Object` schema 与枚举 |

---

## 关键设计点

1. **跨产品复用**:两个 product 包都装载,工具实现不能依赖任何一个 product 的运行环境(例如不能读 `CI_PROJECT_ID`)
2. **钉钉 accessToken 缓存**:`AppKey + AppSecret → accessToken` 调用频繁,但 token 2 小时有效,**必须惰性缓存**,否则会触发钉钉限流
3. **禅道版本兼容**:v17+ 用 Token,旧版本 session;真实接入时按版本写适配,通过环境变量区分
4. **只读**:与 `flower-tools-arms` 同样的"只读 + 脱敏"原则
