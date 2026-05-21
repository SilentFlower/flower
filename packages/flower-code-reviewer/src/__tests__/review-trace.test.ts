/**
 * `review-trace.ts` 单元测试
 *
 * 覆盖 module-level 单例的 record / get / reset 行为,以及 `extractBlockerTitle` 纯函数。
 * `findUnsupportedComments` 已在 `run.test.ts` 内单测,这里不重复。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { extractBlockerTitle, getTrace, recordFileRead, recordLineComment, resetTrace } from "../review-trace.js";

describe("review-trace · 单例行为", () => {
	beforeEach(() => {
		resetTrace();
	});

	it("recordFileRead 累计 readFiles(去重)", () => {
		recordFileRead("src/a.go");
		recordFileRead("src/b.go");
		recordFileRead("src/a.go"); // 重复

		const trace = getTrace();
		expect([...trace.readFiles].sort()).toEqual(["src/a.go", "src/b.go"]);
	});

	it("AC2.1 · recordLineComment 对象签名记录完整字段(blocker)", () => {
		recordLineComment({
			file: "src/a.go",
			line: 10,
			severity: "blocker",
			body: "🔴 **阻塞** · 硬编码 secret\n\n详情...",
		});

		const trace = getTrace();
		expect(trace.lineComments).toEqual([
			{
				file: "src/a.go",
				line: 10,
				severity: "blocker",
				title: "硬编码 secret",
			},
		]);
	});

	it("AC2.2 · recordLineComment 支持 major / minor 级别", () => {
		recordLineComment({
			file: "src/a.go",
			line: 10,
			severity: "major",
			body: "🟠 **重要** · 性能问题",
		});
		recordLineComment({
			file: "src/b.go",
			line: 5,
			severity: "minor",
			body: "🔵 **建议** · 命名优化",
		});

		const trace = getTrace();
		expect(trace.lineComments).toEqual([
			{ file: "src/a.go", line: 10, severity: "major", title: "性能问题" },
			{ file: "src/b.go", line: 5, severity: "minor", title: "命名优化" },
		]);
	});

	it("recordLineComment 允许重复 file(不同 line)", () => {
		recordLineComment({ file: "src/a.go", line: 10, severity: "blocker", body: "🔴 **阻塞** · A" });
		recordLineComment({ file: "src/a.go", line: 20, severity: "major", body: "🟠 **重要** · B" });

		const trace = getTrace();
		expect(trace.lineComments).toHaveLength(2);
		expect(trace.lineComments[0]?.file).toBe("src/a.go");
		expect(trace.lineComments[1]?.file).toBe("src/a.go");
	});

	it("resetTrace 清空所有累计", () => {
		recordFileRead("src/a.go");
		recordLineComment({ file: "src/a.go", line: 1, severity: "blocker", body: "🔴 **阻塞** · X" });
		resetTrace();

		const trace = getTrace();
		expect(trace.readFiles.size).toBe(0);
		expect(trace.lineComments).toEqual([]);
	});
});

describe("extractBlockerTitle · title 抽取规则", () => {
	it("阻塞 · 标题(`·` 分隔)→ 抽取标题", () => {
		expect(extractBlockerTitle("🔴 **阻塞** · 硬编码 secret\n\n详情...")).toBe("硬编码 secret");
	});

	it("重要 · 标题(无 `·`,空格分隔)→ 抽取标题", () => {
		expect(extractBlockerTitle("🟠 **重要** 性能问题")).toBe("性能问题");
	});

	it("建议 · 标题(`·` 分隔 + 多行)→ 仅抽第一行", () => {
		expect(extractBlockerTitle("🔵 **建议** · 命名优化\n\n详细说明...")).toBe("命名优化");
	});

	it("HTML 注释 marker 前缀 → 剥离后抽标题", () => {
		expect(extractBlockerTitle("<!-- severity: blocker -->\n🔴 **阻塞** · X")).toBe("X");
	});

	it("空 body → fallback `(无标题)`", () => {
		expect(extractBlockerTitle("")).toBe("(无标题)");
	});

	it("无 emoji 前缀的 body → 不去除,原样返回", () => {
		// 防御 LLM 完全不按模板写的兜底:整行作为 title
		expect(extractBlockerTitle("纯文本无前缀")).toBe("纯文本无前缀");
	});
});
