/**
 * `pipeline.ts` 单元测试:信封注入、脱敏截断 enforcement、sink fanout、critical 豁免、flush
 *
 * 关键约束(design.md):
 * - emit 绝不抛错;单 sink 抛错不影响其余 sink
 * - `FLOWER_TELEMETRY=0` 只屏蔽非 critical sink
 * - span.input / span.result / securityBlock.reason 必须经过脱敏(enforcement 点唯一)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryPipeline } from "../pipeline.js";
import type { TelemetryEvent, TelemetrySink } from "../types.js";

/** 收集事件的测试 sink */
function collectorSink(name: string, critical?: boolean): TelemetrySink & { events: TelemetryEvent[] } {
	const events: TelemetryEvent[] = [];
	return {
		name,
		...(critical !== undefined ? { critical } : {}),
		events,
		onEvent(event) {
			events.push(event);
		},
	};
}

function makePipeline(sinks: TelemetrySink[]): TelemetryPipeline {
	return new TelemetryPipeline({ traceId: "t-1", product: "test", sinks });
}

beforeEach(() => {
	vi.unstubAllEnvs();
});

describe("TelemetryPipeline · 信封注入", () => {
	it("traceId / product / seq / ts 自动注入,seq 单调递增", () => {
		const sink = collectorSink("c");
		const pipeline = makePipeline([sink]);
		pipeline.emit({ kind: "span", spanType: "tool_call", tool: "bash" });
		pipeline.emit({ kind: "span", spanType: "tool_result", tool: "bash" });
		expect(sink.events).toHaveLength(2);
		expect(sink.events[0]).toMatchObject({ traceId: "t-1", product: "test", seq: 1 });
		expect(sink.events[1]).toMatchObject({ seq: 2 });
		expect(typeof sink.events[0]?.ts).toBe("number");
	});
});

describe("TelemetryPipeline · fanout 容错", () => {
	it("第一个 sink 抛错,后续 sink 仍收到事件,emit 不抛", () => {
		const bad: TelemetrySink = {
			name: "bad",
			onEvent() {
				throw new Error("sink down");
			},
		};
		const good = collectorSink("good");
		const pipeline = makePipeline([bad, good]);
		expect(() => pipeline.emit({ kind: "trace_end", totals: { turns: 1, toolCalls: 0, durationMs: 5 } })).not.toThrow();
		expect(good.events).toHaveLength(1);
	});

	it("sink 抛错默认静默;DEBUG_TELEMETRY=1 时 warn 一次", () => {
		const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
		const bad: TelemetrySink = {
			name: "bad",
			onEvent() {
				throw new Error("boom");
			},
		};
		const pipeline = makePipeline([bad]);
		pipeline.emit({ kind: "span", spanType: "turn" });
		expect(warnMock).not.toHaveBeenCalled();

		vi.stubEnv("DEBUG_TELEMETRY", "1");
		pipeline.emit({ kind: "span", spanType: "turn" });
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(String(warnMock.mock.calls[0]?.[0])).toContain('[telemetry] sink "bad"');
		warnMock.mockRestore();
	});
});

describe("TelemetryPipeline · FLOWER_TELEMETRY=0 总开关", () => {
	it("非 critical sink 被屏蔽,critical sink 照常接收", () => {
		vi.stubEnv("FLOWER_TELEMETRY", "0");
		const normal = collectorSink("normal");
		const critical = collectorSink("siem", true);
		const pipeline = makePipeline([normal, critical]);
		pipeline.emit({ kind: "span", spanType: "tool_call", tool: "bash" });
		expect(normal.events).toHaveLength(0);
		expect(critical.events).toHaveLength(1);
	});

	it("未设置 FLOWER_TELEMETRY → 全部 sink 接收(默认开)", () => {
		const normal = collectorSink("normal");
		const pipeline = makePipeline([normal]);
		pipeline.emit({ kind: "span", spanType: "turn" });
		expect(normal.events).toHaveLength(1);
	});
});

describe("TelemetryPipeline · 脱敏截断 enforcement", () => {
	it("span.input / span.result 中的 secret 被脱敏", () => {
		const sink = collectorSink("c");
		const pipeline = makePipeline([sink]);
		pipeline.emit({
			kind: "span",
			spanType: "tool_call",
			tool: "bash",
			input: '{"command":"curl -H \'Authorization: Bearer sk123456789abc\' x"}',
		});
		pipeline.emit({
			kind: "span",
			spanType: "tool_result",
			tool: "bash",
			result: "token glpat-AbCd1234_-xyz98765 leaked",
		});
		const call = sink.events[0] as Extract<TelemetryEvent, { kind: "span" }>;
		const result = sink.events[1] as Extract<TelemetryEvent, { kind: "span" }>;
		expect(call.input).toContain("[REDACTED:bearer]");
		expect(result.result).toContain("[REDACTED:gitlab-pat]");
	});

	it("超长字段被截断(标注省略字符数)", () => {
		const sink = collectorSink("c");
		const pipeline = makePipeline([sink]);
		pipeline.emit({ kind: "span", spanType: "tool_result", tool: "bash", result: "x".repeat(5000) });
		const ev = sink.events[0] as Extract<TelemetryEvent, { kind: "span" }>;
		expect(ev.result?.length).toBeLessThan(4100);
		expect(ev.result).toContain("…<+");
	});

	it("securityBlock.reason / command 被脱敏", () => {
		const sink = collectorSink("c");
		const pipeline = makePipeline([sink]);
		pipeline.emit({
			kind: "outcome",
			outcomeType: "security_block",
			securityBlock: {
				tool: "bash",
				mode: "ci-readonly",
				reason: 'bash 命令 "curl" 不在白名单内: Bearer abc12345678',
				command: "curl -H 'PRIVATE-TOKEN: glpat-AbCd1234_-xyz98765' http://x",
			},
		});
		const ev = sink.events[0] as Extract<TelemetryEvent, { kind: "outcome" }>;
		expect(ev.securityBlock?.reason).toContain("[REDACTED:bearer]");
		expect(ev.securityBlock?.command).toContain("[REDACTED:gitlab-pat]");
	});

	it("stream(toolcall_ready).delta 被脱敏;纯增量 delta 不处理", () => {
		const sink = collectorSink("c");
		const pipeline = makePipeline([sink]);
		pipeline.emit({
			kind: "stream",
			streamType: "toolcall_ready",
			delta: "args Bearer abc12345678",
			attrs: { tool: "bash" },
		});
		pipeline.emit({ kind: "stream", streamType: "text_delta", delta: "Bearer abc12345678" });
		const ready = sink.events[0] as Extract<TelemetryEvent, { kind: "stream" }>;
		const delta = sink.events[1] as Extract<TelemetryEvent, { kind: "stream" }>;
		expect(ready.delta).toContain("[REDACTED:bearer]");
		// 纯增量按设计直通(与现行 CI stdout 行为一致,见 types.ts 注释)
		expect(delta.delta).toBe("Bearer abc12345678");
	});
});

describe("TelemetryPipeline · flush", () => {
	it("全部 sink 的 flush 被调用;单个 flush 抛错不影响其余", async () => {
		const flushed: string[] = [];
		const a: TelemetrySink = {
			name: "a",
			onEvent() {},
			async flush() {
				flushed.push("a");
			},
		};
		const bad: TelemetrySink = {
			name: "bad",
			onEvent() {},
			async flush() {
				throw new Error("flush fail");
			},
		};
		const b: TelemetrySink = {
			name: "b",
			onEvent() {},
			async flush() {
				flushed.push("b");
			},
		};
		const pipeline = makePipeline([a, bad, b]);
		await expect(pipeline.flush()).resolves.toBeUndefined();
		expect(flushed).toEqual(["a", "b"]);
	});

	it("sink 无 flush 实现 → 跳过不报错", async () => {
		const pipeline = makePipeline([collectorSink("c")]);
		await expect(pipeline.flush()).resolves.toBeUndefined();
	});
});
