/**
 * `audit.ts` 单元测试:`sendAudit` 上报行为
 *
 * 关键约束(spec error-handling.md):
 * - 审计是辅助通道,**绝不阻塞主流程**:fetch 失败默认静默,`DEBUG_AUDIT=1` 才 warn
 * - `SIEM_INGEST_URL` 不配 → 什么都不做(允许);`DEBUG_AUDIT=1` 时打到 stdout
 * - `AbortSignal.timeout(2000)` 必须设置(防 SIEM 抖动 hang)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAudit } from "../audit.js";

const FAKE_RECORD = { kind: "tool_call", product: "test", tool: "read", ts: 1700000000000 };

describe("sendAudit · SIEM_INGEST_URL 缺省", () => {
	const fetchMock = vi.fn<typeof fetch>();
	const logMock = vi.spyOn(console, "log").mockImplementation(() => {});
	const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});

	beforeEach(() => {
		fetchMock.mockReset();
		logMock.mockClear();
		warnMock.mockClear();
		vi.unstubAllEnvs();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("SIEM_INGEST_URL 未设置 + DEBUG_AUDIT 未设 → fetch 未调,console.log 未调", async () => {
		await sendAudit(FAKE_RECORD);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(logMock).not.toHaveBeenCalled();
	});

	it("SIEM_INGEST_URL 为空字符串 → 行为同未设置", async () => {
		vi.stubEnv("SIEM_INGEST_URL", "");
		await sendAudit(FAKE_RECORD);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("DEBUG_AUDIT=1 + URL 未设 → console.log 一次,fetch 仍未调", async () => {
		vi.stubEnv("DEBUG_AUDIT", "1");
		await sendAudit(FAKE_RECORD);
		expect(logMock).toHaveBeenCalledTimes(1);
		expect(logMock.mock.calls[0]?.[0]).toBe("[audit]");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("sendAudit · SIEM_INGEST_URL 已配置", () => {
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

	it("fetch 调一次,URL 正确,body 含 record + user + host", async () => {
		fetchMock.mockResolvedValueOnce(new Response(""));
		await sendAudit(FAKE_RECORD);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://siem.example/ingest");
		expect((init as RequestInit | undefined)?.method).toBe("POST");
		const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as Record<string, unknown>;
		expect(body.kind).toBe("tool_call");
		expect(body.product).toBe("test");
		expect(body.user).toBeDefined();
		expect(body.host).toBeDefined();
	});

	it("AbortSignal.timeout 必须设置(防 SIEM 抖动 hang)", async () => {
		fetchMock.mockResolvedValueOnce(new Response(""));
		await sendAudit(FAKE_RECORD);
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
	});

	it("fetch 抛错 → 默认静默,sendAudit 不抛(绝不阻塞主流程)", async () => {
		fetchMock.mockRejectedValueOnce(new Error("network down"));
		await expect(sendAudit(FAKE_RECORD)).resolves.toBeUndefined();
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("DEBUG_AUDIT=1 时 fetch 抛错 → console.warn 一次,sendAudit 不抛", async () => {
		vi.stubEnv("DEBUG_AUDIT", "1");
		fetchMock.mockRejectedValueOnce(new Error("network down"));
		await expect(sendAudit(FAKE_RECORD)).resolves.toBeUndefined();
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(warnMock.mock.calls[0]?.[0]).toContain("[audit] 上报失败:");
	});

	it("fetch 超时(AbortError)→ 默认静默,不抛", async () => {
		const abortErr = new DOMException("aborted", "AbortError");
		fetchMock.mockRejectedValueOnce(abortErr);
		await expect(sendAudit(FAKE_RECORD)).resolves.toBeUndefined();
		expect(warnMock).not.toHaveBeenCalled();
	});
});
