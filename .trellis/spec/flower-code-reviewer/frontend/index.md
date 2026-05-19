# Frontend Development Guidelines

> `@flower-ai/flower-code-reviewer` 的对外接口/入口层(CLI、prompt、skill 装配)开发规范。

---

## Overview

本项目是 Node.js / TypeScript 后端项目,**没有浏览器前端**。
本目录(`frontend/`)在本项目里重新解读为"**面向用户/调用方的入口层**":

| 通用前端概念 | 本项目对应物 |
|--------------|---------------|
| 页面 / 路由 | CLI 子命令、`process.argv` 解析(`src/args.ts`) |
| 组件 | 入口模块(`cli.ts`、`run.ts`、`extension.ts`) |
| Hook | pi 扩展工厂、`pi.on()` 事件订阅、`pi.registerTool()` |
| State Management | CLI 参数对象(`CliArgs`)、运行期上下文 |
| Accessibility | CLI 输出可读性、错误信息可操作性、`--help` 完整度 |
| Type Safety | TypeScript strict、`Type.Object` schema、参数 parse 校验 |

### 包定位

- 形态:**CLI 应用**,运行在 GitLab CI 容器内,跑完即退出
- 入口:`packages/flower-code-reviewer/src/cli.ts` → `dist/cli.js`(可执行 `flower-review`)
- 依赖:`@earendil-works/pi-coding-agent`(以 print 模式调 `piMain`)
- 触发:CI 注入 `CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID`,bot 评审 MR 并发评论

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | `src/` 目录布局与文件职责 |
| [Component Guidelines](./component-guidelines.md) | 入口模块(cli/run/extension)的拆分与签名约定 |
| [Hook Guidelines](./hook-guidelines.md) | pi 扩展工厂的注册顺序、`pi.on` 钩子用法 |
| [State Management](./state-management.md) | CLI 参数、环境变量、运行期上下文如何流转 |
| [Quality Guidelines](./quality-guidelines.md) | Biome 风格、强制要求与禁止模式 |
| [Type Safety](./type-safety.md) | TypeScript strict、`Type.Object` schema、`any` 的边界 |

---

## 写作目标

子 agent(`trellis-implement` / `trellis-check`)读完这些 spec 后应当能:

1. 知道 `cli.ts` → `run.ts` → `extension.ts` 的职责边界,不会把业务逻辑塞进 `cli.ts`
2. 写新工具时按 `defineTool({ name, label, description, parameters, execute })` 的标准结构
3. 不在 `cli.ts` / `run.ts` 里直接 console.log 评审意见(必须走 GitLab 工具)
4. 改 prompt 时知道必要的硬约束(severity 三档 / 工具优先 / 不重复评论)

---

**语言**:本目录文档用中文,代码示例 / 文件路径 / 工具名保持英文。
