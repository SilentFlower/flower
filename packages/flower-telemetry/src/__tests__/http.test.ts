/**
 * `sinks/http.ts` 单元测试:批量 NDJSON 推送 + 有界缓冲 + fail-open
 *
 * 关键约束:
 * - **行格式与 jsonlSink 逐字节一致**(每事件一行 `JSON.stringify`):服务端一个解析器吃两种来源
 * - 观测是辅助通道,**绝不阻塞主流程**:fetch 失败默认静默,`DEBUG_TELEMETRY=1` 才 warn
 * - 失败批留缓冲重试;缓冲超上限丢最旧(内存有界)
 * - `stream` 事件不推送(显示信号 + delta 不脱敏)
 * - 非 critical(受 FLOWER_TELEMETRY 总开关控制,与 siemSink 的"不可关"语义相反)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpSink } from "../sinks/http.js";
import type { TelemetryEvent } from "../types.js";

/** 测试事件的公共信封字段 */
const BASE = { traceId: "t-1", product: "test", seq: 1, ts: 1700000000000 };

/**
 * 构造一条 tool_call span 测试事件
 */
function spanEvent(seq: number): TelemetryEvent {
	return { ...BASE, seq, kind: "span", spanType: "tool_call", tool: "bash", inputKeys: ["command"], input: "{}" };
}

/**
 * 等待 sink 内部异步 drain 循环落定(mock fetch 即时 resolve,几个宏任务足够)
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/** 远端 ingest 端点(测试用) */
const URL = "http://observer.example/v1/events";

const fetchMock = vi.fn<typeof fetch>();
const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
	fetchMock.mockReset();
	warnMock.mockClear();
	vi.unstubAllEnvs();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/**
 * 取第 n 次 fetch 调用的 RequestInit
 */
function callInit(n: number): RequestInit | undefined {
	return fetchMock.mock.calls[n]?.[1] as RequestInit | undefined;
}

describe("httpSink · 批量与触发", () => {
	it("缓冲未达 batchSize 且间隔未到 → 不发送", async () => {
		const sink = httpSink({ url: URL, batchSize: 3, flushIntervalMs: 60_000 });
		sink.onEvent(spanEvent(1));
		sink.onEvent(spanEvent(2));
		await settle();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("达到 batchSize → 立即发送,body 为 NDJSON 且每行与 JSON.stringify 逐字节一致", async () => {
		fetchMock.mockResolvedValue(new Response(""));
		const sink = httpSink({ url: URL, batchSize: 2, flushIntervalMs: 60_000 });
		const e1 = spanEvent(1);
		const e2 = spanEvent(2);
		sink.onEvent(e1);
		sink.onEvent(e2);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(URL);
		expect(callInit(0)?.method).toBe("POST");
		// 与 jsonlSink 落盘格式同源:`JSON.stringify(event)` 一行一事件
		expect(callInit(0)?.body).toBe(`${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`);
	});

	it("距上次发送超过 flushIntervalMs → 下一事件触发发送", async () => {
		fetchMock.mockResolvedValue(new Response(""));
		const sink = httpSink({ url: URL, batchSize: 100, flushIntervalMs: 0 });
		sink.onEvent(spanEvent(1));
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stream 事件不入缓冲不推送", async () => {
		fetchMock.mockResolvedValue(new Response(""));
		const sink = httpSink({ url: URL, batchSize: 1, flushIntervalMs: 0 });
		sink.onEvent({ ...BASE, kind: "stream", streamType: "text_delta", delta: "secret-delta" });
		await settle();
		expect(fetchMock).not.toHaveBeenCalled();
		sink.onEvent(spanEvent(2));
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(callInit(0)?.body)).not.toContain("secret-delta");
	});
});

describe("httpSink · 请求头与超时", () => {
	it("Content-Type 为 application/x-ndjson;配置 token 时附 Bearer 头", async () => {
		fetchMock.mockResolvedValue(new Response(""));
		const sink = httpSink({ url: URL, token: "tok-1", batchSize: 1 });
		sink.onEvent(spanEvent(1));
		await settle();
		const headers = callInit(0)?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/x-ndjson");
		expect(headers.Authorization).toBe("Bearer tok-1");
	});

	it("未配置 token → 无 Authorization 头", async () => {
		fetchMock.mockResolvedValue(new Response(""));
		const sink = httpSink({ url: URL, batchSize: 1 });
		sink.onEvent(spanEvent(1));
		await settle();
		const headers = callInit(0)?.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("AbortSignal.timeout 必须设置(防观测服务抖动 hang)", async () => {
		fetchMock.mockResolvedValue(new Response(""));
		const sink = httpSink({ url: URL, batchSize: 1 });
		sink.onEvent(spanEvent(1));
		await settle();
		expect(callInit(0)?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("httpSink · 失败重试与有界缓冲", () => {
	it("fetch 抛错 → 整批留缓冲,flush 时重发同一批", async () => {
		fetchMock.mockRejectedValueOnce(new Error("network down"));
		const sink = httpSink({ url: URL, batchSize: 1, flushIntervalMs: 60_000 });
		const e1 = spanEvent(1);
		sink.onEvent(e1);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		fetchMock.mockResolvedValueOnce(new Response(""));
		await sink.flush?.();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(callInit(1)?.body).toBe(`${JSON.stringify(e1)}\n`);
	});

	it("HTTP 非 2xx → 同样留缓冲重试", async () => {
		fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
		const sink = httpSink({ url: URL, batchSize: 1, flushIntervalMs: 60_000 });
		sink.onEvent(spanEvent(1));
		await settle();
		fetchMock.mockResolvedValueOnce(new Response(""));
		await sink.flush?.();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("缓冲超 maxBufferedEvents → 丢最旧,保最新", async () => {
		fetchMock.mockResolvedValue(new Response(""));
		// batchSize 大 + 间隔远:onEvent 阶段不触发发送,全部滞留缓冲
		const sink = httpSink({ url: URL, batchSize: 100, flushIntervalMs: 60_000, maxBufferedEvents: 2 });
		const events = [spanEvent(1), spanEvent(2), spanEvent(3), spanEvent(4)];
		for (const event of events) {
			sink.onEvent(event);
		}
		await sink.flush?.();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(callInit(0)?.body).toBe(`${JSON.stringify(events[2])}\n${JSON.stringify(events[3])}\n`);
	});

	it("持续失败 → flush 无进展即放弃,resolve 不抛(fail-open)", async () => {
		fetchMock.mockRejectedValue(new Error("observer down"));
		const sink = httpSink({ url: URL, batchSize: 1, flushIntervalMs: 60_000 });
		sink.onEvent(spanEvent(1));
		await settle();
		// kick 一次失败 + flush 最后一搏一次失败 → 共 2 次,随后放弃
		await expect(sink.flush?.()).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("失败默认静默;DEBUG_TELEMETRY=1 时单行 warn", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));
		const silent = httpSink({ url: URL, batchSize: 1, flushIntervalMs: 60_000 });
		silent.onEvent(spanEvent(1));
		await settle();
		expect(warnMock).not.toHaveBeenCalled();

		vi.stubEnv("DEBUG_TELEMETRY", "1");
		const verbose = httpSink({ url: URL, batchSize: 1, flushIntervalMs: 60_000 });
		verbose.onEvent(spanEvent(2));
		await settle();
		expect(warnMock).toHaveBeenCalled();
		expect(String(warnMock.mock.calls[0]?.[0])).toContain("[telemetry] http 上报失败:");
	});

	it("onEvent 绝不抛错(fetch 同步异常也兜住)", async () => {
		vi.stubGlobal("fetch", () => {
			throw new Error("sync boom");
		});
		const sink = httpSink({ url: URL, batchSize: 1, flushIntervalMs: 0 });
		expect(() => sink.onEvent(spanEvent(1))).not.toThrow();
		await expect(sink.flush?.()).resolves.toBeUndefined();
	});
});

describe("httpSink · flush 与开关语义", () => {
	it("flush 等待在途请求收尾,再把剩余缓冲发完", async () => {
		// 慢 fetch:手动控制 resolve 时机,模拟在途请求未结束
		let releaseFetch: (() => void) | undefined;
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					releaseFetch = () => resolve(new Response(""));
				}),
		);
		fetchMock.mockResolvedValue(new Response(""));
		const sink = httpSink({ url: URL, batchSize: 1, flushIntervalMs: 60_000 });
		const e2 = spanEvent(2);
		sink.onEvent(spanEvent(1)); // batchSize=1 → 立即起飞,fetch 挂起成为在途
		sink.onEvent(e2); // 在途期间继续入缓冲
		let flushSettled = false;
		const flushPromise = sink.flush?.().then(() => {
			flushSettled = true;
		});
		await settle();
		// 在途请求未结束 → flush 必须还在等,且第二批不得抢跑
		expect(flushSettled).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		releaseFetch?.();
		await flushPromise;
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(callInit(1)?.body).toBe(`${JSON.stringify(e2)}\n`);
	});

	it("flush 把剩余缓冲一次发完并清空(再次 flush 不重发)", async () => {
		fetchMock.mockResolvedValue(new Response(""));
		const sink = httpSink({ url: URL, batchSize: 100, flushIntervalMs: 60_000 });
		sink.onEvent(spanEvent(1));
		sink.onEvent(spanEvent(2));
		await sink.flush?.();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await sink.flush?.();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("非 critical(受 FLOWER_TELEMETRY=0 总开关控制的前提)", () => {
		expect(httpSink({ url: URL }).critical).toBeUndefined();
	});
});
