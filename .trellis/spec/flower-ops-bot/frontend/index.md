# Frontend Development Guidelines

> `@flower-ai/flower-ops-bot` 的对外接口层(HTTP server、钉钉 webhook、流式推送)开发规范。

---

## Overview

本项目无浏览器前端。本目录(`frontend/`)指 **"对外接口与入口层"**:HTTP server、钉钉 webhook 路由、流式推送 API。

| 通用前端概念 | 本包对应 |
|------|------|
| 页面 / 路由 | `src/server.ts` 内的 `route(req, res)` 表 |
| 组件 | webhook 处理(`dingtalk/webhook.ts`)、健康检查、push 推送(`dingtalk/push.ts`) |
| Hook | `pi.on` 暂不直接用(由 `flower-compliance` 接管);`agent.subscribe` 用于流式输出订阅 |
| State Management | `conversationId` 维度的会话状态(`session-store.ts`,Redis) |
| Accessibility | 钉钉用户体验:5 秒应答、流式输出节流、错误降级提示 |

### 包定位

- 形态:**HTTP 长驻服务**(Node 内置 `http`,不用框架)
- 入口:`packages/flower-ops-bot/src/server.ts` → `dist/server.js`(可执行 `flower-ops-bot`)
- 端口:`PORT` 环境变量,默认 3000
- 路由:
  - `POST /dingtalk/webhook` — 钉钉消息回调
  - `GET  /healthz` — 健康检查
- 依赖:`@earendil-works/pi-agent-core` 的 `Agent` + `pi-ai` 的 `streamSimple` + `ioredis`

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | `src/` 文件职责与 `dingtalk/` 子目录 |
| [Component Guidelines](./component-guidelines.md) | route 表 / handleDingTalkWebhook / push 的签名约定 |
| [Hook Guidelines](./hook-guidelines.md) | `agent.subscribe` 事件订阅,流式输出累积器 |
| [State Management](./state-management.md) | conversationId / Redis / 进程内 push 节流 |
| [Quality Guidelines](./quality-guidelines.md) | 5 秒返回 / 签名校验 / 推送节流 / 数据脱敏 |
| [Type Safety](./type-safety.md) | `DingTalkRequest` / `StoredSession` / `HandleMessageInput` |

---

## 关键设计点

1. **钉钉 5 秒超时是硬约束**:`/dingtalk/webhook` 必须先 `res.end()` 应答再走后台 `queueMicrotask` 跑 agent
2. **流式输出全量推送**:钉钉 sessionWebhook 多次 POST 都是"当前累积全文",不是 delta
3. **推送节流 500ms**:`push.ts` 用 module-level `Map<sessionWebhook, lastPushAt>` 限流,**final 必须强制推**
4. **签名校验必做**:`DINGTALK_BOT_SECRET` 配了就必须校验 timestamp + sign,绝不允许"开发模式跳过"
5. **优雅关闭**:进程退出前 `closeSessionStore()`,断 Redis 连接

---

**语言**:中文文档,代码示例 / 路径 / 工具名保持英文。
