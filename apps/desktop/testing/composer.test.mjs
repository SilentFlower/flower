import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// 组件只在使用时调用 DOM 工具，加载时提供同名替身即可测试纯逻辑。
function load(file) {
	const window = { flowerUI: { element() {}, icon() {}, button() {}, mark() {} } };
	runInNewContext(readFileSync(new URL(`../workbench/ui/${file}`, import.meta.url), "utf8"), { window });
	return window;
}

test("空输入框按方向键召回历史输入，越过最新或 Esc 恢复草稿，修改后退出召回", () => {
	const recall = load("agent.js").agentUI.inputRecall();
	const entries = ["第一问", "第二问", "第三问"];
	assert.equal(recall.key("ArrowUp", "已有草稿", entries), undefined);
	assert.equal(recall.key("ArrowDown", "", entries), undefined);
	assert.equal(recall.key("ArrowUp", "", []), undefined);
	assert.equal(recall.key("ArrowUp", "", entries), "第三问");
	assert.equal(recall.key("ArrowUp", "第三问", entries), "第二问");
	assert.equal(recall.key("ArrowUp", "第二问", entries), "第一问");
	assert.equal(recall.key("ArrowUp", "第一问", entries), "第一问");
	assert.equal(recall.key("ArrowDown", "第一问", entries), "第二问");
	assert.equal(recall.key("ArrowDown", "第二问", entries), "第三问");
	assert.equal(recall.key("ArrowDown", "第三问", entries), "");
	assert.equal(recall.key("ArrowDown", "", entries), undefined);
	assert.equal(recall.key("ArrowUp", "", entries), "第三问");
	assert.equal(recall.key("Escape", "第三问", entries), "");
	assert.equal(recall.key("Escape", "", entries), undefined);
	assert.equal(recall.key("ArrowUp", "", entries), "第三问");
	// 用户改动召回内容后，方向键交还给光标移动。
	assert.equal(recall.key("ArrowUp", "第三问，补充", entries), undefined);
	assert.equal(recall.key("Escape", "第三问，补充", entries), undefined);
});

test("长粘贴按字数、行数与输入框上限转为附件", () => {
	const { longPaste } = load("attachments.js").flowerAttachments;
	const field = (value = "", start = value.length, end = start) => ({
		value,
		selectionStart: start,
		selectionEnd: end,
		maxLength: 16000,
	});
	assert.equal(longPaste("字".repeat(2000), field()), false);
	assert.equal(longPaste("字".repeat(2001), field()), true);
	assert.equal(longPaste(Array(20).fill("行").join("\n"), field()), false);
	assert.equal(longPaste(Array(21).fill("行").join("\r\n"), field()), true);
	assert.equal(longPaste("字".repeat(1000), field("草".repeat(15000))), false);
	assert.equal(longPaste("字".repeat(1000), field("草".repeat(15001))), true);
	// 替换选区后不超限时仍直接粘贴。
	assert.equal(longPaste("字".repeat(1000), field("草".repeat(15001), 0, 1000)), false);
	assert.equal(longPaste("", field()), false);
});

test("引用选中文字：逐行加引用符，前后留空行，光标停在引用之后，超出上限不插入", () => {
	const { quoteInsertion } = load("agent.js").agentUI;
	assert.deepEqual(
		{ ...quoteInsertion("", 0, 0, "  报价 537\r\n\r\n预算 500  ", 16000) },
		{
			value: "> 报价 537\n>\n> 预算 500\n\n",
			caret: "> 报价 537\n>\n> 预算 500\n\n".length,
		},
	);
	// 已有文字时与前文隔一空行，替换选中的部分。
	const result = quoteInsertion("请核对：旧文字", 4, 7, "差额 37", 16000);
	assert.equal(result.value, "请核对：\n\n> 差额 37\n\n");
	assert.equal(quoteInsertion("第一段\n", 4, 4, "引用", 16000).value, "第一段\n\n> 引用\n\n");
	assert.equal(quoteInsertion("草".repeat(15995), 15995, 15995, "超出上限", 16000), undefined);
});

test("@ 查询只在行首或空白之后识别，查询中不含空白与 @", () => {
	const { mentionQuery } = load("agent.js").agentUI;
	const at = (value, caret = value.length) => {
		const found = mentionQuery(value, caret);
		return found && { ...found };
	};
	assert.deepEqual(at("@"), { start: 0, query: "" });
	assert.deepEqual(at("请看 @预算"), { start: 3, query: "预算" });
	assert.deepEqual(at("第一行\n@报价.pdf"), { start: 4, query: "报价.pdf" });
	assert.equal(at("邮箱 a@b.com"), undefined);
	assert.equal(at("@预算 表"), undefined);
	assert.deepEqual(at("@预算 表", 3), { start: 0, query: "预算" });
	assert.equal(at("@@"), undefined);
});
