/**
 * `observability.ts` 单元测试
 *
 * 覆盖 CI trace 诊断日志的关键字段,避免后续重构时丢失耗时与失败原因。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerObservability } from "../observability.js";

type Handler = (event: Record<string, unknown>) => Promise<void>;

function createMockPi(): {
	pi: Parameters<typeof registerObservability>[0];
	handlers: Record<string, Handler[]>;
} {
	const handlers: Record<string, Handler[]> = {};
	// biome-ignore lint/suspicious/noExplicitAny: 测试 mock,只实现 observability 用到的 on 接口
	const pi: any = {
		on: (eventName: string, handler: Handler) => {
			const list = handlers[eventName] ?? [];
			list.push(handler);
			handlers[eventName] = list;
		},
	};
	return { pi, handlers };
}

async function emit(
	handlers: Record<string, Handler[]>,
	eventName: string,
	event: Record<string, unknown>,
): Promise<void> {
	for (const handler of handlers[eventName] ?? []) {
		await handler(event);
	}
}

describe("registerObservability · 耗时诊断日志", () => {
	const originalVerbose = process.env.FLOWER_VERBOSE;
	let now = 1000;

	beforeEach(() => {
		now = 1000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		process.env.FLOWER_VERBOSE = "1";
	});

	afterEach(() => {
		if (originalVerbose === undefined) {
			delete process.env.FLOWER_VERBOSE;
		} else {
			process.env.FLOWER_VERBOSE = originalVerbose;
		}
		vi.restoreAllMocks();
	});

	it("打印 agent attempt、provider 耗时、agent 事件耗时、工具耗时和 agent 错误原因", async () => {
		const logSpy = vi.mocked(console.log);
		const writeSpy = vi.mocked(process.stdout.write);
		const { pi, handlers } = createMockPi();
		registerObservability(pi);

		await emit(handlers, "agent_start", { type: "agent_start" });
		expect(logSpy).toHaveBeenCalledWith("\n>>> 🤖 [agent] session start · attempt=1");

		await emit(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: now });
		now = 1010;
		await emit(handlers, "before_provider_request", { type: "before_provider_request", payload: {} });
		now = 1020;
		await emit(handlers, "after_provider_response", {
			type: "after_provider_response",
			status: 200,
			headers: {},
		});
		now = 1025;
		await emit(handlers, "message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_start" },
		});
		now = 1100;
		await emit(handlers, "message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "gitlab_get_mr_diff", arguments: {} } },
		});
		await emit(handlers, "tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "gitlab_get_mr_diff",
			args: {},
		});
		now = 1650;
		await emit(handlers, "tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "gitlab_get_mr_diff",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		now = 2000;
		await emit(handlers, "turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: {},
			toolResults: [{}],
		});
		now = 2500;
		await emit(handlers, "agent_end", {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "Request timeout",
					usage: { input: 11, output: 22, total: 33 },
				},
			],
		});

		const logText = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(logText).toContain("duration_ms=1000");
		expect(logText).toContain("provider_response_headers_ms=10");
		expect(logText).toContain("first_provider_request_ms=10");
		expect(logText).toContain("first_agent_message_event_ms=25");
		expect(logText).toContain("first_agent_message_after_provider_ms=5");
		expect(logText).toContain("first_tool_call_ready_event_ms=100");
		expect(logText).toContain("tools=1");
		expect(logText).toContain("tool_total_ms=550");
		expect(logText).toContain("stop_reason=error");
		expect(logText).toContain("usage_input=11");
		expect(logText).toContain("error=Request timeout");
		expect(writeSpy).toHaveBeenCalledWith("\n💭 thinking: ");
	});

	it("provider 无响应时打印 pending 耗时", async () => {
		const logSpy = vi.mocked(console.log);
		const { pi, handlers } = createMockPi();
		registerObservability(pi);

		await emit(handlers, "agent_start", { type: "agent_start" });
		await emit(handlers, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: now });
		now = 1100;
		await emit(handlers, "before_provider_request", { type: "before_provider_request", payload: {} });
		now = 6100;
		await emit(handlers, "turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: {},
			toolResults: [],
		});

		const logText = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(logText).toContain("provider_responses=0");
		expect(logText).toContain("provider_response_headers_ms=n/a");
		expect(logText).toContain("provider_pending_ms=5000");
	});

	it("FLOWER_VERBOSE=0 时不注册任何监听器", () => {
		process.env.FLOWER_VERBOSE = "0";
		const { pi, handlers } = createMockPi();

		registerObservability(pi);

		expect(Object.keys(handlers)).toEqual([]);
	});
});
