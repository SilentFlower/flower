/**
 * @flower-ai/flower-telemetry 公共出口
 *
 * 观测事件管道:pi 事件归一化 + 可插拔 sink(JSONL / console / SIEM / HTTP 推送)。
 * 与 @flower-ai/flower-compliance(纯策略包)平级、互不依赖;
 * 两者的耦合点(onBlock → recordSecurityEvent)由产品层 extension.ts 接线。
 */

export {
	finishTelemetryTrace,
	flushTelemetry,
	getTelemetryPipeline,
	type RegisterTelemetryOptions,
	recordSecurityEvent,
	registerTelemetry,
	resetTelemetry,
} from "./pi-adapter.js";
export { TelemetryPipeline, type TelemetryPipelineOptions } from "./pipeline.js";
export { redactText, serializeValue, truncateText } from "./redact.js";
export { type ConsoleSinkOptions, consoleSink } from "./sinks/console.js";
export { type HttpSinkOptions, httpSink } from "./sinks/http.js";
export { jsonlSink } from "./sinks/jsonl.js";
export { type AuditRecord, type SiemSinkOptions, sendAudit, siemSink } from "./sinks/siem.js";
export type {
	AgentSummary,
	OutcomeEvent,
	OutcomeType,
	SpanEvent,
	SpanType,
	StreamEvent,
	StreamType,
	TelemetryEvent,
	TelemetryEventBase,
	TelemetryEventInput,
	TelemetrySink,
	TraceCorrelation,
	TraceEndEvent,
	TraceStartEvent,
	TurnTiming,
} from "./types.js";
