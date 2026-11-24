import assert from "node:assert/strict";
import test from "node:test";
import { describeToolCall, shortPath } from "../workbench/tool-display.mjs";

const asset = `attachment:${"a".repeat(64)}`;
const names = (id) => (id === `asset:${"a".repeat(64)}` ? "预算.xlsx" : undefined);

test("工具目标取路径参数，附件编号显示为附件名", () => {
	assert.equal(describeToolCall("read_text_file", { path: "资料\\说明.txt" }, names), "资料/说明.txt");
	assert.equal(describeToolCall("inspect_excel", { path: asset }, names), "预算.xlsx");
	assert.equal(describeToolCall("inspect_excel", { path: `attachment:${"b".repeat(64)}` }, names), "对话附件");
	assert.equal(describeToolCall("analyze_excel", { path: "orders.xlsx", sheet: " 明细 " }, names), "orders.xlsx · 明细");
	assert.equal(describeToolCall("list_workspace", { directory: "." }, names), "工作区");
	assert.equal(describeToolCall("list_workspace", { directory: "报表/2026" }, names), "报表/2026");
	assert.equal(
		describeToolCall("write_report", { markdown: "很长的正文".repeat(1000), input: asset }, names),
		"预算.xlsx",
	);
	assert.equal(describeToolCall("write_report", { markdown: "正文" }, names), undefined);
	assert.equal(describeToolCall("unknown_tool", { path: "" }, names), undefined);
	assert.equal(describeToolCall("read_text_file", null, names), undefined);
});

test("长路径保留末尾文件名", () => {
	const path = `${"目录/".repeat(60)}结果.md`;
	const short = shortPath(path);
	assert.equal(Array.from(short).length, 120);
	assert.ok(short.startsWith("…"));
	assert.ok(short.endsWith("/结果.md"));
	assert.equal(shortPath("a/b.md"), "a/b.md");
});
