/**
 * `run.ts · finishReviewTelemetry` 单元测试:评审收尾的 outcome 组装(AC4 的单测面)
 *
 * AC4 的"真跑产出合法 JSONL"属 e2e(本地无 GitLab,implement.md 已注明手工验证可跳);
 * 本文件闭环其**组装逻辑**:review-trace 真值 → line_comment×N / self_check / run_summary
 * outcome + trace_end + flush,以及 pipeline 未注册 / sink 抛错时的 fail-open。
 */

import {
	registerTelemetry,
	resetTelemetry,
	type TelemetryEvent,
	type TelemetrySink,
} from "@flower-ai/flower-telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordFileRead, recordLineComment, resetTrace } from "../review-trace.js";
import { finishReviewTelemetry } from "../run.js";

type AnyHandler = (event: unknown) => Promise<unknown> | unknown;

/** 最小 mock pi:只收下 on 注册(本测试不触发 pi 事件,直接调收尾函数) */
function mockPi() {
	return {
		on(_event: string, _fn: AnyHandler): void {},
	};
}

function collectorSink(): TelemetrySink & { events: TelemetryEvent[]; flushCount: number } {
	const sink = {
		name: "collector",
		events: [] as TelemetryEvent[],
		flushCount: 0,
		onEvent(event: TelemetryEvent) {
			sink.events.push(event);
		},
		async flush() {
			sink.flushCount += 1;
		},
	};
	return sink;
}

const RESULT = { exitCode: 1 as const, skillUsed: "general", blockerCount: 1, unsupportedFileCount: 1 };

beforeEach(() => {
	vi.unstubAllEnvs();
	resetTrace();
	resetTelemetry();
});

afterEach(() => {
	resetTrace();
	resetTelemetry();
});

describe("finishReviewTelemetry · outcome 组装", () => {
	it("trace 真值 → line_comment×N + self_check + run_summary + trace_end,flush 调一次,result 原样返回", async () => {
		const sink = collectorSink();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock 不实现完整 ExtensionAPI 接口
		registerTelemetry(mockPi() as any, { product: "test", traceId: "t-run", sinks: [sink] });

		// 造 trace 真值:读过 a.ts;对 a.ts(blocker)与 b.ts(major,未读 → 无依据)发了评论
		recordFileRead("src/a.ts");
		recordLineComment({ file: "src/a.ts", line: 10, severity: "blocker", body: "🔴 **阻塞** · 硬编码 secret" });
		recordLineComment({ file: "src/b.ts", line: 20, severity: "major", body: "🟠 **重要** · 性能问题" });

		const returned = await finishReviewTelemetry(RESULT);
		expect(returned).toBe(RESULT);
		expect(sink.flushCount).toBe(1);

		const outcomes = sink.events.filter((e) => e.kind === "outcome") as Extract<TelemetryEvent, { kind: "outcome" }>[];
		const comments = outcomes.filter((o) => o.outcomeType === "line_comment");
		expect(comments).toHaveLength(2);
		expect(comments[0]?.comment).toEqual({ file: "src/a.ts", line: 10, severity: "blocker", title: "硬编码 secret" });

		const selfCheck = outcomes.find((o) => o.outcomeType === "self_check");
		expect(selfCheck?.selfCheck).toEqual({
			unsupportedFiles: ["src/b.ts"],
			blockerCount: 1,
			workspacePrepareCount: 0,
		});

		const summary = outcomes.find((o) => o.outcomeType === "run_summary");
		expect(summary?.runSummary).toEqual({
			exitCode: 1,
			skillUsed: "general",
			blockerCount: 1,
			unsupportedFileCount: 1,
		});

		const end = sink.events.find((e) => e.kind === "trace_end");
		expect(end).toBeDefined();
		// 事件次序:outcome 全部在 trace_end 之前(JSONL 重放排序契约)
		expect(sink.events.indexOf(end as TelemetryEvent)).toBeGreaterThan(
			sink.events.indexOf(outcomes[outcomes.length - 1] as TelemetryEvent),
		);
	});

	it("pipeline 未注册(单测/dry 场景)→ 不抛,result 原样返回", async () => {
		resetTelemetry();
		await expect(finishReviewTelemetry(RESULT)).resolves.toBe(RESULT);
	});

	it("sink 抛错 → fail-open,不影响评审结论", async () => {
		const bad: TelemetrySink = {
			name: "bad",
			onEvent() {
				throw new Error("sink down");
			},
			async flush() {
				throw new Error("flush down");
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerTelemetry(mockPi() as any, { product: "test", traceId: "t-bad", sinks: [bad] });
		recordLineComment({ file: "src/a.ts", line: 1, severity: "blocker", body: "🔴 **阻塞** · X" });
		await expect(finishReviewTelemetry(RESULT)).resolves.toBe(RESULT);
	});
});
