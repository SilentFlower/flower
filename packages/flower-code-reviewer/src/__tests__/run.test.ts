/**
 * `run.ts` 单元测试:scanForBlockers 纯函数
 *
 * runReview 整函数依赖 piMain + gitlabClient + 文件系统,涉及多个 mock 边界,
 * 单测成本不划算,**整体行为靠 e2e 阶段(Step 7-8)真实跑 MR 验**。
 *
 * 这里只单测可抽出的纯函数 scanForBlockers,覆盖 implement.md Step 3.3 列出的核心 case。
 */

import type { BotComment } from "@flower-ai/flower-tools-gitlab";
import { describe, expect, it } from "vitest";
import { scanForBlockers } from "../run.js";

function makeComment(id: number, body: string): BotComment {
	return { id, body, file: undefined, line: undefined };
}

describe("scanForBlockers", () => {
	it("跑前 0 条,跑后新增 1 条 [severity:blocker] → true(应 exitCode=1)", () => {
		const beforeIds = new Set<number>();
		const after = [makeComment(101, "[severity:blocker] SQL 拼接")];
		expect(scanForBlockers(beforeIds, after)).toBe(true);
	});

	it("跑前已有 1 条 blocker,跑后还是同一条 → false(snapshot 生效,不重复 fail)", () => {
		const beforeIds = new Set<number>([42]);
		const after = [makeComment(42, "[severity:blocker] 上一轮就有的问题")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});

	it("跑前 1 条 blocker + 跑后新增 1 条 blocker → true(只看新增)", () => {
		const beforeIds = new Set<number>([42]);
		const after = [makeComment(42, "[severity:blocker] 旧问题"), makeComment(99, "[severity:blocker] 新问题")];
		expect(scanForBlockers(beforeIds, after)).toBe(true);
	});

	it("跑后只有 info / warning,无 blocker → false(应 exitCode=0)", () => {
		const beforeIds = new Set<number>();
		const after = [makeComment(1, "[severity:info] 建议"), makeComment(2, "[severity:warning] 注意")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});

	it("跑后无任何新评论 → false", () => {
		const beforeIds = new Set<number>([1, 2, 3]);
		const after = [makeComment(1, "x"), makeComment(2, "y")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});

	it("severity 前缀大小写敏感:'[Severity:Blocker]' 不命中(必须严格匹配 lowercase)", () => {
		const beforeIds = new Set<number>();
		const after = [makeComment(1, "[Severity:Blocker] 大写")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});

	it("blocker 前缀必须在开头,不能在中间", () => {
		const beforeIds = new Set<number>();
		const after = [makeComment(1, "上下文 [severity:blocker] 在中间")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});
});
