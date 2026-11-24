import assert from "node:assert/strict";
import test from "node:test";
import { contextMenuItems, replyMenuItems } from "../workbench/context-menu.mjs";

test("输入框右键按可用状态给出编辑操作", () => {
	const items = contextMenuItems(
		{ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } },
		{},
	);
	assert.deepEqual(
		items.map(({ label, role, enabled, type }) => type ?? `${label}:${role}:${enabled}`),
		["剪切:cut:false", "复制:copy:false", "粘贴:paste:true", "separator", "全选:selectAll:true"],
	);
});

test("选中文字可复制，图片可复制，空白处不弹出菜单", () => {
	const copied = [];
	const contents = { copyImageAt: (x, y) => copied.push([x, y]) };
	assert.deepEqual(contextMenuItems({ isEditable: false, selectionText: "  " }, contents), []);
	assert.deepEqual(
		contextMenuItems({ isEditable: false, selectionText: "差额 37" }, contents).map(({ label }) => label),
		["复制"],
	);
	const image = contextMenuItems(
		{ isEditable: false, selectionText: "", mediaType: "image", hasImageContents: true, x: 3, y: 4 },
		contents,
	);
	assert.deepEqual(
		image.map(({ label }) => label),
		["复制图片"],
	);
	image[0].click();
	assert.deepEqual(copied, [[3, 4]]);
});

test("回复选区菜单提供复制、引用与侧边追问，选择交给回调", () => {
	const chosen = [];
	const items = replyMenuItems((choice) => chosen.push(choice));
	assert.deepEqual(
		items.map(({ label, role, type }) => type ?? `${label}:${role ?? ""}`),
		["复制:copy", "separator", "引用:", "侧边追问:"],
	);
	items[2].click();
	items[3].click();
	assert.deepEqual(chosen, ["quote", "side"]);
});
