/**
 * `pi-adapter.ts` 单元测试:pi 事件 → 归一化事件序列
 *
 * 策略:最小 mock pi(只实现 `on`),收集 handlers 后按真实时序手动触发,
 * 用 collector sink 断言归一化结果。计时用 vi.useFakeTimers 推进,保证确定性。
 *
 * 关键约束:
 * - trace_start 恰好一条(session_start 缺席时由首个事件兜底)
 * - tool_call span 在 compliance 拦截前就已发出(注册顺序契约的数据面保证)
 * - 空 text_delta 不记首字(spec §6);toolcall 不算首字
 * - recordSecurityEvent → outcome(security_block);finishTelemetryTrace → trace_end 带 totals
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	finishTelemetryTrace,
	flushTelemetry,
	getTelemetryPipeline,
	recordSecurityEvent,
	registerTelemetry,
	resetTelemetry,
} from "../pi-adapter.js";
import type { SpanEvent, TelemetryEvent, TelemetrySink } from "../types.js";

type AnyHandler = (event: unknown) => Promise<unknown> | unknown;

function mockPi() {
	const handlers: Record<string, AnyHandler[]> = {};
	const pi = {
		on(event: string, fn: AnyHandler): void {
			const list = handlers[event] ?? [];
			list.push(fn);
			handlers[event] = list;
		},
	};
	return { pi, handlers };
}

function collectorSink(): TelemetrySink & { events: TelemetryEvent[] } {
	const events: TelemetryEvent[] = [];
	return {
		name: "collector",
		events,
		onEvent(event) {
			events.push(event);
		},
	};
}

async function fire(handlers: Record<string, AnyHandler[]>, event: string, payload: unknown): Promise<void> {
	for (const fn of handlers[event] ?? []) {
		await fn(payload);
	}
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.useFakeTimers();
	vi.setSystemTime(1700000000000);
	resetTelemetry();
});

afterEach(() => {
	vi.useRealTimers();
	resetTelemetry();
});

function setup() {
	const { pi, handlers } = mockPi();
	const sink = collectorSink();
	// biome-ignore lint/suspicious/noExplicitAny: minimal mock 不实现完整 ExtensionAPI 接口
	registerTelemetry(pi as any, { product: "test", traceId: "t-1", sinks: [sink] });
	return { handlers, sink };
}

describe("registerTelemetry · trace 边界", () => {
	it("session_start → trace_start 一条,reason 透传,correlation 缺省 unknown", async () => {
		const { handlers, sink } = setup();
		await fire(handlers, "session_start", { reason: "startup" });
		await fire(handlers, "session_start", { reason: "reload" });
		const starts = sink.events.filter((e) => e.kind === "trace_start");
		expect(starts).toHaveLength(1);
		expect(starts[0]).toMatchObject({
			reason: "startup",
			correlation: { project: "unknown", mrIid: "unknown", commitSha: "unknown", pipelineId: "unknown" },
		});
	});

	it("session_start 缺席 → 首个 agent_start 兜底发 trace_start(reason=startup)", async () => {
		const { handlers, sink } = setup();
		await fire(handlers, "agent_start", {});
		expect(sink.events[0]).toMatchObject({ kind: "trace_start", reason: "startup" });
	});

	it("CI 环境变量存在 → correlation 取真值", async () => {
		vi.stubEnv("CI_PROJECT_PATH", "group/repo");
		vi.stubEnv("CI_MERGE_REQUEST_IID", "47");
		vi.stubEnv("CI_COMMIT_SHA", "abc123");
		vi.stubEnv("CI_PIPELINE_ID", "9001");
		const { handlers, sink } = setup();
		await fire(handlers, "session_start", { reason: "startup" });
		expect((sink.events[0] as Extract<TelemetryEvent, { kind: "trace_start" }>).correlation).toEqual({
			project: "group/repo",
			mrIid: "47",
			commitSha: "abc123",
			pipelineId: "9001",
		});
	});

	it("finishTelemetryTrace → trace_end 带累计 totals", async () => {
		const { handlers, sink } = setup();
		await fire(handlers, "turn_start", { turnIndex: 0, timestamp: Date.now() });
		await fire(handlers, "tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "git status" } });
		vi.advanceTimersByTime(500);
		finishTelemetryTrace();
		const end = sink.events.find((e) => e.kind === "trace_end") as Extract<TelemetryEvent, { kind: "trace_end" }>;
		expect(end.totals).toEqual({ turns: 1, toolCalls: 1, durationMs: 500 });
	});
});

describe("registerTelemetry · tool_call span", () => {
	it("tool_call → span 含 tool / toolCallId / inputKeys / 序列化 input,handler 返回 undefined(纯观察)", async () => {
		const { handlers, sink } = setup();
		await fire(handlers, "turn_start", { turnIndex: 2, timestamp: Date.now() });
		const result = await (handlers.tool_call?.[0] as AnyHandler)({
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "env" },
		});
		expect(result).toBeUndefined();
		const span = sink.events.find((e) => e.kind === "span" && e.spanType === "tool_call") as SpanEvent;
		expect(span).toMatchObject({
			tool: "bash",
			toolCallId: "call-1",
			inputKeys: ["command"],
			turnIndex: 2,
			attempt: 1,
		});
		expect(span.input).toContain("env");
	});

	it("tool_execution_start/end → tool_result span 带耗时与 isError", async () => {
		const { handlers, sink } = setup();
		await fire(handlers, "turn_start", { turnIndex: 0, timestamp: Date.now() });
		await fire(handlers, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
		vi.advanceTimersByTime(120);
		await fire(handlers, "tool_execution_end", { toolCallId: "c1", toolName: "bash", result: "ok", isError: false });
		const span = sink.events.find((e) => e.kind === "span" && e.spanType === "tool_result") as SpanEvent;
		expect(span).toMatchObject({ tool: "bash", toolCallId: "c1", isError: false, durationMs: 120, result: "ok" });
	});
});

describe("registerTelemetry · turn 计时分解", () => {
	it("完整一轮:provider 请求/响应 + 首字 + 工具 → span(turn).timing 各字段正确", async () => {
		const { handlers, sink } = setup();
		const t0 = Date.now();
		await fire(handlers, "turn_start", { turnIndex: 0, timestamp: t0 });

		vi.advanceTimersByTime(4);
		await fire(handlers, "before_provider_request", {});
		vi.advanceTimersByTime(3643);
		await fire(handlers, "after_provider_response", { status: 200, headers: {} });

		vi.advanceTimersByTime(3);
		await fire(handlers, "message_update", { message: {}, assistantMessageEvent: { type: "text_start" } });
		vi.advanceTimersByTime(73);
		await fire(handlers, "message_update", { message: {}, assistantMessageEvent: { type: "text_delta", delta: "你" } });

		vi.advanceTimersByTime(1106);
		await fire(handlers, "turn_end", { turnIndex: 0, message: {}, toolResults: [] });

		const turn = sink.events.find((e) => e.kind === "span" && e.spanType === "turn") as SpanEvent;
		expect(turn.timing).toMatchObject({
			durationMs: 4829,
			providerRequestCount: 1,
			providerResponseCount: 1,
			toolCount: 0,
			toolTotalMs: 0,
			toolResultCount: 0,
			providerLastStatus: 200,
			firstProviderRequestMs: 4,
			providerResponseHeadersMs: 3643,
			firstAgentMessageEventMs: 3650,
			firstAgentMessageAfterProviderMs: 3,
			firstTextDeltaMs: 3723,
			firstTextDeltaAfterProviderMs: 76,
		});
		expect(turn.timing?.providerPendingMs).toBeUndefined();
	});

	it("空 text_delta 不记首字;toolcall_ready 只记工具就绪不算首字", async () => {
		const { handlers, sink } = setup();
		await fire(handlers, "turn_start", { turnIndex: 0, timestamp: Date.now() });
		vi.advanceTimersByTime(10);
		await fire(handlers, "message_update", { message: {}, assistantMessageEvent: { type: "text_delta", delta: "" } });
		vi.advanceTimersByTime(5);
		await fire(handlers, "message_update", {
			message: {},
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } },
		});
		await fire(handlers, "turn_end", { turnIndex: 0, message: {}, toolResults: [] });
		const turn = sink.events.find((e) => e.kind === "span" && e.spanType === "turn") as SpanEvent;
		expect(turn.timing?.firstTextDeltaMs).toBeUndefined();
		expect(turn.timing?.firstToolCallReadyMs).toBe(15);
	});

	it("请求已发但无响应 → providerPendingMs 有值,响应头字段 undefined", async () => {
		const { handlers, sink } = setup();
		await fire(handlers, "turn_start", { turnIndex: 0, timestamp: Date.now() });
		vi.advanceTimersByTime(2);
		await fire(handlers, "before_provider_request", {});
		vi.advanceTimersByTime(998);
		await fire(handlers, "turn_end", { turnIndex: 0, message: {}, toolResults: [] });
		const turn = sink.events.find((e) => e.kind === "span" && e.spanType === "turn") as SpanEvent;
		expect(turn.timing?.providerPendingMs).toBe(998);
		expect(turn.timing?.providerResponseHeadersMs).toBeUndefined();
	});
});

describe("registerTelemetry · agent 收尾与流式事件", () => {
	it("agent_end → span(agent) 带 stopReason / usage", async () => {
		const { handlers, sink } = setup();
		await fire(handlers, "agent_start", {});
		vi.advanceTimersByTime(60000);
		await fire(handlers, "agent_end", {
			messages: [
				{ role: "user" },
				{ role: "assistant", stopReason: "end_turn", usage: { input: 10, output: 5, total: 15 } },
			],
		});
		const span = sink.events.find((e) => e.kind === "span" && e.spanType === "agent") as SpanEvent;
		expect(span).toMatchObject({
			attempt: 1,
			durationMs: 60000,
			agent: { attempt: 1, stopReason: "end_turn", usage: { input: 10, output: 5, total: 15 } },
		});
	});

	it("thinking / text 增量与 toolcall_ready 进 stream 事件流", async () => {
		const { handlers, sink } = setup();
		await fire(handlers, "turn_start", { turnIndex: 0, timestamp: Date.now() });
		await fire(handlers, "message_update", {
			message: {},
			assistantMessageEvent: { type: "thinking_delta", delta: "嗯" },
		});
		await fire(handlers, "message_update", {
			message: {},
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } },
		});
		const streams = sink.events.filter((e) => e.kind === "stream");
		expect(streams.map((s) => (s as Extract<TelemetryEvent, { kind: "stream" }>).streamType)).toEqual([
			"turn_start",
			"thinking_delta",
			"toolcall_ready",
		]);
		const ready = streams[2] as Extract<TelemetryEvent, { kind: "stream" }>;
		expect(ready.delta).toContain("command");
		expect(ready.attrs?.tool).toBe("bash");
	});
});

describe("module 单例辅助函数", () => {
	it("recordSecurityEvent → outcome(security_block)", async () => {
		const { sink } = setup();
		recordSecurityEvent({ tool: "bash", mode: "ci-readonly", reason: '命令 "env" 不在白名单内', toolCallId: "c9" });
		const outcome = sink.events.find((e) => e.kind === "outcome") as Extract<TelemetryEvent, { kind: "outcome" }>;
		expect(outcome.outcomeType).toBe("security_block");
		expect(outcome.securityBlock).toMatchObject({ tool: "bash", mode: "ci-readonly", toolCallId: "c9" });
	});

	it("getTelemetryPipeline 注册后可取;resetTelemetry 后为 undefined,record/finish 不抛", () => {
		setup();
		expect(getTelemetryPipeline()).toBeDefined();
		resetTelemetry();
		expect(getTelemetryPipeline()).toBeUndefined();
		expect(() => recordSecurityEvent({ tool: "x", mode: "m", reason: "r" })).not.toThrow();
		expect(() => finishTelemetryTrace()).not.toThrow();
	});

	it("flushTelemetry 透传到 sink.flush", async () => {
		const { pi } = mockPi();
		let flushed = 0;
		const sink: TelemetrySink = {
			name: "f",
			onEvent() {},
			async flush() {
				flushed += 1;
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerTelemetry(pi as any, { product: "test", traceId: "t", sinks: [sink] });
		await flushTelemetry();
		expect(flushed).toBe(1);
	});
});
