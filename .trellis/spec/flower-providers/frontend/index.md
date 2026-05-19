# Frontend Development Guidelines

> `@flower-ai/flower-providers` 的对外接口层(`registerHavefunProviders` / `getDefaultModel` / `buildHavefunModel`)开发规范。

---

## Overview

本项目无浏览器前端。本目录(`frontend/`)指 **"对外暴露的 API 层"**:

`flower-providers` 是 pi 扩展库,**只暴露 3 个公开函数 + 1 个类型**:

- `registerHavefunProviders(pi, options)` — 给 pi-coding-agent 形态(code-reviewer)注册 4 个 provider
- `getDefaultModel()` — 读 env 决定 `{ provider, modelId }`,fail-fast
- `buildHavefunModel(provider, modelId)` — 给 pi-agent-core 形态(ops-bot)构造 `Model<Api>`
- `ProviderName` — 4 个 `havefun-*` provider 名的联合类型

### 包定位

- 形态:**pi 扩展库**(被 `code-reviewer` / `ops-bot` 加载)
- 入口:`packages/flower-providers/src/index.ts`(只 re-export)
- 模块拆分:`env.ts` / `catalog.ts` / `register.ts` / `runtime.ts` + `index.ts`(共 5 文件)
- 职责:
  - 把目标 LLM 网关(自部署 / 企业 AI Gateway / 第三方 OpenAI 兼容)接入 pi
  - 提供"取默认模型"的统一入口(`getDefaultModel` 由 env 驱动,**无业务参数**)
  - `appSource` 仅用于审计 header(`X-App-Source`),不再参与模型选择

| 通用前端概念 | 本包对应 |
|------|------|
| 公开 API | `registerHavefunProviders` / `getDefaultModel` / `buildHavefunModel` |
| 公开类型 | `ProviderName`(4 个 `havefun-*` 联合) |
| 配置参数 | `{ appSource: string }` + 环境变量 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_PROVIDER` / `LLM_MODEL` / `LLM_EXTRA_MODELS_JSON` |
| Hook | `pi.registerProvider(name, config)`(由 pi 上游提供) |
| State | 无 |

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 5 文件模块结构 |
| [Component Guidelines](./component-guidelines.md) | 公开函数签名约定 |
| [Hook Guidelines](./hook-guidelines.md) | `pi.registerProvider` 用法、模型清单结构、4 个 provider 联合 |
| [State Management](./state-management.md) | 无状态;`BUILTIN_MODELS` 是 module-level immutable 常量 |
| [Quality Guidelines](./quality-guidelines.md) | 强约束:fail-fast 检查环境变量,不打印 apiKey |
| [Type Safety](./type-safety.md) | Model 类型在 `buildHavefunModel` 的 cast 边界 |

---

## 关键设计点

1. **凭证不写死**:`baseUrl` / `apiKey` 全部从 `process.env` 读,缺关键值 fail-fast
2. **`appSource` 必填**:仅用于审计 header(`X-App-Source`),不要给默认值,**不参与模型选择**
3. **`BUILTIN_MODELS` 是 8 条预设**:每条单一 `nativeApi`(原生协议),只注册到对应的 1 个 provider
4. **模型扩展走 env**:`LLM_EXTRA_MODELS_JSON` 可注入额外模型,同 id 覆盖 builtin
5. **`getDefaultModel` 无参 + fail-fast**:`LLM_PROVIDER` + `LLM_MODEL` 任一缺失或非法立即抛错,不退化
