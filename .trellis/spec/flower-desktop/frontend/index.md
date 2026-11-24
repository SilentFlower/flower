# Frontend Development Guidelines

> `@flower-ai/flower-desktop` Windows 桌面工作台（Electron 45，原生 DOM）开发规范。

---

## Overview

| 层 | 位置 | 职责 |
|---|---|---|
| Main | `workbench/main.mjs` | 窗口、原生菜单与通知、preload IPC 处理器；逐项复核发送窗口、当前会话、请求归属与工作区路径 |
| Host | `workbench/runtime-host.mjs` | 管理 worker 子进程，转发事件、模型流与写入审批 |
| Worker | `workbench/worker.mjs` | 装配共享运行时、工作区工具与附件读取；推理预览等瞬时信息在此旁路 |
| Renderer | `workbench/renderer.js`、`workbench/ui/*.js` | 界面与交互；组件目录见 [workbench/ui/README.md](../../../../apps/desktop/workbench/ui/README.md) |

渲染层的权限请求一律被拒绝，CSP 只允许 `self` 与 `blob:` 图片：剪贴板、通知、右键菜单、文件定位都经 Main IPC 完成，图片用 blob URL 显示。

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Windows Verification](./windows-verification.md) | Playwright `_electron` 实机验收脚本：私有桌面运行、主进程替身、收尾与超时、前台焦点的限制 |

> 共享运行时的事件持久化契约见 [agent-runtime backend spec](../../agent-runtime/backend/index.md)。

---

## Pre-Development Checklist

- 新增 Main 的 electron 具名导入（如 `Notification`）时，同步补到 `testing/workspace-panel.test.mjs` 的假 electron 模块导出列表，否则该测试在导入阶段失败。
- 新增 preload 接口要在 `preload.cjs` 与 `main.mjs` 的 `handle` 两侧同时出现，处理器先校验会话为当前选中会话、路径经 `workspace.mjs` 的 `locate` 校验。
- 改动后运行 `cd apps/desktop && npm test`、`npx biome check apps/desktop`；涉及 Windows 行为时按 [Windows Verification](./windows-verification.md) 打包并实机验收。
