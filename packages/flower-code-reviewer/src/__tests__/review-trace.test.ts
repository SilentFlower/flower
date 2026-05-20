/**
 * `review-trace.ts` 单元测试
 *
 * 覆盖 module-level 单例的 record / get / reset 行为。
 * `findUnsupportedComments` 已在 `run.test.ts` 内单测,这里不重复。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getTrace, recordFileRead, recordLineComment, resetTrace } from "../review-trace.js";

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

	it("recordLineComment 累计 lineComments(允许重复 file)", () => {
		recordLineComment("src/a.go", 10);
		recordLineComment("src/a.go", 20);
		recordLineComment("src/b.go", 5);

		const trace = getTrace();
		expect(trace.lineComments).toEqual([
			{ file: "src/a.go", line: 10 },
			{ file: "src/a.go", line: 20 },
			{ file: "src/b.go", line: 5 },
		]);
	});

	it("resetTrace 清空所有累计", () => {
		recordFileRead("src/a.go");
		recordLineComment("src/a.go", 1);
		resetTrace();

		const trace = getTrace();
		expect(trace.readFiles.size).toBe(0);
		expect(trace.lineComments).toEqual([]);
	});
});
