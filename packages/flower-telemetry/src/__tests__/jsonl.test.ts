/**
 * `sinks/jsonl.ts` 单元测试:行写 / stream 过滤 / 坏路径降级
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonlSink } from "../sinks/jsonl.js";
import type { TelemetryEvent } from "../types.js";

const BASE = { traceId: "t-1", product: "test", seq: 1, ts: 1700000000000 };

let dir: string;

beforeEach(() => {
	vi.unstubAllEnvs();
	dir = mkdtempSync(join(tmpdir(), "flower-telemetry-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("jsonlSink", () => {
	it("事件按行追加,每行可 parse,父目录自动创建", () => {
		const path = join(dir, "nested", "trace.jsonl");
		const sink = jsonlSink(path);
		sink.onEvent({
			...BASE,
			kind: "trace_start",
			correlation: { project: "g/r", mrIid: "1", commitSha: "a", pipelineId: "9" },
			reason: "startup",
		});
		sink.onEvent({ ...BASE, seq: 2, kind: "span", spanType: "tool_call", tool: "bash", inputKeys: ["command"] });
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect((JSON.parse(lines[0] ?? "") as Record<string, unknown>).kind).toBe("trace_start");
		expect((JSON.parse(lines[1] ?? "") as Record<string, unknown>).seq).toBe(2);
	});

	it("stream 事件不落盘", () => {
		const path = join(dir, "trace.jsonl");
		const sink = jsonlSink(path);
		sink.onEvent({ ...BASE, kind: "stream", streamType: "text_delta", delta: "x" } as TelemetryEvent);
		sink.onEvent({ ...BASE, kind: "span", spanType: "turn" });
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect((JSON.parse(lines[0] ?? "") as Record<string, unknown>).kind).toBe("span");
	});

	it("路径不可写 → 不抛错,默认静默,后续事件停写;DEBUG_TELEMETRY=1 时 warn 一次", () => {
		const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
		// 把"文件"指向一个已存在目录,appendFileSync 必然 EISDIR
		const sink = jsonlSink(dir);
		expect(() => sink.onEvent({ ...BASE, kind: "span", spanType: "turn" })).not.toThrow();
		expect(warnMock).not.toHaveBeenCalled();

		vi.stubEnv("DEBUG_TELEMETRY", "1");
		const sink2 = jsonlSink(dir);
		sink2.onEvent({ ...BASE, kind: "span", spanType: "turn" });
		expect(warnMock).toHaveBeenCalledTimes(1);
		// broken 后停写:再次 emit 不再 warn(没有重复 IO 尝试)
		sink2.onEvent({ ...BASE, seq: 2, kind: "span", spanType: "turn" });
		expect(warnMock).toHaveBeenCalledTimes(1);
		warnMock.mockRestore();
	});
});
