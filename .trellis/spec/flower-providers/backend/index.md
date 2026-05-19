# Backend Development Guidelines

> `@flower-ai/flower-providers` 的内部实现层规范。

---

## Overview

`flower-providers` 是 pi 扩展库,**只有 1 个文件**(`src/index.ts`)。
没有真正意义的"后端实现层"(无 IO、无存储、无业务逻辑)。

本目录(`backend/`)用于:

- 记录"如果未来要拆分"时的边界
- 记录 LLM 调用栈的错误处理 / 日志约定(虽然本包不直接发起调用)

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 单文件布局,未来拆分边界 |
| [Database Guidelines](./database-guidelines.md) | 不适用 |
| [Error Handling](./error-handling.md) | fail-fast 启动期检查、provider 注册失败语义 |
| [Logging Guidelines](./logging-guidelines.md) | 不打 apiKey / baseUrl |
| [Quality Guidelines](./quality-guidelines.md) | 与 frontend/ 共用 |

---

## 关键设计点

1. **本包是初始化代码**,只跑一次,无运行时分支
2. **fail-fast 是核心策略**:缺凭证立刻退出
3. **`CUSTOM_MODELS` 是占位**:真实接入网关时要按目标模型清单替换
