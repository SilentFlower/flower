/**
 * `telemetry-setup.ts` 单元测试:sink 装配的环境开关
 *
 * 关键约束:
 * - `FLOWER_VERBOSE` 语义与原 observability.ts 完全一致(默认开;0/false/off/no/空串 显式关)
 * - console 关掉时 jsonl / siem 仍在(打印与数据采集是两条独立通道)
 * - httpSink 仅在 `FLOWER_TELEMETRY_URL` 配置(非空)时挂载(实时推送是 opt-in 通道)
 * - siemSink 永远挂载(critical,未配 URL 时内部 no-op)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelemetrySinks, isVerboseOff } from "../telemetry-setup.js";

beforeEach(() => {
	vi.unstubAllEnvs();
});

describe("isVerboseOff · FLOWER_VERBOSE 语义(与原 observability.ts 一致)", () => {
	it("未设置 → 开(false)", () => {
		expect(isVerboseOff()).toBe(false);
	});

	it.each(["0", "false", "off", "no", "", "FALSE", "Off"])("显式 %j → 关(true)", (value) => {
		vi.stubEnv("FLOWER_VERBOSE", value);
		expect(isVerboseOff()).toBe(true);
	});

	it("其他取值(1 / true)→ 开", () => {
		vi.stubEnv("FLOWER_VERBOSE", "1");
		expect(isVerboseOff()).toBe(false);
	});
});

describe("buildTelemetrySinks · 装配规则", () => {
	it("默认:console + jsonl + siem 三个 sink(未配 FLOWER_TELEMETRY_URL 时无 http)", () => {
		const names = buildTelemetrySinks().map((s) => s.name);
		expect(names).toEqual(["console", "jsonl", "siem"]);
	});

	it("FLOWER_VERBOSE=0 → 去掉 console,jsonl / siem 保留", () => {
		vi.stubEnv("FLOWER_VERBOSE", "0");
		const names = buildTelemetrySinks().map((s) => s.name);
		expect(names).toEqual(["jsonl", "siem"]);
	});

	it("FLOWER_TELEMETRY_URL 配置 → 挂载 httpSink(位于 jsonl 与 siem 之间)", () => {
		vi.stubEnv("FLOWER_TELEMETRY_URL", "http://observer.example/v1/events");
		const names = buildTelemetrySinks().map((s) => s.name);
		expect(names).toEqual(["console", "jsonl", "http", "siem"]);
	});

	it("FLOWER_TELEMETRY_URL 为空串 → 不挂载 httpSink", () => {
		vi.stubEnv("FLOWER_TELEMETRY_URL", "");
		const names = buildTelemetrySinks().map((s) => s.name);
		expect(names).toEqual(["console", "jsonl", "siem"]);
	});

	it("httpSink 非 critical(受 FLOWER_TELEMETRY=0 总开关控制)", () => {
		vi.stubEnv("FLOWER_TELEMETRY_URL", "http://observer.example/v1/events");
		const http = buildTelemetrySinks().find((s) => s.name === "http");
		expect(http?.critical).toBeUndefined();
	});

	it("siem sink 始终是 critical(FLOWER_TELEMETRY=0 也不能关审计)", () => {
		const siem = buildTelemetrySinks().find((s) => s.name === "siem");
		expect(siem?.critical).toBe(true);
	});
});
