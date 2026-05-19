# Frontend Development Guidelines

> `@flower-ai/flower-tools-arms` 的工具定义层(`defineTool` + `Type.Object` schema)开发规范。

---

## Overview

本目录(`frontend/`)指 **"对外暴露的工具定义层"** — 让 LLM 看见的工具入口(`name` / `description` / `parameters`)。

`flower-tools-arms` 提供阿里云 ARMS / SLS 工具集,**仅供 `ops-bot` 加载**,`code-reviewer` 不该看监控。

| 通用前端概念 | 本包对应 |
|------|------|
| 公开 API | 4 个 ToolDefinition + `registerArmsTools` + `maskSensitive` |
| 配置参数 | 工具参数 schema(`Type.Object({...})`) |
| Hook | `pi.registerTool(def)`(由 `registerArmsTools` 调用) |
| State | `module-level const RULES`(脱敏规则) |
| Accessibility | 工具 `description` 必须 LLM 可懂、参数 `description` 决定 LLM 怎么传 |

### 包定位

- 形态:**pi 工具集库**
- 入口:`packages/flower-tools-arms/src/index.ts`
- 工具:
  - `arms_query_logs` — SLS 日志查询
  - `arms_query_metrics` — APM 指标(QPS / RT / 错误率 / 慢调用)
  - `arms_list_alerts` — 活跃告警
  - `arms_get_trace` — 调用链查询
- 辅助:`maskSensitive(text)` 工具结果脱敏

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | `src/index.ts` + `src/mask.ts` 的边界 |
| [Component Guidelines](./component-guidelines.md) | `defineTool` 的 5 字段(name/label/description/parameters/execute)结构 |
| [Hook Guidelines](./hook-guidelines.md) | `registerArmsTools(pi)` 装配点 |
| [State Management](./state-management.md) | 无业务状态;脱敏规则是 module-level immutable |
| [Quality Guidelines](./quality-guidelines.md) | 只读、脱敏、参数 schema 必带 `description` |
| [Type Safety](./type-safety.md) | `Type.Union(Type.Literal(...))` 表枚举;不用 `Type.Any` |

---

## 关键设计点

1. **全部只读**:绝不暴露写 / 删 / 改的 ARMS API
2. **结果脱敏**:`execute` 返回前必须经 `maskSensitive(text)` 处理,防 PII 经 LLM 复述泄漏
3. **可观测**:工具调用经 `flower-compliance` 自动审计上报
4. **`details` 字段不含敏感数据**:`details` 暴露给 pi 框架 / 调用方,只放数值统计,不放原文
