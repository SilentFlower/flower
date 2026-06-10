# Backend Development Guidelines

> `@flower-ai/flower-compliance` 的内部实现层(拦截规则)开发规范。

---

## Overview

`flower-compliance` 是 pi 扩展库(**纯策略包**,2026-06-10 瘦身),实现集中在单一模块:

- `src/index.ts`:注册 `ci-readonly` 合规拦截;CI 模式禁写工具,并按 bash 白名单控制命令;
  拦截事件经 `onBlock` 回调交产品层(接 flower-telemetry 的 `recordSecurityEvent`)

> 历史说明:原 `src/audit.ts`(`sendAudit` → SIEM)已迁入 `@flower-ai/flower-telemetry`
> 的 `siemSink`(payload 兼容、`SIEM_INGEST_URL`/`DEBUG_AUDIT` 语义不变);本包不再发任何 HTTP。
> 下文 error-handling / logging 指南中关于"审计上报"的模式描述对 telemetry 的 siemSink 实现仍然适用。

本目录(`backend/`)关心工具调用拦截:错误处理、回调边界、副作用边界。

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 与 `frontend/` 一致(本包只有 1 个实现文件) |
| [Database Guidelines](./database-guidelines.md) | 不适用 — 本包无持久化 |
| [Error Handling](./error-handling.md) | 拦截失败必须 `return { block, reason }` 而非 throw;onBlock 回调抛错不影响拦截 |
| [Logging Guidelines](./logging-guidelines.md) | 拦截不打日志,reason 通过返回值给 LLM |
| [Quality Guidelines](./quality-guidelines.md) | 与 `frontend/quality-guidelines.md` 共用一套 |

---

## 关键设计点

1. **纯策略,无副作用通道**:本包只做"判定 + 拦截",不发 HTTP、不写文件;观测责任在 telemetry
2. **onBlock 是辅助通道,不是阻塞点**:回调抛错被 try-catch 吞掉,拦截结论照常返回
3. **互不依赖**:不 import telemetry;`BlockEvent`(toolName/mode/reason/toolCallId/command)→
   telemetry `recordSecurityEvent`(tool/...)的字段映射在产品层 extension.ts 完成
4. **注册顺序契约**:产品层必须 telemetry → compliance(pi 按注册顺序短路,否则被拦截的调用意图进不了 trace)
5. **CI bash 白名单**:默认仅放行只读命令;`python3` 是 reviewer 文档解析例外,用于读取 Excel / Word 模板。`write` / `edit`、网络外发(`curl` / `wget` / `nc`)、包管理(`npm` / `pip` / `apt` / `yum`)和常见写文件命令(`tee` / `mv` / `rm` / `cp` / `mkdir` / `touch`)仍必须拦截并返回 `{ block: true, reason }`。
