import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

function stack(limit) {
	const window = {};
	runInNewContext(readFileSync(new URL("../workbench/ui/toast.js", import.meta.url), "utf8"), { window });
	return window.flowerToast.toastStack(limit);
}

test("Toast 最多保留三条，超出时先移除最早的非错误提示", () => {
	const toasts = stack();
	toasts.push({ text: "一", tone: "error" });
	toasts.push({ text: "二", tone: "neutral" });
	toasts.push({ text: "三", tone: "neutral" });
	const { evicted } = toasts.push({ text: "四", tone: "neutral" });
	assert.deepEqual(
		Array.from(evicted, ({ text }) => text),
		["二"],
	);
	assert.deepEqual(
		Array.from(toasts.items, ({ text }) => text),
		["一", "三", "四"],
	);
	// 全是错误时移除最早的一条。
	const errors = stack();
	for (const text of ["甲", "乙", "丙", "丁"]) errors.push({ text, tone: "error" });
	assert.deepEqual(
		Array.from(errors.items, ({ text }) => text),
		["乙", "丙", "丁"],
	);
});

test("Toast 相同文案与色调去重，带操作的提示各自独立", () => {
	const toasts = stack();
	const first = toasts.push({ text: "已复制回复原文。", tone: "neutral" });
	const again = toasts.push({ text: "已复制回复原文。", tone: "neutral" });
	assert.equal(again.added, false);
	assert.equal(again.item, first.item);
	assert.equal(toasts.push({ text: "已复制回复原文。", tone: "error" }).added, true);
	const undo = { label: "撤销", run() {} };
	assert.equal(toasts.push({ text: "已删除会话", tone: "neutral", action: undo }).added, true);
	assert.equal(toasts.push({ text: "已删除会话", tone: "neutral", action: undo }).added, true);
	assert.equal(toasts.items.length, 3);
	assert.equal(toasts.remove(toasts.items[0]), true);
	assert.equal(toasts.remove({}), false);
});
