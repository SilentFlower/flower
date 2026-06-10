/**
 * telemetry sink 装配
 *
 * 独立成 module 的原因:extension.ts(pi 注册顺序敏感)只关心"装哪些 sink",
 * 而 sink 的开关逻辑(FLOWER_VERBOSE / FLOWER_TELEMETRY_FILE / FLOWER_TELEMETRY_URL)
 * 是环境策略,单独放便于单测。
 *
 * 装配规则:
 * - consoleSink(pretty):默认挂载;`FLOWER_VERBOSE=0/false/off/no` 显式关(语义与原 observability.ts 一致)
 * - jsonlSink:默认挂载,路径 `FLOWER_TELEMETRY_FILE`(缺省 `flower-review-trace.jsonl`,CI artifact 用)
 * - httpSink:配置 `FLOWER_TELEMETRY_URL` 时挂载(实时推送全量事件到观测服务;
 *   token 取 `FLOWER_TELEMETRY_TOKEN`;非 critical,受 FLOWER_TELEMETRY 总开关控制)
 * - siemSink:始终挂载(critical,不受 FLOWER_TELEMETRY 总开关影响;未配 SIEM_INGEST_URL 时内部 no-op)
 */

import { consoleSink, httpSink, jsonlSink, siemSink, type TelemetrySink } from "@flower-ai/flower-telemetry";

/** JSONL trace 默认输出路径(相对 CI 工作目录;.gitlab-ci 配 artifacts 收集) */
const DEFAULT_TRACE_FILE = "flower-review-trace.jsonl";

/** FLOWER_VERBOSE 识别为"关"的取值(沿用原 observability.ts 语义:未设 = 开) */
const VERBOSE_OFF = new Set(["0", "false", "off", "no", ""]);

/**
 * 判断 console 打印是否关闭(默认开;只有 FLOWER_VERBOSE 显式设为关闭值才关)
 */
export function isVerboseOff(): boolean {
	const raw = process.env.FLOWER_VERBOSE;
	if (raw === undefined) return false;
	return VERBOSE_OFF.has(raw.toLowerCase());
}

/**
 * 装配 code-reviewer 的 telemetry sink 列表
 *
 * @returns sink 数组(console 受 FLOWER_VERBOSE 控制,jsonl 路径可由 FLOWER_TELEMETRY_FILE 覆盖,
 *          http 仅在 FLOWER_TELEMETRY_URL 配置时挂载)
 */
export function buildTelemetrySinks(): TelemetrySink[] {
	const sinks: TelemetrySink[] = [];
	if (!isVerboseOff()) {
		sinks.push(consoleSink({ format: "pretty" }));
	}
	const traceFile = process.env.FLOWER_TELEMETRY_FILE ?? DEFAULT_TRACE_FILE;
	sinks.push(jsonlSink(traceFile));
	const httpUrl = process.env.FLOWER_TELEMETRY_URL;
	if (httpUrl !== undefined && httpUrl !== "") {
		sinks.push(httpSink({ url: httpUrl, token: process.env.FLOWER_TELEMETRY_TOKEN }));
	}
	sinks.push(siemSink());
	return sinks;
}
