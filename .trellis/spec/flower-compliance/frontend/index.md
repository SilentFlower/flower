# Frontend Development Guidelines

> `@flower-ai/flower-compliance` 的对外接口层(扩展工厂、`pi.on` 注册)开发规范。

---

## Overview

本项目无浏览器前端。本目录(`frontend/`)指 **"对外暴露的 API 层"**:

`flower-compliance` 是 pi 扩展库,**对外只暴露一个函数 `registerCompliance` + 一个类型 `ComplianceMode`**,以及一个透传的 `sendAudit` 工具。

| 通用前端概念 | 本包对应 |
|------|------|
| 公开 API | `export function registerCompliance(pi, options)` |
| 配置参数 | `{ mode: "ci-readonly" \| "production-readonly", product: string }` |
| Hook | `pi.on("tool_call" / "tool_result" / "session_start", handler)` |
| State | 无可变状态(纯事件订阅) |

### 包定位

- 形态:**pi 扩展库**(无可执行入口,被 `code-reviewer` / `ops-bot` 加载)
- 入口:`packages/flower-compliance/src/index.ts`
- 职责:
  - 在 CI 只读模式下,拦截 write / edit / bash 危险工具
  - 不论何种模式,把工具调用全量上报到审计端点

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | `src/` 文件职责与边界 |
| [Component Guidelines](./component-guidelines.md) | `registerCompliance` 的签名约定 |
| [Hook Guidelines](./hook-guidelines.md) | `pi.on` 拦截 / 上报的写法 |
| [State Management](./state-management.md) | 无状态原则、配置参数流向 |
| [Quality Guidelines](./quality-guidelines.md) | 强约束、禁止模式 |
| [Type Safety](./type-safety.md) | `ComplianceMode` 联合类型、`AuditRecord` 开放字段 |

---

## 关键设计点(读完这些 sub-agent 就不会写错)

1. **`registerCompliance` 内部必须按 `mode` 分支**;`ci-readonly` 额外注册 `tool_call` 拦截,所有模式都注册审计
2. **审计 handler 一律 fire-and-forget**(`void sendAudit(...)`),失败不影响主流程
3. **拦截规则集中**:任何"禁用 write / 限制 bash"的逻辑都写在这里,不要散落到 product 包
4. **`AuditRecord` 字段开放**(`[key: string]: unknown`),但 `kind` 是契约字段,新增 kind 时要同步更新 SIEM 端
