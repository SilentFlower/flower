/**
 * normalizeRef 纯函数单测
 *
 * 验证 `gitlab_get_file_content` 工具层对 LLM 传入 ref 的归一化逻辑:
 * - 兜底 `undefined` / `""` / `"HEAD"` 到 `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`
 * - 透传真实 ref(branch / tag / sha)
 * - 无 CI env 时抛中文 Error 指引显式传 ref
 *
 * 对应 PRD R1.2 + AC1.1-AC1.5。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeRef } from "../index.js";

describe("normalizeRef · ref 弹性化兜底", () => {
	const SOURCE_BRANCH = "try/code-review-onboarding";
	const ORIGINAL_ENV = process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;

	beforeEach(() => {
		process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = SOURCE_BRANCH;
		// 抑制 console.warn 输出,避免污染测试日志(兜底警告本身在另一个 case 中专门断言)
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		if (ORIGINAL_ENV === undefined) {
			delete process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
		} else {
			process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = ORIGINAL_ENV;
		}
		vi.restoreAllMocks();
	});

	it("AC1.1 · ref='HEAD' + CI env 存在 → 兜底到 source branch", () => {
		expect(normalizeRef("HEAD")).toBe(SOURCE_BRANCH);
	});

	it("AC1.2 · ref='' + CI env 存在 → 兜底到 source branch", () => {
		expect(normalizeRef("")).toBe(SOURCE_BRANCH);
	});

	it("AC1.3 · ref=undefined + CI env 存在 → 兜底到 source branch", () => {
		expect(normalizeRef(undefined)).toBe(SOURCE_BRANCH);
	});

	it("AC1.4 · ref='prod' + CI env 存在 → 透传 'prod'(显式 ref 优先,不被覆盖)", () => {
		expect(normalizeRef("prod")).toBe("prod");
	});

	it("AC1.4b · ref 真实 branch 含 / → 透传(不会被空白 trim 误伤)", () => {
		expect(normalizeRef("feature/auth-rework")).toBe("feature/auth-rework");
	});

	it("AC1.5 · ref='HEAD' + CI env 不存在 → 抛中文 Error 指引显式传 ref", () => {
		delete process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
		expect(() => normalizeRef("HEAD")).toThrow(/ref 缺失|CI_MERGE_REQUEST_SOURCE_BRANCH_NAME 未设置/);
	});

	it("AC1.5b · ref=undefined + CI env 不存在 → 同样抛中文 Error", () => {
		delete process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
		expect(() => normalizeRef(undefined)).toThrow(/请显式传 ref/);
	});

	it("AC1.5c · ref='HEAD' + CI env 是空字符串(异常值)→ 同样抛错(空字符串不能当兜底)", () => {
		process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = "   ";
		expect(() => normalizeRef("HEAD")).toThrow(/请显式传 ref/);
	});

	it("兜底时 console.warn 打提示(便于 trace 读者理解)", () => {
		const warnSpy = vi.spyOn(console, "warn");
		normalizeRef("HEAD");
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("自动兜底到 source branch"));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(SOURCE_BRANCH));
	});

	it("ref 含前后空格 → trim 后透传(不当作空字符串兜底)", () => {
		expect(normalizeRef("  main  ")).toBe("main");
	});
});
