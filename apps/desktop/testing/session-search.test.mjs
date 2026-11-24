import assert from "node:assert/strict";
import test from "node:test";
import { interruptedTurns, searchableTurns, searchSnippets } from "../workbench/session-search.mjs";

test("可搜索轮次取桌面原话与回复正文，不含工具结果", () => {
	const turns = searchableTurns({
		requests: [
			{
				requestId: "a",
				input: "trim 后的输入",
				text: "回复甲",
				status: "succeeded",
				toolResults: [{ text: ["工具结果"] }],
			},
			{ requestId: "b", input: "旧记录", status: "interrupted" },
		],
		desktopMessages: { a: { input: "  原话\n第二行" } },
	});
	assert.deepEqual(turns, [
		{ requestId: "a", input: "  原话\n第二行", text: "回复甲", status: "succeeded" },
		{ requestId: "b", input: "旧记录", text: "", status: "interrupted" },
	]);
	assert.deepEqual(searchableTurns(undefined), []);
});

test("命中片段不区分大小写，前后各约 30 字，空白折叠，超长时加省略号，最多 3 条", () => {
	const long = `${"前".repeat(40)}\n\nBudget 报价${"后".repeat(40)}`;
	const [hit] = searchSnippets([{ requestId: "a", input: "", text: long, status: "succeeded" }], "budget");
	assert.deepEqual(hit, {
		requestId: "a",
		field: "text",
		before: `…${"前".repeat(28)} `,
		match: "Budget",
		after: ` 报价${"后".repeat(27)}…`,
	});
	const turns = Array.from({ length: 5 }, (_, index) => ({
		requestId: String(index),
		input: "核对预算",
		text: "预算无误",
		status: "succeeded",
	}));
	assert.deepEqual(
		searchSnippets(turns, "预算").map(({ requestId, field }) => [requestId, field]),
		[
			["0", "input"],
			["0", "text"],
			["1", "input"],
		],
	);
	assert.deepEqual(searchSnippets(turns, "没有的词"), []);
});

test("最后一条请求为中断，或记录文件仍停在排队、运行中时视为上次被中断", () => {
	const turn = (status) => ({ requestId: status, input: "", text: "", status });
	for (const status of ["interrupted", "queued", "running", "cancelling"])
		assert.equal(interruptedTurns([turn("succeeded"), turn(status)]), true);
	assert.equal(interruptedTurns([turn("interrupted"), turn("succeeded")]), false);
	assert.equal(interruptedTurns([]), false);
});
