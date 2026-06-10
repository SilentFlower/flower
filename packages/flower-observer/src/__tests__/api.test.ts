/**
 * 查询 API 单测:过滤组合、stale 展示语义过滤、分页、详情 404、产品发现、指标聚合正确性
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ObserverConfig } from "../config.js";
import { ObserverDb } from "../db.js";
import { ingestNdjson } from "../ingest.js";
import { aggregateMetrics } from "../metrics.js";
import { createApiRoutes } from "../routes/api.js";

/** 构造测试配置 */
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

/**
 * 种子一条 trace(经真实 ingest 路径)
 *
 * @param db 观测库
 * @param traceId trace id
 * @param opts product/project/mr/exitCode/startTs/onlyStart(只发 trace_start 模拟 running)
 */
function seedTrace(
	db: ObserverDb,
	traceId: string,
	opts: {
		product?: string;
		project?: string;
		mrIid?: string;
		exitCode?: number;
		startTs?: number;
		durationMs?: number;
		onlyStart?: boolean;
	} = {},
): void {
	const product = opts.product ?? "code-reviewer";
	const startTs = opts.startTs ?? Date.now() - 60_000;
	const durationMs = opts.durationMs ?? 4_000;
	const events: Array<Record<string, unknown>> = [
		{
			kind: "trace_start",
			traceId,
			product,
			seq: 1,
			ts: startTs,
			correlation: {
				project: opts.project ?? "group/repo",
				mrIid: opts.mrIid ?? "42",
				commitSha: "abc12345",
				pipelineId: "777",
			},
			reason: "startup",
		},
	];
	if (opts.onlyStart !== true) {
		events.push(
			{
				kind: "outcome",
				outcomeType: "line_comment",
				traceId,
				product,
				seq: 2,
				ts: startTs + 1_000,
				comment: { file: "a.ts", line: 1, severity: "minor", title: "命名" },
			},
			{
				kind: "outcome",
				outcomeType: "run_summary",
				traceId,
				product,
				seq: 3,
				ts: startTs + 2_000,
				runSummary: { exitCode: opts.exitCode ?? 0, skillUsed: "general", blockerCount: 0, unsupportedFileCount: 0 },
			},
			{
				kind: "trace_end",
				traceId,
				product,
				seq: 4,
				ts: startTs + durationMs,
				totals: { turns: 2, toolCalls: 3, durationMs },
			},
		);
	}
	ingestNdjson(db, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

describe("查询 API", () => {
	let db: ObserverDb;
	let app: Hono;

	beforeEach(() => {
		db = new ObserverDb(":memory:");
		app = new Hono();
		app.route("/", createApiRoutes(db, makeConfig()));
	});

	it("/api/traces:product + project + mr + status 过滤组合", async () => {
		seedTrace(db, "t-a", { product: "code-reviewer", project: "g/a", mrIid: "1", exitCode: 0 });
		seedTrace(db, "t-b", { product: "code-reviewer", project: "g/b", mrIid: "2", exitCode: 1 });
		seedTrace(db, "t-c", { product: "ops-bot", project: "g/a", mrIid: "1", exitCode: 0 });

		const all = (await (await app.request("/api/traces")).json()) as { total: number };
		expect(all.total).toBe(3);

		const byProduct = (await (await app.request("/api/traces?product=ops-bot")).json()) as {
			total: number;
			rows: Array<{ trace_id: string }>;
		};
		expect(byProduct.total).toBe(1);
		expect(byProduct.rows[0]?.trace_id).toBe("t-c");

		const combo = (await (
			await app.request("/api/traces?product=code-reviewer&project=g/a&mr=1&status=success")
		).json()) as { total: number; rows: Array<{ trace_id: string }> };
		expect(combo.total).toBe(1);
		expect(combo.rows[0]?.trace_id).toBe("t-a");

		const failed = (await (await app.request("/api/traces?status=failed")).json()) as {
			rows: Array<{ trace_id: string }>;
		};
		expect(failed.rows.map((row) => row.trace_id)).toEqual(["t-b"]);
	});

	it("/api/traces:stale-running 按展示语义过滤(incomplete 命中,running 不命中)", async () => {
		// 31 分钟前只发了 trace_start → 物化 running,展示 incomplete
		seedTrace(db, "t-stale", { onlyStart: true, startTs: Date.now() - 31 * 60_000 });
		// 刚刚开始的 → 真 running
		seedTrace(db, "t-live", { onlyStart: true, startTs: Date.now() - 60_000 });

		const running = (await (await app.request("/api/traces?status=running")).json()) as {
			rows: Array<{ trace_id: string; display_status: string }>;
		};
		expect(running.rows.map((row) => row.trace_id)).toEqual(["t-live"]);

		const incomplete = (await (await app.request("/api/traces?status=incomplete")).json()) as {
			rows: Array<{ trace_id: string; display_status: string }>;
		};
		expect(incomplete.rows.map((row) => row.trace_id)).toEqual(["t-stale"]);
		expect(incomplete.rows[0]?.display_status).toBe("incomplete");
	});

	it("/api/traces:分页(pageSize=50,total 不受分页影响)", async () => {
		for (let index = 0; index < 55; index++) {
			seedTrace(db, `t-${index}`, { startTs: Date.now() - index * 1_000 });
		}
		const page1 = (await (await app.request("/api/traces")).json()) as { rows: unknown[]; total: number };
		expect(page1.total).toBe(55);
		expect(page1.rows).toHaveLength(50);
		const page2 = (await (await app.request("/api/traces?page=2")).json()) as { rows: unknown[]; page: number };
		expect(page2.rows).toHaveLength(5);
		expect(page2.page).toBe(2);
	});

	it("/api/traces/:id:trace + 全量事件(parse 后回放顺序);未知 id 404", async () => {
		seedTrace(db, "t-detail");
		const res = await app.request("/api/traces/t-detail");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			trace: { trace_id: string; display_status: string };
			events: Array<{ kind: string; seq: number }>;
		};
		expect(body.trace.trace_id).toBe("t-detail");
		expect(body.trace.display_status).toBe("success");
		expect(body.events.map((event) => event.kind)).toEqual(["trace_start", "outcome", "outcome", "trace_end"]);
		expect(body.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);

		expect((await app.request("/api/traces/nope")).status).toBe(404);
	});

	it("/api/products:动态发现去重", async () => {
		seedTrace(db, "t-1", { product: "code-reviewer" });
		seedTrace(db, "t-2", { product: "ops-bot" });
		seedTrace(db, "t-3", { product: "code-reviewer" });
		const body = (await (await app.request("/api/products")).json()) as { products: string[] };
		expect(body.products).toEqual(["code-reviewer", "ops-bot"]);
	});

	it("/api/metrics:卡片 / 直方图 / 最慢 Top 聚合正确", async () => {
		const now = Date.now();
		seedTrace(db, "t-fast", { exitCode: 0, durationMs: 20_000, startTs: now - 3_600_000 });
		seedTrace(db, "t-slow", { exitCode: 0, durationMs: 90_000, startTs: now - 7_200_000 });
		seedTrace(db, "t-bad", { exitCode: 1, durationMs: 150_000, startTs: now - 10_800_000 });
		seedTrace(db, "t-run", { onlyStart: true, startTs: now - 60_000 });

		const body = (await (await app.request("/api/metrics?days=7")).json()) as {
			cards: { total: number; successRate: number; p50DurationMs: number; p95DurationMs: number; blockTotal: number };
			histogram: Array<{ label: string; count: number }>;
			slowest: Array<{ trace_id: string }>;
			daily: { dates: string[]; products: string[]; counts: number[][] };
		};
		expect(body.cards.total).toBe(4);
		// 已结束 3 条(t-run 仍 running 不计入基数),success 2 条
		expect(body.cards.successRate).toBeCloseTo(2 / 3);
		expect(body.cards.p50DurationMs).toBe(90_000);
		expect(body.cards.p95DurationMs).toBe(150_000);
		expect(body.cards.blockTotal).toBe(0);

		const bucketCount = Object.fromEntries(body.histogram.map((bucket) => [bucket.label, bucket.count]));
		expect(bucketCount["<30s"]).toBe(1);
		expect(bucketCount["1–2m"]).toBe(1);
		expect(bucketCount["2–5m"]).toBe(1);

		expect(body.slowest.map((row) => row.trace_id)).toEqual(["t-bad", "t-slow", "t-fast"]);
		// 日期轴连续 8 天(7 天窗口 + 今天),全部 trace 都在今天
		expect(body.daily.dates.length).toBeGreaterThanOrEqual(7);
		expect(body.daily.products).toEqual(["code-reviewer"]);
	});

	it("aggregateMetrics:空数据时比值字段为 null", () => {
		const payload = aggregateMetrics([], { sinceMs: 0, nowMs: 1, staleRunningMinutes: 30 });
		expect(payload.cards).toEqual({
			total: 0,
			successRate: null,
			p50DurationMs: null,
			p95DurationMs: null,
			avgComments: null,
			blockTotal: 0,
		});
		expect(payload.slowest).toEqual([]);
	});
});
