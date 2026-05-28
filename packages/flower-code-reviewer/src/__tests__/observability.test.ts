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
		now = 1030;
		await emit(handlers, "message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "" },
		});
		now = 1040;
		await emit(handlers, "message_update", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "首" },
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
		expect(logText).toContain(">>> 🤖 第 0 轮结束 · 第 1 次尝试");
		expect(logText).toContain("总览: 本轮 1000ms · 模型请求 1 次 · 模型响应 1 次 · 工具 1 次 · 工具结果 1 个");
		expect(logText).toContain("模型接口: 请求开始 10ms · 响应头 10ms · 未返回等待 n/a · 状态 200");
		expect(logText).toContain("流式输出: 首个事件 25ms · 响应头到首个事件 5ms");
		expect(logText).toContain("文本输出: 本轮首字 40ms · 响应头到本轮首字 20ms");
		expect(logText).toContain("工具调用: 首个工具就绪 100ms · 工具总耗时 550ms");
		expect(logText).not.toContain("first_text_delta_ms");
		expect(logText).not.toContain("first_agent_message_event_ms");
		expect(logText).toContain("stop_reason=error");
		expect(logText).toContain("usage_input=11");
		expect(logText).toContain("error=Request timeout");
		expect(writeSpy).toHaveBeenCalledWith("\n💭 thinking: ");
		expect(writeSpy).toHaveBeenCalledWith("");
		expect(writeSpy).toHaveBeenCalledWith("首");
	});

	it("provider 无响应且没有文本输出时打印 pending 耗时,首字字段为 n/a", async () => {
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
		expect(logText).toContain("总览: 本轮 5100ms · 模型请求 1 次 · 模型响应 0 次 · 工具 0 次 · 工具结果 0 个");
		expect(logText).toContain("模型接口: 请求开始 100ms · 响应头 n/a · 未返回等待 5000ms · 状态 n/a");
		expect(logText).toContain("文本输出: 本轮首字 n/a · 响应头到本轮首字 n/a");
		expect(logText).not.toContain("first_text_delta_ms");
		expect(logText).not.toContain("provider_pending_ms");
	});

	it("FLOWER_VERBOSE=0 时不注册任何监听器", () => {
		process.env.FLOWER_VERBOSE = "0";
		const { pi, handlers } = createMockPi();

		registerObservability(pi);

		expect(Object.keys(handlers)).toEqual([]);
	});
});
