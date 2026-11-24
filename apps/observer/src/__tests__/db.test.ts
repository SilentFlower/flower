/**
 * db.ts 存储层单测:WAL 生效、(trace_id, seq) 幂等、聚合不重计、保留期清理、事务回滚
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EventRow, ObserverDb } from "../db.js";

/** 构造一条事件行(默认值可覆写) */
function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
	return {
		trace_id: "trace-1",
		seq: 1,
		product: "code-reviewer",
		kind: "span",
		ts: 1_000,
		payload: '{"kind":"span"}',
		...overrides,
	};
}

describe("ObserverDb", () => {
	let dir: string;
	let db: ObserverDb;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "observer-db-"));
		db = new ObserverDb(join(dir, "test.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("文件库 WAL 生效", () => {
		expect(db.journalMode()).toBe("wal");
	});

	it("(trace_id, seq) 幂等:重复插入跳过", () => {
		expect(db.insertEventIfAbsent(makeEvent())).toBe(true);
		expect(db.insertEventIfAbsent(makeEvent())).toBe(false);
		expect(db.listEventsByTrace("trace-1")).toHaveLength(1);
	});

	it("聚合只在实际插入时增量:整批重发不重计", () => {
		// 模拟 ingest 编排:插入成功才 touch(httpSink 超时重发 = 同一批再来一遍)
		const batch = [makeEvent({ seq: 1 }), makeEvent({ seq: 2 }), makeEvent({ seq: 3 })];
		for (let round = 0; round < 2; round++) {
			for (const event of batch) {
				if (db.insertEventIfAbsent(event)) {
					db.touchTrace(event.trace_id, event.product, event.seq, event.ts);
				}
			}
		}
		const trace = db.getTrace("trace-1");
		expect(trace?.event_count).toBe(3);
		expect(trace?.max_seq).toBe(3);
	});

	it("物化写路径:trace_start / line_comment / run_summary / trace_end 落列", () => {
		const event = makeEvent({ kind: "trace_start" });
		db.insertEventIfAbsent(event);
		db.touchTrace(event.trace_id, event.product, event.seq, event.ts);
		db.applyTraceStart("trace-1", { project: "group/repo", mrIid: "42", commitSha: "abc123", pipelineId: "777" }, 1_000);
		db.applyLineComment("trace-1", true);
		db.applyLineComment("trace-1", false);
		db.applySecurityBlock("trace-1");
		db.applyRunSummary("trace-1", 0, "general");
		db.applyTraceEnd("trace-1", 9_000, { turns: 6, toolCalls: 14, durationMs: 8_000 });
		db.setTraceStatus("trace-1", "success");

		const trace = db.getTrace("trace-1");
		expect(trace).toMatchObject({
			project: "group/repo",
			mr_iid: "42",
			commit_sha: "abc123",
			pipeline_id: "777",
			started_at: 1_000,
			ended_at: 9_000,
			status: "success",
			turns: 6,
			tool_calls: 14,
			duration_ms: 8_000,
			comment_count: 2,
			blocker_count: 1,
			block_count: 1,
			exit_code: 0,
			skill_used: "general",
		});
	});

	it("保留期清理:超期 trace 连同 events / security_events 删除,未超期保留", () => {
		// 老 trace(started_at=1000)与新 trace(started_at=10000)
		for (const [traceId, ts] of [
			["old-trace", 1_000],
			["new-trace", 10_000],
		] as const) {
			const event = makeEvent({ trace_id: traceId, ts, kind: "trace_start" });
			db.insertEventIfAbsent(event);
			db.touchTrace(traceId, event.product, 1, ts);
			db.applyTraceStart(traceId, { project: "p", mrIid: "1", commitSha: "c", pipelineId: "9" }, ts);
			db.insertSecurityEvent({
				trace_id: traceId,
				product: "code-reviewer",
				kind: "tool_blocked",
				tool: "bash",
				payload: "{}",
				ts,
				received_at: ts,
			});
		}
		// 无 traceId 的孤儿审计记录(旧 payload 兼容),按自身 ts 判过期
		db.insertSecurityEvent({
			trace_id: null,
			product: null,
			kind: "session_start",
			tool: null,
			payload: "{}",
			ts: 1_000,
			received_at: 1_000,
		});

		const deleted = db.deleteExpired(5_000);
		expect(deleted).toEqual({ traces: 1, events: 1, securityEvents: 2 });
		expect(db.getTrace("old-trace")).toBeUndefined();
		expect(db.getTrace("new-trace")).toBeDefined();
		expect(db.listEventsByTrace("old-trace")).toHaveLength(0);
		expect(db.listEventsByTrace("new-trace")).toHaveLength(1);
	});

	it("事务回滚:事务体抛错时数据不落库", () => {
		expect(() =>
			db.transaction(() => {
				const event = makeEvent();
				db.insertEventIfAbsent(event);
				db.touchTrace(event.trace_id, event.product, event.seq, event.ts);
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(db.listEventsByTrace("trace-1")).toHaveLength(0);
		expect(db.getTrace("trace-1")).toBeUndefined();
	});
});
