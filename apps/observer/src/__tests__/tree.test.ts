/**
 * tree.ts 树重建单测:三层重建、toolCallId 配对、拦截挂卡、评论内联、
 * 进行中未闭合、孤儿 result、缺口检测、平铺顺序
 */

import type { TelemetryEvent } from "@flower-ai/flower-telemetry";
import { describe, expect, it } from "vitest";
import { buildTraceFlow, detectGaps } from "../views/tree.js";

/** 事件构造捷径(信封字段填默认) */
function ev(partial: Record<string, unknown>): TelemetryEvent {
	return { traceId: "t", product: "code-reviewer", ts: 1_000, ...partial } as unknown as TelemetryEvent;
}

/** 一条两轮、含配对工具与评论的完整 trace */
function fullTrace(): TelemetryEvent[] {
	return [
		ev({
			kind: "trace_start",
			seq: 1,
			correlation: { project: "g/r", mrIid: "1", commitSha: "c", pipelineId: "9" },
			reason: "startup",
		}),
		ev({ kind: "span", spanType: "llm_call", seq: 2, status: 200, request: 1, durationMs: 800 }),
		ev({
			kind: "span",
			spanType: "tool_call",
			seq: 3,
			tool: "gitlab_get_mr_diff",
			toolCallId: "tc1",
			inputKeys: ["projectId"],
		}),
		ev({ kind: "span", spanType: "tool_result", seq: 4, tool: "gitlab_get_mr_diff", toolCallId: "tc1", durationMs: 120 }),
		ev({
			kind: "span",
			spanType: "turn",
			seq: 5,
			turnIndex: 1,
			attempt: 1,
			durationMs: 2_000,
			timing: { providerRequestCount: 1, providerResponseCount: 1, toolCount: 1, toolTotalMs: 120, toolResultCount: 1 },
		}),
		ev({ kind: "span", spanType: "tool_call", seq: 6, tool: "gitlab_post_line_comment", toolCallId: "tc2" }),
		ev({
			kind: "outcome",
			outcomeType: "line_comment",
			seq: 7,
			comment: { file: "a.ts", line: 3, severity: "major", title: "越界" },
		}),
		ev({ kind: "span", spanType: "tool_result", seq: 8, tool: "gitlab_post_line_comment", toolCallId: "tc2" }),
		ev({ kind: "span", spanType: "turn", seq: 9, turnIndex: 2, attempt: 1, durationMs: 1_500 }),
		ev({ kind: "span", spanType: "agent", seq: 10, agent: { attempt: 1, stopReason: "stop", usage: { total: 900 } } }),
		ev({
			kind: "outcome",
			outcomeType: "run_summary",
			seq: 11,
			runSummary: { exitCode: 0, skillUsed: "general", blockerCount: 0, unsupportedFileCount: 0 },
		}),
		ev({ kind: "trace_end", seq: 12, totals: { turns: 2, toolCalls: 2, durationMs: 4_000 } }),
	];
}

describe("buildTraceFlow", () => {
	it("attempt → turn → 叶子 三层重建", () => {
		const flow = buildTraceFlow(fullTrace());
		expect(flow.attempts).toHaveLength(1);
		const attempt = flow.attempts[0];
		expect(attempt?.attempt).toBe(1);
		expect(attempt?.open).toBe(false);
		expect(attempt?.turns.map((turn) => turn.turnIndex)).toEqual([1, 2]);
		// 轮 1:llm_call + tool 卡片;轮 2:tool 卡片 + 内联评论
		expect(attempt?.turns[0]?.items.map((item) => item.type)).toEqual(["llm_call", "tool"]);
		expect(attempt?.turns[1]?.items.map((item) => item.type)).toEqual(["tool", "comment"]);
		expect(flow.start?.kind).toBe("trace_start");
		expect(flow.end?.kind).toBe("trace_end");
		expect(flow.runSummary?.outcomeType).toBe("run_summary");
		expect(flow.gaps).toEqual([]);
	});

	it("tool_call / tool_result 按 toolCallId 配对单卡片(seq 取调用时刻)", () => {
		const flow = buildTraceFlow(fullTrace());
		const tool = flow.attempts[0]?.turns[0]?.items[1];
		expect(tool?.type).toBe("tool");
		if (tool?.type !== "tool") throw new Error("应为 tool 卡片");
		expect(tool.call?.toolCallId).toBe("tc1");
		expect(tool.result?.toolCallId).toBe("tc1");
		expect(tool.seq).toBe(3);
	});

	it("security_block 按 toolCallId 挂回对应卡片;无配对时独立红条", () => {
		const events = [
			ev({ kind: "span", spanType: "tool_call", seq: 1, tool: "bash", toolCallId: "tcb" }),
			ev({
				kind: "outcome",
				outcomeType: "security_block",
				seq: 2,
				securityBlock: { tool: "bash", mode: "ci-readonly", reason: "禁止写操作", toolCallId: "tcb" },
			}),
			ev({
				kind: "outcome",
				outcomeType: "security_block",
				seq: 3,
				securityBlock: { tool: "rm", mode: "ci-readonly", reason: "孤儿拦截" },
			}),
		];
		const flow = buildTraceFlow(events);
		expect(flow.blocks).toHaveLength(2);
		// 配对拦截的锚点指向所挂 tool 卡片(seq=1),孤儿拦截指向自身(seq=3)
		expect(flow.blocks.map((block) => block.anchorSeq)).toEqual([1, 3]);
		const items = flow.flat;
		const toolItem = items.find((item) => item.type === "tool");
		if (toolItem?.type !== "tool") throw new Error("应有 tool 卡片");
		expect(toolItem.blocked?.securityBlock?.reason).toBe("禁止写操作");
		expect(items.filter((item) => item.type === "block")).toHaveLength(1);
	});

	it("进行中 trace:未闭合轮 / attempt 标记 open", () => {
		const events = [
			ev({
				kind: "trace_start",
				seq: 1,
				correlation: { project: "g/r", mrIid: "1", commitSha: "c", pipelineId: "9" },
				reason: "startup",
			}),
			ev({ kind: "span", spanType: "tool_call", seq: 2, tool: "bash", toolCallId: "x" }),
		];
		const flow = buildTraceFlow(events);
		expect(flow.attempts).toHaveLength(1);
		expect(flow.attempts[0]?.open).toBe(true);
		expect(flow.attempts[0]?.attempt).toBeUndefined();
		expect(flow.attempts[0]?.turns[0]?.open).toBe(true);
		expect(flow.attempts[0]?.turns[0]?.items).toHaveLength(1);
	});

	it("孤儿 tool_result(对应 call 在缺口中)独立成卡片", () => {
		const events = [
			ev({ kind: "span", spanType: "tool_result", seq: 5, tool: "bash", toolCallId: "lost", isError: true }),
		];
		const flow = buildTraceFlow(events);
		const item = flow.flat[0];
		if (item?.type !== "tool") throw new Error("应为 tool 卡片");
		expect(item.call).toBeUndefined();
		expect(item.result?.isError).toBe(true);
		expect(flow.gaps).toEqual([{ from: 1, to: 4 }]);
	});

	it("平铺流按 seq 排序且配对项只出现一次", () => {
		const flow = buildTraceFlow(fullTrace());
		expect(flow.flat.map((item) => item.seq)).toEqual([2, 3, 6, 7]);
	});
});

describe("detectGaps", () => {
	it("中段与首段缺口都能报告区间", () => {
		const events = [
			ev({ kind: "span", spanType: "llm_call", seq: 3 }),
			ev({ kind: "span", spanType: "llm_call", seq: 7 }),
		];
		expect(detectGaps(events)).toEqual([
			{ from: 1, to: 2 },
			{ from: 4, to: 6 },
		]);
	});

	it("无缺口返回空", () => {
		const events = [1, 2, 3].map((seq) => ev({ kind: "span", spanType: "llm_call", seq }));
		expect(detectGaps(events)).toEqual([]);
	});
});
