# Backend Development Guidelines

> `@flower-ai/flower-telemetry` 观测事件管道(pi 事件归一化 + 可插拔 sink)开发规范。

---

## Overview

`flower-telemetry` 是观测基础库:pi 事件归一化为 `TelemetryEvent` 后 fanout 到可插拔 sink。
与 `flower-compliance`(纯策略包)平级、**互不依赖**,两者耦合点(onBlock → `recordSecurityEvent`)由产品层 extension.ts 接线。

| 模块 | 职责 |
|------|------|
| `types.ts` | 事件模型(信封 + kind 判别联合)与 `TelemetrySink` 接口(`critical` 标记) |
| `pipeline.ts` | **全仓唯一 enforcement 点**:信封注入(traceId/product/seq/ts)、脱敏截断、fanout、`FLOWER_TELEMETRY` 总开关 |
| `pi-adapter.ts` | telemetry 与 pi ExtensionAPI 的**唯一**耦合点(订阅事件 → 归一化;换框架另写 adapter 复用全部 sink) |
| `redact.ts` | 脱敏 + 截断(defense-in-depth 最后一道防线,兜住代码里硬编码的凭证) |
| `sinks/jsonl.ts` | JSONL 落盘(CI artifact 持久化,append-only) |
| `sinks/console.ts` | stdout 展示(`pretty` 人读 CI 日志 / `json` 结构化按 trace 检索) |
| `sinks/siem.ts` | SIEM 审计(metadata-only 投影 + fail-open POST;**critical,不可关**) |
| `sinks/http.ts` | 批量 NDJSON 推送 flower-observer(jsonlSink 的"网络孪生",同行格式两种传输) |

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Sink Guidelines](./sink-guidelines.md) | sink 实现约定(fail-open / 绝不抛错 / critical 语义)+ httpSink 客户端线协议要点 |

> 本包无持久化、无 HTTP 服务端,database / error-handling 等通用指南不适用;
> 服务端(ingest / SQLite)规范见 [flower-observer backend spec](../../flower-observer/backend/index.md)。

---

## 关键设计点

1. **观测绝不反向阻塞业务**:`pipeline.emit()` 绝不抛错,单 sink 故障不影响其余 sink 与主流程;
   失败默认**完全静默**,`DEBUG_TELEMETRY=1` 才打单行 warn(姿态对齐 compliance backend spec 的审计上报)
2. **脱敏顺序先 redact 后 truncate**(`redact.ts` / `pipeline.ts safeField`):截断可能把 secret 切半逃过正则,顺序不可换
3. **`stream` 事件"三不出"**:不落盘(jsonl)、不推送(http)、`json` 格式不输出(console)——
   纯显示信号且 thinking/text delta **不脱敏**,出包即泄密风险
4. **critical sink 语义**:`FLOWER_TELEMETRY=0` 总开关只过滤非 critical sink(构造时求值一次);
   `siemSink` 是 critical(审计"不可关"),JSONL / console / http 可关
5. **Docker 构建指定包,避 TS5083**:顶层 `npm run build` 走根 tsconfig(references 全部 package),
   Dockerfile 未 COPY 的包会触发 `TS5083 Cannot read file '.../tsconfig.json'`;
   改用 `tsc --build packages/<pkg>/tsconfig.json`,递归编译该包 + 声明的 transitive deps、跳过无关包
   (实测 `ba58509`,flower-code-reviewer Dockerfile)
