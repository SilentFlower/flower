---
"@flower-ai/flower-telemetry": minor
"@flower-ai/flower-code-reviewer": patch
---

`flower-telemetry` 新增 `httpSink({url, token?})`:把全量归一化事件以批量 NDJSON 实时推送到常驻观测服务(行格式与 jsonlSink 逐字节一致,服务端按 `(traceId, seq)` 幂等去重);攒批(默认 50 条 / 2s)+ 有界缓冲(默认 2000 条丢最旧)+ fail-open(失败静默留缓冲重试,`DEBUG_TELEMETRY=1` 才 warn),非 critical 受 `FLOWER_TELEMETRY=0` 总开关控制。siemSink 审计记录新增 `traceId` 字段(向后兼容),实时安全事件可精确关联全量 trace。

`flower-code-reviewer` 接线:配置 `FLOWER_TELEMETRY_URL` 时挂载 httpSink(token 取 `FLOWER_TELEMETRY_TOKEN`),未配置时行为与现状一致。
