/**
 * pi-extension adapter:订阅 pi 事件 → 归一化 TelemetryEvent
 *
 * 分层约定(design.md ADR-6):本文件是 telemetry 与 pi ExtensionAPI 的**唯一**耦合点;
 * 事件模型(types.ts)与管道(pipeline.ts)不感知 pi — 将来 ops-bot 用 pi-agent-core
 * 时另写 adapter 复用全部 sink。
 *
 * turn 计时聚合逻辑自 code-reviewer observability.ts 迁入,字段语义保持不变
 * (spec flower-code-reviewer/frontend/index.md §6):
 * - `firstTextDeltaMs` 只在首个**非空** text_delta 时记录,thinking / toolcall 不算首字
 * - 没有文本输出 / 没有响应头时对应字段保持 undefined(显示层输出 n/a)
 *
 * 注册顺序契约:本 adapter 的 `tool_call` 监听必须先于 compliance 注册,
 * 这样被拦截的调用意图也会进 trace(拦截结论经产品层 onBlock → recordSecurityEvent 补记)。
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TelemetryPipeline } from "./pipeline.js";
import { serializeValue } from "./redact.js";
import type { TelemetrySink, TraceCorrelation, TurnTiming } from "./types.js";

/**
 * registerTelemetry 的选项
 */
export interface RegisterTelemetryOptions {
	/** 产品名("code-reviewer" / "ops-bot") */
	product: string;
	/** trace id;缺省时优先 `CI_PIPELINE_ID-CI_MERGE_REQUEST_IID`,否则随机 UUID */
	traceId?: string;
	/** 事件消费方列表 */
	sinks: TelemetrySink[];
}

/** turn 计时聚合的内部状态(字段与原 observability.ts TurnTiming 对齐) */
interface TurnState {
	startMs: number;
	turnIndex: number;
	attempt: number;
	firstAgentMessageEventMs?: number;
	firstTextDeltaMs?: number;
	firstToolCallReadyMs?: number;
	firstProviderRequestMs?: number;
	providerLastRequestStartMs?: number;
	providerLastResponseMs?: number;
	providerLastStatus?: number;
	providerRequestCount: number;
	providerResponseCount: number;
	toolCount: number;
	toolTotalMs: number;
}

/** 工具执行计时(tool_execution_start → end 配对) */
interface ToolState {
	startMs: number;
	turnKey?: string;
}

/** provider 请求计时(before_provider_request → after_provider_response 配对) */
interface ProviderState {
	sequence: number;
	startMs: number;
	turnKey?: string;
}

/** adapter 运行期状态(module 单例,与 review-trace 的单例模式一致) */
interface TelemetryState {
	pipeline: TelemetryPipeline;
	traceStarted: boolean;
	traceStartMs: number;
	turns: number;
	toolCalls: number;
}

let current: TelemetryState | undefined;

/**
 * 从 CI 环境变量读取关联键(缺省容忍,本地运行为 "unknown")
 */
function readCorrelation(): TraceCorrelation {
	return {
		project: process.env.CI_PROJECT_PATH ?? "unknown",
		mrIid: process.env.CI_MERGE_REQUEST_IID ?? "unknown",
		commitSha: process.env.CI_COMMIT_SHA ?? "unknown",
		pipelineId: process.env.CI_PIPELINE_ID ?? "unknown",
	};
}

/**
 * 生成缺省 traceId:CI 内用 `pipeline-mrIid`(稳定可反查),本地随机 UUID
 */
function defaultTraceId(): string {
	const pipelineId = process.env.CI_PIPELINE_ID;
	const mrIid = process.env.CI_MERGE_REQUEST_IID;
	if (pipelineId !== undefined && pipelineId !== "") {
		return mrIid !== undefined && mrIid !== "" ? `${pipelineId}-${mrIid}` : pipelineId;
	}
	return randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 取最后一条 assistant 消息(agent_end 的 stopReason / usage 来源) */
function findLastAssistantMessage(messages: unknown[]): Record<string, unknown> | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isRecord(message) && message.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

/** 解析 usage(取不到的分量保持 undefined) */
function parseUsage(usage: unknown): { input?: number; output?: number; total?: number } | undefined {
	if (!isRecord(usage)) return undefined;
	const input = typeof usage.input === "number" ? usage.input : undefined;
	const output = typeof usage.output === "number" ? usage.output : undefined;
	const total = typeof usage.total === "number" ? usage.total : undefined;
	if (input === undefined && output === undefined && total === undefined) return undefined;
	return { input, output, total };
}

/**
 * 注册 telemetry pi 扩展(同步注册,符合 hook-guidelines 工厂契约)
 *
 * @param pi pi 扩展 API
 * @param options 选项(product / traceId / sinks)
 * @returns 创建的 pipeline(产品装配层一般不需要持有,run 主流程经 getTelemetryPipeline 获取)
 */
export function registerTelemetry(pi: ExtensionAPI, options: RegisterTelemetryOptions): TelemetryPipeline {
	const pipeline = new TelemetryPipeline({
		traceId: options.traceId ?? defaultTraceId(),
		product: options.product,
		sinks: options.sinks,
	});
	const state: TelemetryState = {
		pipeline,
		traceStarted: false,
		traceStartMs: Date.now(),
		turns: 0,
		toolCalls: 0,
	};
	current = state;

	// ---- 计时聚合状态(迁自 observability.ts) ----
	let agentAttempt = 0;
	let agentStartMs: number | undefined;
	let activeTurnKey: string | undefined;
	let providerSequence = 0;
	let activeProvider: ProviderState | undefined;
	const turnStates = new Map<string, TurnState>();
	const toolStates = new Map<string, ToolState>();

	/** 首个事件到达前补发 trace_start(session_start 可能不触发,如 print 模式) */
	const ensureTraceStart = (reason?: string): void => {
		if (state.traceStarted) return;
		state.traceStarted = true;
		state.traceStartMs = Date.now();
		pipeline.emit({ kind: "trace_start", correlation: readCorrelation(), reason: reason ?? "startup" });
	};

	const ensureAgentAttempt = (): number => {
		if (agentAttempt === 0) {
			agentAttempt = 1;
			agentStartMs = Date.now();
		}
		return agentAttempt;
	};

	const activeTurn = (): TurnState | undefined =>
		activeTurnKey !== undefined ? turnStates.get(activeTurnKey) : undefined;

	const markFirstAgentMessageEvent = (): void => {
		const turn = activeTurn();
		if (turn !== undefined && turn.firstAgentMessageEventMs === undefined) {
			turn.firstAgentMessageEventMs = Date.now();
		}
	};

	const markFirstTextDelta = (delta: string): void => {
		// 空字符串 delta 不算首字(spec §6 硬约束)
		if (delta.length === 0) return;
		const turn = activeTurn();
		if (turn !== undefined && turn.firstTextDeltaMs === undefined) {
			turn.firstTextDeltaMs = Date.now();
		}
	};

	pi.on("session_start", async (event) => {
		ensureTraceStart(event.reason);
	});

	pi.on("agent_start", async () => {
		ensureTraceStart();
		agentAttempt += 1;
		agentStartMs = Date.now();
		activeTurnKey = undefined;
		activeProvider = undefined;
		turnStates.clear();
		toolStates.clear();
		pipeline.emit({ kind: "stream", streamType: "agent_start", attrs: { attempt: agentAttempt } });
	});

	pi.on("turn_start", async (event) => {
		ensureTraceStart();
		const attempt = ensureAgentAttempt();
		const turnKey = `${attempt}:${event.turnIndex}`;
		activeTurnKey = turnKey;
		state.turns += 1;
		turnStates.set(turnKey, {
			startMs: event.timestamp,
			turnIndex: event.turnIndex,
			attempt,
			providerRequestCount: 0,
			providerResponseCount: 0,
			toolCount: 0,
			toolTotalMs: 0,
		});
		pipeline.emit({ kind: "stream", streamType: "turn_start", attrs: { turnIndex: event.turnIndex, attempt } });
	});

	pi.on("before_provider_request", async () => {
		const attempt = ensureAgentAttempt();
		providerSequence += 1;
		activeProvider = {
			sequence: providerSequence,
			startMs: Date.now(),
			...(activeTurnKey !== undefined ? { turnKey: activeTurnKey } : {}),
		};
		const turn = activeTurn();
		if (turn !== undefined) {
			turn.providerRequestCount += 1;
			turn.providerLastRequestStartMs = activeProvider.startMs;
			if (turn.firstProviderRequestMs === undefined) {
				turn.firstProviderRequestMs = activeProvider.startMs;
			}
		}
		pipeline.emit({
			kind: "stream",
			streamType: "provider_request",
			attrs: {
				attempt,
				...(turn !== undefined ? { turnIndex: turn.turnIndex } : {}),
				request: providerSequence,
			},
		});
	});

	pi.on("after_provider_response", async (event) => {
		const attempt = ensureAgentAttempt();
		const provider = activeProvider;
		const responseMs = Date.now();
		const responseHeadersMs = provider !== undefined ? responseMs - provider.startMs : undefined;
		const turn = provider?.turnKey !== undefined ? turnStates.get(provider.turnKey) : undefined;
		if (turn !== undefined) {
			turn.providerResponseCount += 1;
			turn.providerLastResponseMs = responseMs;
			turn.providerLastStatus = event.status;
		}
		pipeline.emit({
			kind: "span",
			spanType: "llm_call",
			attempt,
			...(turn !== undefined ? { turnIndex: turn.turnIndex } : {}),
			...(provider !== undefined ? { request: provider.sequence } : {}),
			status: event.status,
			...(responseHeadersMs !== undefined ? { durationMs: responseHeadersMs } : {}),
		});
		activeProvider = undefined;
	});

	pi.on("message_update", async (event) => {
		markFirstAgentMessageEvent();
		const ev = event.assistantMessageEvent;
		switch (ev.type) {
			case "thinking_start":
				pipeline.emit({ kind: "stream", streamType: "thinking_start" });
				break;
			case "thinking_delta":
				pipeline.emit({ kind: "stream", streamType: "thinking_delta", delta: ev.delta });
				break;
			case "thinking_end":
				pipeline.emit({ kind: "stream", streamType: "thinking_end" });
				break;
			case "text_start":
				pipeline.emit({ kind: "stream", streamType: "text_start" });
				break;
			case "text_delta":
				markFirstTextDelta(ev.delta);
				pipeline.emit({ kind: "stream", streamType: "text_delta", delta: ev.delta });
				break;
			case "text_end":
				pipeline.emit({ kind: "stream", streamType: "text_end" });
				break;
			case "toolcall_end": {
				const turn = activeTurn();
				if (turn !== undefined && turn.firstToolCallReadyMs === undefined) {
					turn.firstToolCallReadyMs = Date.now();
				}
				pipeline.emit({
					kind: "stream",
					streamType: "toolcall_ready",
					delta: serializeValue(ev.toolCall.arguments),
					attrs: { tool: ev.toolCall.name },
				});
				break;
			}
			default:
				// 其他子类型(start / toolcall_start / toolcall_delta / done / error)不进事件流
				break;
		}
	});

	pi.on("tool_call", async (event) => {
		ensureTraceStart();
		state.toolCalls += 1;
		const turn = activeTurn();
		pipeline.emit({
			kind: "span",
			spanType: "tool_call",
			tool: event.toolName,
			toolCallId: event.toolCallId,
			inputKeys: Object.keys(event.input ?? {}),
			input: serializeValue(event.input),
			...(turn !== undefined ? { turnIndex: turn.turnIndex, attempt: turn.attempt } : {}),
		});
		// 纯观察,绝不拦截(阻塞由 compliance 负责)
		return undefined;
	});

	pi.on("tool_execution_start", async (event) => {
		toolStates.set(event.toolCallId, {
			startMs: Date.now(),
			...(activeTurnKey !== undefined ? { turnKey: activeTurnKey } : {}),
		});
	});

	pi.on("tool_execution_end", async (event) => {
		const tool = toolStates.get(event.toolCallId);
		const durationMs = tool !== undefined ? Math.max(0, Date.now() - tool.startMs) : undefined;
		const turn = tool?.turnKey !== undefined ? turnStates.get(tool.turnKey) : undefined;
		if (turn !== undefined) {
			turn.toolCount += 1;
			turn.toolTotalMs += durationMs ?? 0;
		}
		toolStates.delete(event.toolCallId);
		pipeline.emit({
			kind: "span",
			spanType: "tool_result",
			tool: event.toolName,
			toolCallId: event.toolCallId,
			result: serializeValue(event.result),
			isError: event.isError,
			...(durationMs !== undefined ? { durationMs } : {}),
			...(turn !== undefined ? { turnIndex: turn.turnIndex, attempt: turn.attempt } : {}),
		});
	});

	pi.on("turn_end", async (event) => {
		const attempt = ensureAgentAttempt();
		const turnKey = `${attempt}:${event.turnIndex}`;
		const turn = turnStates.get(turnKey);
		const endMs = Date.now();
		const timing = buildTurnTiming(turn, endMs, event.toolResults.length);
		pipeline.emit({ kind: "span", spanType: "turn", turnIndex: event.turnIndex, attempt, timing });
		turnStates.delete(turnKey);
		if (activeTurnKey === turnKey) {
			activeTurnKey = undefined;
		}
		if (activeProvider?.turnKey === turnKey) {
			activeProvider = undefined;
		}
	});

	pi.on("agent_end", async (event) => {
		const attempt = ensureAgentAttempt();
		const durationMs = agentStartMs !== undefined ? Math.max(0, Date.now() - agentStartMs) : undefined;
		const lastAssistant = findLastAssistantMessage(event.messages);
		const stopReason = typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : "unknown";
		const errorMessage = typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : undefined;
		const usage = parseUsage(lastAssistant?.usage);
		pipeline.emit({
			kind: "span",
			spanType: "agent",
			attempt,
			...(durationMs !== undefined ? { durationMs } : {}),
			agent: {
				attempt,
				stopReason,
				...(usage !== undefined ? { usage } : {}),
				...(errorMessage !== undefined ? { errorMessage } : {}),
			},
		});
	});

	return pipeline;
}

/**
 * 由 TurnState 计算相对计时分解(全部相对 turn_start;不可测的字段保持 undefined → 显示 n/a)
 */
function buildTurnTiming(turn: TurnState | undefined, endMs: number, toolResultCount: number): TurnTiming {
	if (turn === undefined) {
		return { providerRequestCount: 0, providerResponseCount: 0, toolCount: 0, toolTotalMs: 0, toolResultCount };
	}
	const rel = (abs: number | undefined): number | undefined => (abs !== undefined ? abs - turn.startMs : undefined);
	const providerResponseHeadersMs =
		turn.providerLastRequestStartMs !== undefined && turn.providerLastResponseMs !== undefined
			? turn.providerLastResponseMs - turn.providerLastRequestStartMs
			: undefined;
	const firstAgentMessageAfterProviderMs =
		turn.providerLastResponseMs !== undefined && turn.firstAgentMessageEventMs !== undefined
			? turn.firstAgentMessageEventMs - turn.providerLastResponseMs
			: undefined;
	const firstTextDeltaAfterProviderMs =
		turn.providerLastResponseMs !== undefined && turn.firstTextDeltaMs !== undefined
			? turn.firstTextDeltaMs - turn.providerLastResponseMs
			: undefined;
	const providerPendingMs =
		turn.providerLastRequestStartMs !== undefined && turn.providerLastResponseMs === undefined
			? endMs - turn.providerLastRequestStartMs
			: undefined;
	return {
		durationMs: endMs - turn.startMs,
		providerRequestCount: turn.providerRequestCount,
		providerResponseCount: turn.providerResponseCount,
		toolCount: turn.toolCount,
		toolTotalMs: turn.toolTotalMs,
		toolResultCount,
		...(turn.providerLastStatus !== undefined ? { providerLastStatus: turn.providerLastStatus } : {}),
		...(rel(turn.firstProviderRequestMs) !== undefined
			? { firstProviderRequestMs: rel(turn.firstProviderRequestMs) }
			: {}),
		...(providerResponseHeadersMs !== undefined ? { providerResponseHeadersMs } : {}),
		...(providerPendingMs !== undefined ? { providerPendingMs } : {}),
		...(rel(turn.firstAgentMessageEventMs) !== undefined
			? { firstAgentMessageEventMs: rel(turn.firstAgentMessageEventMs) }
			: {}),
		...(firstAgentMessageAfterProviderMs !== undefined ? { firstAgentMessageAfterProviderMs } : {}),
		...(rel(turn.firstTextDeltaMs) !== undefined ? { firstTextDeltaMs: rel(turn.firstTextDeltaMs) } : {}),
		...(firstTextDeltaAfterProviderMs !== undefined ? { firstTextDeltaAfterProviderMs } : {}),
		...(rel(turn.firstToolCallReadyMs) !== undefined ? { firstToolCallReadyMs: rel(turn.firstToolCallReadyMs) } : {}),
	};
}

/**
 * 获取当前 pipeline(run 主流程发 outcome / flush 用;未注册时 undefined)
 */
export function getTelemetryPipeline(): TelemetryPipeline | undefined {
	return current?.pipeline;
}

/**
 * 记录一次 compliance 拦截事件(产品层把本函数接到 registerCompliance 的 onBlock)
 *
 * 同时是"拦截事件漏审计"缺陷的修复点:siemSink 会把本事件投影为 `tool_blocked` 上报。
 *
 * @param block 拦截信息(tool / mode / reason 必填;toolCallId 用于关联 tool_call span)
 */
export function recordSecurityEvent(block: {
	tool: string;
	mode: string;
	reason: string;
	toolCallId?: string;
	command?: string;
}): void {
	current?.pipeline.emit({ kind: "outcome", outcomeType: "security_block", securityBlock: block });
}

/**
 * 收尾当前 trace:发出 trace_end(含累计 totals)
 *
 * 由 run 主流程在全部 outcome 写完后调用一次;之后仍需 `await flushTelemetry()`。
 */
export function finishTelemetryTrace(): void {
	if (current === undefined) return;
	current.pipeline.emit({
		kind: "trace_end",
		totals: {
			turns: current.turns,
			toolCalls: current.toolCalls,
			durationMs: Math.max(0, Date.now() - current.traceStartMs),
		},
	});
}

/**
 * 冲刷全部 sink(run 结束前 await 一次,保证 JSONL 落盘与在途 SIEM 上报收尾)
 */
export async function flushTelemetry(): Promise<void> {
	await current?.pipeline.flush();
}

/**
 * 重置 module 单例(测试隔离用;生产一个进程只注册一次,无需调用)
 */
export function resetTelemetry(): void {
	current = undefined;
}
