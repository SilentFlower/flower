# Frontend Development Guidelines

> `@flower-ai/flower-providers` 的对外接口层(`registerCompanyProviders` / `getDefaultModelId`)开发规范。

---

## Overview

本项目无浏览器前端。本目录(`frontend/`)指 **"对外暴露的 API 层"**:

`flower-providers` 是 pi 扩展库,**只暴露两个公开函数**:

- `registerCompanyProviders(pi, options)` — 把内部 LLM 网关注册到 pi
- `getDefaultModelId(appSource)` — 给两个产品挑默认模型

### 包定位

- 形态:**pi 扩展库**(被 `code-reviewer` / `ops-bot` 加载)
- 入口:`packages/flower-providers/src/index.ts`(只有一个文件)
- 职责:
  - 把内部 LLM 网关(自部署 / 企业 AI Gateway / 第三方 OpenAI 兼容)接入 pi
  - 提供"按产品挑默认模型"的策略入口

| 通用前端概念 | 本包对应 |
|------|------|
| 公开 API | `registerCompanyProviders` / `getDefaultModelId` |
| 配置参数 | `{ appSource: string }` + 环境变量 `LLM_BASE_URL` / `LLM_API_KEY` |
| Hook | `pi.registerProvider(name, config)`(由 pi 上游提供) |
| State | 无 |

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 只有一个 src/index.ts |
| [Component Guidelines](./component-guidelines.md) | 公开函数签名约定 |
| [Hook Guidelines](./hook-guidelines.md) | `pi.registerProvider` 用法、模型清单结构 |
| [State Management](./state-management.md) | 无状态;`CUSTOM_MODELS` 是 module-level immutable 常量 |
| [Quality Guidelines](./quality-guidelines.md) | 强约束:fail-fast 检查环境变量,不打印 apiKey |
| [Type Safety](./type-safety.md) | Model 类型用 `as any` 的边界(pi 上游类型严格,自定义 model 偏宽松) |

---

## 关键设计点

1. **凭证不写死**:`baseUrl` / `apiKey` 全部从 `process.env` 读,缺关键值 fail-fast
2. **`appSource` 必填**:用于审计与计费(`X-App-Source` header),不要给默认值
3. **`CUSTOM_MODELS` 是占位**:真实接入时要替换为目标 LLM 网关支持的模型清单
4. **模型选择策略集中**:`getDefaultModelId` 是唯一的"哪个产品用哪个模型"决策点
