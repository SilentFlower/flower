/**
 * SIEM 审计端点单测:sendAudit payload 兼容(含无 traceId 旧格式)、tool_blocked 回写、
 * 跨通道计数去重(audit 先到 / events 先到)、非法 payload 400、鉴权覆盖
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ObserverConfig } from "../config.js";
import { ObserverDb } from "../db.js";
import { createIngestRoutes } from "../routes/ingest.js";

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

/** 先注入一条 trace_start 让 trace 行存在 */
async function seedTrace(app: Hono, traceId: string): Promise<void> {
	const event = {
		kind: "trace_start",
		traceId,
		product: "code-reviewer",
		seq: 1,
		ts: 1_000,
		correlation: { project: "g/r", mrIid: "1", commitSha: "c", pipelineId: "9" },
		reason: "startup",
	};
	await app.request("/v1/events", { method: "POST", body: `${JSON.stringify(event)}\n` });
}

/** security_block outcome 事件(events 通道侧的同源拦截) */
function securityBlockEvent(traceId: string, tool: string, ts: number, seq: number): Record<string, unknown> {
	return {
		kind: "outcome",
		outcomeType: "security_block",
		traceId,
		product: "code-reviewer",
		seq,
		ts,
		securityBlock: { tool, mode: "ci-readonly", reason: "只读模式禁止写操作", toolCallId: "tc-1" },
	};
}

/** tool_blocked 审计记录(siemSink 投影形态:与源事件共享 tool/ts) */
function toolBlockedAudit(traceId: string, tool: string, ts: number): Record<string, unknown> {
	return {
		kind: "tool_blocked",
		product: "code-reviewer",
		traceId,
		tool,
		mode: "ci-readonly",
		reason: "只读模式禁止写操作",
		ts,
	};
}

/** POST /v1/audit 辅助 */
async function postAudit(app: Hono, payload: unknown, token?: string): Promise<Response> {
	return app.request("/v1/audit", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: typeof payload === "string" ? payload : JSON.stringify(payload),
	});
}

describe("SIEM /v1/audit", () => {
	let db: ObserverDb;
	let app: Hono;

	beforeEach(() => {
		db = new ObserverDb(":memory:");
		app = new Hono();
		app.route("/", createIngestRoutes(db, makeConfig()));
	});

	it("tool_blocked(trace 存在)→ 入库 + 回写 block_count", async () => {
		await seedTrace(app, "t-1");
		const res = await postAudit(app, toolBlockedAudit("t-1", "bash", 2_000));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ stored: true, blockCounted: true });
		expect(db.getTrace("t-1")?.block_count).toBe(1);
		expect(db.hasToolBlockedAudit("t-1", "bash", 2_000)).toBe(true);
	});

	it("旧格式(无 traceId)session_start → 入库不报错", async () => {
		const res = await postAudit(app, {
			kind: "session_start",
			product: "code-reviewer",
			ts: 1_000,
			user: "ci",
			host: "runner-1",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ stored: true, blockCounted: false });
	});

	it("tool_blocked 但 trace 行不存在 → 容忍,仅存审计", async () => {
		const res = await postAudit(app, toolBlockedAudit("t-ghost", "bash", 2_000));
		expect(await res.json()).toEqual({ stored: true, blockCounted: false });
		expect(db.getTrace("t-ghost")).toBeUndefined();
		expect(db.hasToolBlockedAudit("t-ghost", "bash", 2_000)).toBe(true);
	});

	it("跨通道去重(audit 先到):events 侧同源 security_block 不再 ++", async () => {
		await seedTrace(app, "t-dup1");
		await postAudit(app, toolBlockedAudit("t-dup1", "bash", 3_000));
		expect(db.getTrace("t-dup1")?.block_count).toBe(1);

		await app.request("/v1/events", {
			method: "POST",
			body: `${JSON.stringify(securityBlockEvent("t-dup1", "bash", 3_000, 2))}\n`,
		});
		expect(db.getTrace("t-dup1")?.block_count).toBe(1);
		// outcome 事件本身正常入库(明细不受去重影响)
		expect(db.listEventsByTrace("t-dup1")).toHaveLength(2);
	});

	it("跨通道去重(events 先到):audit 侧同源 tool_blocked 不再 ++", async () => {
		await seedTrace(app, "t-dup2");
		await app.request("/v1/events", {
			method: "POST",
			body: `${JSON.stringify(securityBlockEvent("t-dup2", "bash", 3_000, 2))}\n`,
		});
		expect(db.getTrace("t-dup2")?.block_count).toBe(1);

		const res = await postAudit(app, toolBlockedAudit("t-dup2", "bash", 3_000));
		expect(await res.json()).toEqual({ stored: true, blockCounted: false });
		expect(db.getTrace("t-dup2")?.block_count).toBe(1);
	});

	it("不同源拦截(ts 不同)正常累计", async () => {
		await seedTrace(app, "t-multi");
		await postAudit(app, toolBlockedAudit("t-multi", "bash", 3_000));
		await postAudit(app, toolBlockedAudit("t-multi", "bash", 4_000));
		expect(db.getTrace("t-multi")?.block_count).toBe(2);
	});

	it("非法 payload(parse 失败 / 非对象 / 缺 kind)→ 400", async () => {
		expect((await postAudit(app, "{broken")).status).toBe(400);
		expect((await postAudit(app, "[1,2]")).status).toBe(400);
		expect((await postAudit(app, { product: "x", ts: 1 })).status).toBe(400);
	});

	it("配置 token 时 /v1/audit 同样鉴权", async () => {
		const authedApp = new Hono();
		authedApp.route("/", createIngestRoutes(db, makeConfig({ ingestToken: "secret" })));
		expect((await postAudit(authedApp, toolBlockedAudit("t", "bash", 1))).status).toBe(401);
		expect((await postAudit(authedApp, toolBlockedAudit("t", "bash", 1), "secret")).status).toBe(200);
	});
});
