/**
 * ingest 单测:整批重发不重计、坏行容忍、Bearer 鉴权、四态物化(缺口/exitCode)、
 * 补发翻转、stale-running 查询期推导
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ObserverConfig } from "../config.js";
import { ObserverDb } from "../db.js";
import { createIngestRoutes } from "../routes/ingest.js";
import { displayStatus } from "../trace-status.js";

/** 构造测试配置(默认不鉴权) */
function makeConfig(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
	return {
		port: 0,
		dbPath: ":memory:",
		ingestToken: "",
		retentionDays: 90,
		staleRunningMinutes: 30,
		gitlabBaseUrl: "",
		...overrides,
	};
}

/** 一条完整 trace 的事件序列(seq 1-5;可注入 exitCode / 抽掉中间事件造缺口) */
function traceEventObjects(traceId: string, exitCode = 0): Array<Record<string, unknown>> {
	const base = { traceId, product: "code-reviewer" };
	return [
		{
			...base,
			kind: "trace_start",
			seq: 1,
			ts: 1_000,
			correlation: { project: "group/repo", mrIid: "42", commitSha: "abc12345", pipelineId: "777" },
			reason: "startup",
		},
		{ ...base, kind: "span", spanType: "tool_call", seq: 2, ts: 2_000, tool: "gitlab_get_mr_diff", toolCallId: "t1" },
		{
			...base,
			kind: "outcome",
			outcomeType: "line_comment",
			seq: 3,
			ts: 3_000,
			comment: { file: "a.ts", line: 10, severity: "blocker", title: "空指针" },
		},
		{
			...base,
			kind: "outcome",
			outcomeType: "run_summary",
			seq: 4,
			ts: 4_000,
			runSummary: { exitCode, skillUsed: "general", blockerCount: 1, unsupportedFileCount: 0 },
		},
		{ ...base, kind: "trace_end", seq: 5, ts: 5_000, totals: { turns: 2, toolCalls: 1, durationMs: 4_000 } },
	];
}

/** 事件对象数组 → NDJSON 请求体 */
function toNdjson(events: Array<Record<string, unknown>>): string {
	return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/** POST /v1/events 辅助 */
async function postEvents(app: Hono, body: string, token?: string): Promise<Response> {
	return app.request("/v1/events", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-ndjson",
			...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
		},
		body,
	});
}

describe("ingest", () => {
	let db: ObserverDb;
	let app: Hono;

	beforeEach(() => {
		db = new ObserverDb(":memory:");
		app = new Hono();
		app.route("/", createIngestRoutes(db, makeConfig()));
	});

	it("完整 trace 入库:聚合物化 + exitCode=0 → success", async () => {
		const res = await postEvents(app, toNdjson(traceEventObjects("t-ok")));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ accepted: 5, skipped: 0, badLines: 0 });

		const trace = db.getTrace("t-ok");
		expect(trace).toMatchObject({
			status: "success",
			project: "group/repo",
			mr_iid: "42",
			started_at: 1_000,
			ended_at: 5_000,
			turns: 2,
			tool_calls: 1,
			duration_ms: 4_000,
			comment_count: 1,
			blocker_count: 1,
			exit_code: 0,
			skill_used: "general",
			max_seq: 5,
			event_count: 5,
		});
	});

	it("整批重发不重计(httpSink 超时重发语义)", async () => {
		const body = toNdjson(traceEventObjects("t-retry"));
		await postEvents(app, body);
		const res = await postEvents(app, body);
		expect(await res.json()).toEqual({ accepted: 0, skipped: 5, badLines: 0 });

		const trace = db.getTrace("t-retry");
		expect(trace?.event_count).toBe(5);
		expect(trace?.comment_count).toBe(1);
		expect(trace?.blocker_count).toBe(1);
		expect(db.listEventsByTrace("t-retry")).toHaveLength(5);
	});

	it("exitCode 非 0 → failed", async () => {
		await postEvents(app, toNdjson(traceEventObjects("t-fail", 1)));
		expect(db.getTrace("t-fail")?.status).toBe("failed");
	});

	it("seq 缺口 → incomplete;补发缺失事件后翻转 success", async () => {
		const events = traceEventObjects("t-gap");
		// 抽掉 seq=3(line_comment)造缺口
		const withGap = events.filter((event) => event.seq !== 3);
		await postEvents(app, toNdjson(withGap));
		expect(db.getTrace("t-gap")?.status).toBe("incomplete");

		// 补发完整批(前 4 条 skipped,缺的 1 条补齐)→ 状态重判翻转
		const res = await postEvents(app, toNdjson(events));
		expect(await res.json()).toEqual({ accepted: 1, skipped: 4, badLines: 0 });
		const trace = db.getTrace("t-gap");
		expect(trace?.status).toBe("success");
		expect(trace?.comment_count).toBe(1);
	});

	it("坏行容忍:计数跳过不拒整批(parse 失败 / 缺信封 / stream 杂行)", async () => {
		const good = traceEventObjects("t-bad").slice(0, 2);
		const body = [
			JSON.stringify(good[0]),
			"{not-json",
			JSON.stringify({ kind: "span", seq: 9, ts: 1, product: "code-reviewer" }), // 缺 traceId
			JSON.stringify({
				kind: "stream",
				traceId: "t-bad",
				product: "code-reviewer",
				seq: 10,
				ts: 1,
				streamType: "text_delta",
			}),
			JSON.stringify(good[1]),
			"",
		].join("\n");
		const res = await postEvents(app, body);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ accepted: 2, skipped: 0, badLines: 3 });
		expect(db.listEventsByTrace("t-bad")).toHaveLength(2);
	});

	it("配置 token 时:无/错鉴权 401,正确 token 200,healthz 不鉴权", async () => {
		const authedApp = new Hono();
		authedApp.route("/", createIngestRoutes(db, makeConfig({ ingestToken: "secret" })));
		const body = toNdjson(traceEventObjects("t-auth"));

		expect((await postEvents(authedApp, body)).status).toBe(401);
		expect((await postEvents(authedApp, body, "wrong")).status).toBe(401);
		expect((await postEvents(authedApp, body, "secret")).status).toBe(200);
		expect((await authedApp.request("/healthz")).status).toBe(200);
	});

	it("未配置 token 时不鉴权(内网裸跑)", async () => {
		const res = await postEvents(app, toNdjson(traceEventObjects("t-noauth")));
		expect(res.status).toBe(200);
	});

	it("stale-running 查询期推导:超阈值的 running 展示为 incomplete(不回写)", async () => {
		// 只发 trace_start(永远等不到 trace_end 的崩溃场景)
		await postEvents(app, toNdjson(traceEventObjects("t-stale").slice(0, 1)));
		const row = db.getTrace("t-stale");
		expect(row?.status).toBe("running");
		if (row === undefined) throw new Error("trace 应已存在");

		const staleMinutes = 30;
		// 31 分钟后:展示为 incomplete;物化状态仍是 running
		expect(displayStatus(row, row.last_event_at + 31 * 60_000, staleMinutes)).toBe("incomplete");
		// 5 分钟内:仍展示 running
		expect(displayStatus(row, row.last_event_at + 5 * 60_000, staleMinutes)).toBe("running");
		expect(db.getTrace("t-stale")?.status).toBe("running");
	});
});
