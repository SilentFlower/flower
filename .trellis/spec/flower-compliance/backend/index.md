# Backend Development Guidelines

> `@flower-ai/flower-compliance` 的内部实现层(审计上报、拦截规则)开发规范。

---

## Overview

`flower-compliance` 是 pi 扩展库,**内部只有 1 个实现模块**:

- `src/audit.ts`:封装 `sendAudit(record)`,异步 POST 到 SIEM 端点

本目录(`backend/`)关心**这 1 个模块**:错误处理、日志、配置、副作用边界。

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 与 `frontend/` 一致(本包只有 2 文件) |
| [Database Guidelines](./database-guidelines.md) | 不适用 — 本包无持久化 |
| [Error Handling](./error-handling.md) | 审计失败必须仅 warn,绝不抛错;拦截失败必须 `return { block, reason }` 而非 throw |
| [Logging Guidelines](./logging-guidelines.md) | 前缀 `[audit]` / `[compliance]`,不打印 record 全量 |
| [Quality Guidelines](./quality-guidelines.md) | 与 `frontend/quality-guidelines.md` 共用一套 |

---

## 关键设计点

1. **审计是辅助通道,不是阻塞点**:`sendAudit` 失败绝不影响 pi 主流程
2. **凭证从环境变量读,缺失允许**:`SIEM_INGEST_URL` 没配 = 跳过上报
3. **timeout 必须设置**:`AbortSignal.timeout(2000)`,SIEM 抖动不影响业务
4. **`USER` / `HOSTNAME` 注入**:在 `sendAudit` 里自动加上调用方身份(便于 SIEM 追溯)
