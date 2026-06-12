/**
 * `sinks/console.ts` 单元测试:pretty 关键行格式 + json 行结构
 *
 * 关键约束(spec flower-code-reviewer/frontend/index.md §6):
 * - pretty turn 摘要为多行中文分组格式,默认摘要不出现英文机器字段名
 * - 无法测量的指标输出 n/a(不得把 thinking / toolcall 误记成首字 — 该语义在 adapter 层保证,
 *   此处只验证 undefined → n/a 的显示规则)
 * - json 模式每行可 parse 且自带 traceId / seq;stream 事件不输出
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { consoleSink } from "../sinks/console.js";
import type { TelemetryEvent } from "../types.js";

const BASE = { traceId: "t-1", product: "test", seq: 1, ts: 1700000000000 };

const TURN_SPAN: TelemetryEvent = {
	...BASE,
	kind: "span",
	spanType: "turn",
	turnIndex: 10,
	attempt: 1,
	timing: {
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
	},
};

describe("consoleSink · pretty 格式", () => {
	let logMock: MockInstance<typeof console.log>;
	let writeMock: MockInstance<typeof process.stdout.write>;

	beforeEach(() => {
		logMock = vi.spyOn(console, "log").mockImplementation(() => {});
		writeMock = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		logMock.mockRestore();
		writeMock.mockRestore();
	});

	it("turn 摘要:多行中文分组,含 总览/模型接口/流式输出/文本输出/工具调用 五组", () => {
		consoleSink().onEvent(TURN_SPAN);
		expect(logMock).toHaveBeenCalledTimes(1);
		const output = String(logMock.mock.calls[0]?.[0]);
		expect(output).toContain(">>> 🤖 第 10 轮结束 · 第 1 次尝试");
		expect(output).toContain("总览: 本轮 4829ms · 模型请求 1 次 · 模型响应 1 次 · 工具 0 次 · 工具结果 0 个");
		expect(output).toContain("模型接口: 请求开始 4ms · 响应头 3643ms · 未返回等待 n/a · 状态 200");
		expect(output).toContain("流式输出: 首个事件 3650ms · 响应头到首个事件 3ms");
		expect(output).toContain("文本输出: 本轮首字 3723ms · 响应头到本轮首字 76ms");
		expect(output).toContain("工具调用: 首个工具就绪 n/a · 工具总耗时 0ms");
	});

	it("turn 摘要:无文本输出时首字字段输出 n/a", () => {
		const noText: TelemetryEvent = {
			...TURN_SPAN,
			timing: { providerRequestCount: 0, providerResponseCount: 0, toolCount: 0, toolTotalMs: 0, toolResultCount: 0 },
		};
		consoleSink().onEvent(noText);
		const output = String(logMock.mock.calls[0]?.[0]);
		expect(output).toContain("本轮首字 n/a");
		expect(output).toContain("状态 n/a");
	});

	it("tool_result span:正常 → [tool ←],错误 → [tool ✗ error],result 截断 300", () => {
		const sink = consoleSink();
		sink.onEvent({ ...BASE, kind: "span", spanType: "tool_result", tool: "bash", durationMs: 12, result: "ok" });
		sink.onEvent({
			...BASE,
			kind: "span",
			spanType: "tool_result",
			tool: "bash",
			isError: true,
			durationMs: 5,
			result: "x".repeat(500),
		});
		expect(String(logMock.mock.calls[0]?.[0])).toContain("🔧 [tool ←] bash · duration_ms=12  result=ok");
		const errLine = String(logMock.mock.calls[1]?.[0]);
		expect(errLine).toContain("🔧 [tool ✗ error] bash");
		expect(errLine).toContain("…<+200 chars>");
	});

	it("toolcall_ready stream:[tool →] + args 截断 400", () => {
		consoleSink().onEvent({
			...BASE,
			kind: "stream",
			streamType: "toolcall_ready",
			delta: "y".repeat(600),
			attrs: { tool: "gitlab_get_mr_diff" },
		});
		const line = String(logMock.mock.calls[0]?.[0]);
		expect(line).toContain("🔧 [tool →] gitlab_get_mr_diff");
		expect(line).toContain("…<+200 chars>");
	});

	it("thinking / text 流式增量直出到 stdout", () => {
		const sink = consoleSink();
		sink.onEvent({ ...BASE, kind: "stream", streamType: "text_start" });
		sink.onEvent({ ...BASE, kind: "stream", streamType: "text_delta", delta: "你好" });
		sink.onEvent({ ...BASE, kind: "stream", streamType: "text_end" });
		expect(writeMock.mock.calls.map((c) => String(c[0]))).toEqual(["\n💬 assistant: ", "你好", "\n"]);
	});

	it("agent span:session end 行含 stop_reason 与 usage", () => {
		consoleSink().onEvent({
			...BASE,
			kind: "span",
			spanType: "agent",
			durationMs: 60000,
			agent: { attempt: 1, stopReason: "end_turn", usage: { input: 100, output: 50, total: 150 } },
		});
		const line = String(logMock.mock.calls[0]?.[0]);
		expect(line).toContain(">>> 🤖 [agent] session end · attempt=1 · duration_ms=60000 · stop_reason=end_turn");
		expect(line).toContain("usage_input=100 · usage_output=50 · usage_total=150");
	});

	it("llm_call span:provider 响应头行", () => {
		consoleSink().onEvent({
			...BASE,
			kind: "span",
			spanType: "llm_call",
			attempt: 1,
			turnIndex: 2,
			request: 3,
			status: 200,
			durationMs: 357,
		});
		expect(String(logMock.mock.calls[0]?.[0])).toBe(
			">>> 🌐 [provider] response headers · agent_attempt=1 · turn=2 · request=3 · status=200 · response_headers_ms=357",
		);
	});

	it("agent_start / turn_start / provider_request 生命周期行", () => {
		const sink = consoleSink();
		sink.onEvent({ ...BASE, kind: "stream", streamType: "agent_start", attrs: { attempt: 1 } });
		sink.onEvent({ ...BASE, kind: "stream", streamType: "turn_start", attrs: { turnIndex: 0, attempt: 1 } });
		sink.onEvent({
			...BASE,
			kind: "stream",
			streamType: "provider_request",
			attrs: { attempt: 1, turnIndex: 0, request: 1 },
		});
		expect(String(logMock.mock.calls[0]?.[0])).toContain(">>> 🤖 [agent] session start · attempt=1");
		expect(String(logMock.mock.calls[1]?.[0])).toContain(">>> 🤖 [turn 0] start · agent_attempt=1");
		expect(String(logMock.mock.calls[2]?.[0])).toContain(
			">>> 🌐 [provider] request start · agent_attempt=1 · turn=0 · request=1",
		);
	});
});

describe("consoleSink · json 格式", () => {
	let logMock: MockInstance<typeof console.log>;

	beforeEach(() => {
		logMock = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logMock.mockRestore();
	});

	it("非 stream 事件:一行 JSON,可 parse 且含 traceId / seq / kind", () => {
		consoleSink({ format: "json" }).onEvent(TURN_SPAN);
		expect(logMock).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(String(logMock.mock.calls[0]?.[0])) as Record<string, unknown>;
		expect(parsed.traceId).toBe("t-1");
		expect(parsed.seq).toBe(1);
		expect(parsed.kind).toBe("span");
	});

	it("stream 事件不输出(避免 delta 刷屏 SLS)", () => {
		consoleSink({ format: "json" }).onEvent({ ...BASE, kind: "stream", streamType: "text_delta", delta: "x" });
		expect(logMock).not.toHaveBeenCalled();
	});
});
