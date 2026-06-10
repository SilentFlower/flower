/**
 * `sinks/siem.ts` 单元测试:metadata-only 投影 + 上报行为
 *
 * 上报行为部分迁移自原 flower-compliance `audit.test.ts`,关键约束不变:
 * - 审计是辅助通道,**绝不阻塞主流程**:fetch 失败默认静默,`DEBUG_AUDIT=1` 才 warn
 * - `SIEM_INGEST_URL` 不配 → 什么都不做(允许);`DEBUG_AUDIT=1` 时打到 stdout
 * - `AbortSignal.timeout(2000)` 必须设置(防 SIEM 抖动 hang)
 *
 * 新增约束(本次架构):
 * - **payload 绝不含工具入参值**(只有 inputKeys 字段名列表)
 * - `security_block` outcome → `tool_blocked` kind(修复拦截事件漏审计缺陷)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectAuditRecord, siemSink } from "../sinks/siem.js";
import type { TelemetryEvent } from "../types.js";

/** 测试事件的公共信封字段 */
const BASE = { traceId: "t-1", product: "test", seq: 1, ts: 1700000000000 };

const TOOL_CALL_EVENT: TelemetryEvent = {
	...BASE,
	kind: "span",
	spanType: "tool_call",
	tool: "bash",
	inputKeys: ["command"],
	input: '{"command":"git status"}',
};

describe("projectAuditRecord · metadata-only 投影", () => {
	it("trace_start → session_start(兼容旧 payload)", () => {
		const record = projectAuditRecord({
			...BASE,
			kind: "trace_start",
			correlation: { project: "g/r", mrIid: "1", commitSha: "abc", pipelineId: "9" },
			reason: "startup",
		});
		expect(record).toEqual({ kind: "session_start", product: "test", reason: "startup", ts: BASE.ts });
	});

	it("span(tool_call) → tool_call:只有 inputKeys,**绝不含 input 值**", () => {
		const record = projectAuditRecord(TOOL_CALL_EVENT);
		expect(record).toEqual({ kind: "tool_call", product: "test", tool: "bash", inputKeys: ["command"], ts: BASE.ts });
		expect(JSON.stringify(record)).not.toContain("git status");
	});

	it("span(tool_result) → tool_result(只取 isError)", () => {
		const record = projectAuditRecord({
			...BASE,
			kind: "span",
			spanType: "tool_result",
			tool: "bash",
			isError: true,
			result: "secret output",
		});
		expect(record).toEqual({ kind: "tool_result", product: "test", tool: "bash", isError: true, ts: BASE.ts });
		expect(JSON.stringify(record)).not.toContain("secret output");
	});

	it("outcome(security_block) → tool_blocked(拦截漏报修复)", () => {
		const record = projectAuditRecord({
			...BASE,
			kind: "outcome",
			outcomeType: "security_block",
			securityBlock: { tool: "bash", mode: "ci-readonly", reason: 'bash 命令 "env" 不在白名单内' },
		});
		expect(record).toMatchObject({ kind: "tool_blocked", tool: "bash", mode: "ci-readonly" });
		expect(record?.reason).toContain("env");
	});

	it("无关事件(stream / turn span / line_comment outcome)→ undefined", () => {
		expect(projectAuditRecord({ ...BASE, kind: "stream", streamType: "text_delta", delta: "x" })).toBeUndefined();
		expect(projectAuditRecord({ ...BASE, kind: "span", spanType: "turn" })).toBeUndefined();
		expect(
			projectAuditRecord({
				...BASE,
				kind: "outcome",
				outcomeType: "line_comment",
				comment: { file: "a.ts", line: 1, severity: "major", title: "t" },
			}),
		).toBeUndefined();
	});
});

describe("siemSink · SIEM_INGEST_URL 缺省", () => {
	const fetchMock = vi.fn<typeof fetch>();
	const logMock = vi.spyOn(console, "log").mockImplementation(() => {});

	beforeEach(() => {
		fetchMock.mockReset();
		logMock.mockClear();
		vi.unstubAllEnvs();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("URL 未配置 + DEBUG_AUDIT 未设 → fetch 未调,console.log 未调", async () => {
		const sink = siemSink();
		sink.onEvent(TOOL_CALL_EVENT);
		await sink.flush?.();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(logMock).not.toHaveBeenCalled();
	});

	it("DEBUG_AUDIT=1 + URL 未设 → console.log 一次,fetch 仍未调", async () => {
		vi.stubEnv("DEBUG_AUDIT", "1");
		const sink = siemSink();
		sink.onEvent(TOOL_CALL_EVENT);
		await sink.flush?.();
		expect(logMock).toHaveBeenCalledTimes(1);
		expect(logMock.mock.calls[0]?.[0]).toBe("[audit]");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("siemSink · SIEM_INGEST_URL 已配置", () => {
	const fetchMock = vi.fn<typeof fetch>();
	const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});

	beforeEach(() => {
		fetchMock.mockReset();
		warnMock.mockClear();
		vi.unstubAllEnvs();
		vi.stubEnv("SIEM_INGEST_URL", "http://siem.example/ingest");
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetch 调一次,URL 正确,body 含投影字段 + user + host,**无 input 值**", async () => {
		fetchMock.mockResolvedValueOnce(new Response(""));
		const sink = siemSink();
		sink.onEvent(TOOL_CALL_EVENT);
		await sink.flush?.();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://siem.example/ingest");
		expect((init as RequestInit | undefined)?.method).toBe("POST");
		const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as Record<string, unknown>;
		expect(body.kind).toBe("tool_call");
		expect(body.inputKeys).toEqual(["command"]);
		expect(body.user).toBeDefined();
		expect(body.host).toBeDefined();
		expect(JSON.stringify(body)).not.toContain("git status");
	});

	it("AbortSignal.timeout 必须设置(防 SIEM 抖动 hang)", async () => {
		fetchMock.mockResolvedValueOnce(new Response(""));
		const sink = siemSink();
		sink.onEvent(TOOL_CALL_EVENT);
		await sink.flush?.();
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
	});

	it("fetch 抛错 → 默认静默,onEvent / flush 不抛(绝不阻塞主流程)", async () => {
		fetchMock.mockRejectedValueOnce(new Error("network down"));
		const sink = siemSink();
		expect(() => sink.onEvent(TOOL_CALL_EVENT)).not.toThrow();
		await expect(sink.flush?.()).resolves.toBeUndefined();
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("DEBUG_AUDIT=1 时 fetch 抛错 → console.warn 一次", async () => {
		vi.stubEnv("DEBUG_AUDIT", "1");
		fetchMock.mockRejectedValueOnce(new Error("network down"));
		const sink = siemSink();
		sink.onEvent(TOOL_CALL_EVENT);
		await sink.flush?.();
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(warnMock.mock.calls[0]?.[0]).toContain("[audit] 上报失败:");
	});

	it("options.url 优先于环境变量", async () => {
		fetchMock.mockResolvedValueOnce(new Response(""));
		const sink = siemSink({ url: "http://fixed.example/ingest" });
		sink.onEvent(TOOL_CALL_EVENT);
		await sink.flush?.();
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://fixed.example/ingest");
	});

	it("critical 标记为 true(不受 FLOWER_TELEMETRY 总开关影响的前提)", () => {
		expect(siemSink().critical).toBe(true);
	});
});
