# Backend Development Guidelines

> `@flower-ai/agent-runtime` 共享 pi 运行时开发规范。Desktop 与企业宿主（含 code-reviewer）共用同一份产物。

---

## Overview

共享运行时为每个主体与会话串行执行请求：校验宿主授权，装配 pi Agent，把运行进度提交为会话快照，再把同序事件通知宿主。

| 模块 | 职责 |
|------|------|
| `src/types.ts` | 对宿主公开的唯一协议：`RuntimeEvent`、`RequestRecord`、`ToolStep`、`SessionGrant`、`SessionStore` |
| `src/index.ts` | `SessionRunner`：排队、运行、`recordProgress` 记录进度、`commit` 落盘并通知 |
| `src/context-window.ts` | 长会话窗口估算、检查点摘要与模型投影 |

宿主通过 `node_modules/@flower-ai/agent-runtime → packages/agent-runtime` 的 `dist/` 引用。改 `src/*.ts` 后执行 `npm run build -w @flower-ai/agent-runtime`，宿主与本包的 vitest 才会看到新代码。

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Event Persistence](./event-persistence.md) | 每个运行事件整份落盘；新增持久化字段随既有事件提交，瞬时展示信息走宿主旁路；事件与记录字段的兼容规则 |

---

## Pre-Development Checklist

- 改 `RuntimeEvent` 或 `RequestRecord` 前读 [Event Persistence](./event-persistence.md)。
- 新增字段一律可选或由运行时自行填写，宿主不提供时行为不变；不新增事件种类，除非同步更新 `test/dual-host.test.ts` 的事件序列断言并确认两个宿主都能处理。
- 改完运行 `npm run build -w @flower-ai/agent-runtime`、`npm test -w @flower-ai/agent-runtime`、`npm test -w @flower-ai/flower-code-reviewer` 与 Desktop 的 `npm test`。
