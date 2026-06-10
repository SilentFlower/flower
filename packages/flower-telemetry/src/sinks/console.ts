/**
 * consoleSink:把归一化事件打印到 stdout(原 code-reviewer observability.ts 的展示层迁入)
 *
 * 两种格式:
 * - `pretty`:面向人读的 CI 日志(GitLab CI job log),输出格式与原 observability.ts 逐行对齐
 *   (中文分组 turn 摘要、思考/文本流式直出、工具调用/结果带截断)
 * - `json`:一行一事件的结构化输出(行内自带 traceId / seq),供常驻服务(ops-bot)多会话
 *   并发场景在 SLS 等日志系统中按 trace 检索;`stream` 事件不输出(避免 delta 刷屏)
 *
 * 本 sink 只做格式化,不做计时聚合 — turn 计时分解由 pi-adapter 归一化进 span(turn).timing。
 */

import { truncateText } from "../redact.js";
import type { SpanEvent, StreamEvent, TelemetryEvent, TelemetrySink, TurnTiming } from "../types.js";

/** 工具入参显示截断(与原 observability.ts TRUNC_DEFAULT 一致) */
const ARGS_DISPLAY_MAX = 400;
/** 工具结果显示截断(与原 observability.ts 一致) */
const RESULT_DISPLAY_MAX = 300;

/**
 * 创建 console 打印 sink 的选项
 */
export interface ConsoleSinkOptions {
	/** 输出格式:pretty(人读,默认)/ json(机器检索) */
	format?: "pretty" | "json";
}

/**
 * 毫秒数格式化:undefined → "n/a"(语义:该指标本轮无法测量,见 types.ts TurnTiming 注释)
 */
function formatMs(value: number | undefined): string {
	if (value === undefined) return "n/a";
	return String(Math.max(0, Math.round(value)));
}

/**
 * 毫秒时长格式化:带 ms 单位,undefined → "n/a"
 */
function formatDuration(value: number | undefined): string {
	const ms = formatMs(value);
	if (ms === "n/a") return ms;
	return `${ms}ms`;
}

/**
 * token usage 格式化(取不到任何分量时返回空串,不输出占位)
 */
function formatUsage(usage: { input?: number; output?: number; total?: number } | undefined): string {
	if (usage === undefined) return "";
	const { input, output, total } = usage;
	if (input === undefined && output === undefined && total === undefined) return "";
	return ` · usage_input=${input ?? "n/a"} · usage_output=${output ?? "n/a"} · usage_total=${total ?? "n/a"}`;
}

/**
 * 创建 console 打印 sink
 *
 * @param options 选项(format 缺省 pretty)
 * @returns TelemetrySink 实例(非 critical,受 FLOWER_TELEMETRY 总开关控制)
 */
export function consoleSink(options: ConsoleSinkOptions = {}): TelemetrySink {
	const format = options.format ?? "pretty";
	return {
		name: "console",
		onEvent(event: TelemetryEvent): void {
			if (format === "json") {
				// json 模式:stream 事件(流式 delta)不输出,其余整行 JSON(自带 traceId/seq)
				if (event.kind !== "stream") {
					console.log(JSON.stringify(event));
				}
				return;
			}
			if (event.kind === "stream") {
				printStream(event);
				return;
			}
			if (event.kind === "span") {
				printSpan(event);
			}
			// trace_start / trace_end / outcome 不进 pretty 日志(人读关注过程;业务结论已有探针日志)
		},
	};
}

/**
 * pretty 模式:流式事件(生命周期瞬间 + 增量直出)
 */
function printStream(event: StreamEvent): void {
	const attrs = event.attrs ?? {};
	switch (event.streamType) {
		case "agent_start":
			console.log(`\n>>> 🤖 [agent] session start · attempt=${attrs.attempt ?? "n/a"}`);
			break;
		case "turn_start":
			console.log(`\n>>> 🤖 [turn ${attrs.turnIndex ?? "n/a"}] start · agent_attempt=${attrs.attempt ?? "n/a"}`);
			break;
		case "provider_request":
			console.log(
				`>>> 🌐 [provider] request start · agent_attempt=${attrs.attempt ?? "n/a"} · turn=${attrs.turnIndex ?? "n/a"} · request=${attrs.request ?? "n/a"}`,
			);
			break;
		case "thinking_start":
			process.stdout.write("\n💭 thinking: ");
			break;
		case "thinking_delta":
			process.stdout.write(event.delta ?? "");
			break;
		case "thinking_end":
			process.stdout.write("\n");
			break;
		case "text_start":
			process.stdout.write("\n💬 assistant: ");
			break;
		case "text_delta":
			process.stdout.write(event.delta ?? "");
			break;
		case "text_end":
			process.stdout.write("\n");
			break;
		case "toolcall_ready":
			console.log(`\n🔧 [tool →] ${attrs.tool ?? "n/a"}  args=${truncateText(event.delta ?? "", ARGS_DISPLAY_MAX)}`);
			break;
		default:
			break;
	}
}

/**
 * pretty 模式:完成型 span(provider 响应 / 工具结果 / turn 摘要 / agent 收尾)
 */
function printSpan(event: SpanEvent): void {
	switch (event.spanType) {
		case "llm_call":
			console.log(
				`>>> 🌐 [provider] response headers · agent_attempt=${event.attempt ?? "n/a"} · turn=${event.turnIndex ?? "n/a"} · request=${event.request ?? "n/a"} · status=${event.status ?? "n/a"} · response_headers_ms=${formatMs(event.durationMs)}`,
			);
			break;
		case "tool_result": {
			const tag = event.isError === true ? "🔧 [tool ✗ error]" : "🔧 [tool ←]";
			console.log(
				`${tag} ${event.tool ?? "n/a"} · duration_ms=${formatMs(event.durationMs)}  result=${truncateText(event.result ?? "", RESULT_DISPLAY_MAX)}`,
			);
			break;
		}
		case "turn":
			printTurnSummary(event);
			break;
		case "agent": {
			const summary = event.agent;
			const errorPart =
				summary?.errorMessage !== undefined ? ` · error=${truncateText(summary.errorMessage, RESULT_DISPLAY_MAX)}` : "";
			console.log(
				`\n>>> 🤖 [agent] session end · attempt=${summary?.attempt ?? "n/a"} · duration_ms=${formatMs(event.durationMs)} · stop_reason=${summary?.stopReason ?? "unknown"}${formatUsage(summary?.usage)}${errorPart}\n`,
			);
			break;
		}
		default:
			// tool_call(意图)不打印:pretty 日志在 toolcall_ready 流式事件处已展示
			break;
	}
}

/**
 * pretty 模式:turn 结束多行中文分组摘要(格式与原 observability.ts 完全一致,
 * 字段语义见 spec flower-code-reviewer/frontend/index.md §6)
 */
function printTurnSummary(event: SpanEvent): void {
	const timing: TurnTiming = event.timing ?? {
		providerRequestCount: 0,
		providerResponseCount: 0,
		toolCount: 0,
		toolTotalMs: 0,
		toolResultCount: 0,
	};
	console.log(
		[
			`>>> 🤖 第 ${event.turnIndex ?? "n/a"} 轮结束 · 第 ${event.attempt ?? "n/a"} 次尝试`,
			`    总览: 本轮 ${formatDuration(timing.durationMs)} · 模型请求 ${timing.providerRequestCount} 次 · 模型响应 ${timing.providerResponseCount} 次 · 工具 ${timing.toolCount} 次 · 工具结果 ${timing.toolResultCount} 个`,
			`    模型接口: 请求开始 ${formatDuration(timing.firstProviderRequestMs)} · 响应头 ${formatDuration(timing.providerResponseHeadersMs)} · 未返回等待 ${formatDuration(timing.providerPendingMs)} · 状态 ${timing.providerLastStatus ?? "n/a"}`,
			`    流式输出: 首个事件 ${formatDuration(timing.firstAgentMessageEventMs)} · 响应头到首个事件 ${formatDuration(timing.firstAgentMessageAfterProviderMs)}`,
			`    文本输出: 本轮首字 ${formatDuration(timing.firstTextDeltaMs)} · 响应头到本轮首字 ${formatDuration(timing.firstTextDeltaAfterProviderMs)}`,
			`    工具调用: 首个工具就绪 ${formatDuration(timing.firstToolCallReadyMs)} · 工具总耗时 ${formatDuration(timing.toolTotalMs)}`,
			"",
		].join("\n"),
	);
}
