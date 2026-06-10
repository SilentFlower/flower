---
"@flower-ai/flower-telemetry": minor
"@flower-ai/flower-compliance": minor
"@flower-ai/flower-code-reviewer": minor
---

新增 `@flower-ai/flower-telemetry` 观测事件管道:pi 事件归一化(trace/span/outcome 三层模型 + secret 脱敏)+ 可插拔 sink(jsonlSink JSONL 数据基座 / consoleSink pretty+json 打印 / siemSink metadata-only 审计)。

`flower-compliance` 瘦身为纯策略包(breaking):移除 `sendAudit` 与审计上报(收编为 telemetry `siemSink`,payload 与 `SIEM_INGEST_URL`/`DEBUG_AUDIT` 语义兼容),新增 `onBlock` 拦截回调;production-readonly 模式不再注册任何 handler。

`flower-code-reviewer` 接线 telemetry:注册顺序改为 provider → telemetry → compliance(修复"被拦截 tool_call 漏审计"缺陷,拦截事件以 `tool_blocked` 上报 SIEM 并落 trace);原 `observability.ts` CI 日志迁入 consoleSink(`FLOWER_VERBOSE` 语义不变);run 收尾把 review-trace 真值写为 line_comment/self_check/run_summary outcome 进 JSONL trace(`FLOWER_TELEMETRY_FILE`,默认 `flower-review-trace.jsonl`)。
