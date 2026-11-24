import assert from "node:assert/strict";
import test from "node:test";
import { createAttention } from "../workbench/attention.mjs";

test("终态按类别标记未读，取消与拒绝不提醒，前台查看时不标记", () => {
	const attention = createAttention();
	assert.equal(attention.terminal("a", "succeeded", false), "done");
	assert.equal(attention.terminal("b", "failed", false), "failed");
	assert.equal(attention.terminal("c", "interrupted", false), "failed");
	assert.equal(attention.terminal("d", "cancelled", false), undefined);
	assert.equal(attention.terminal("e", "denied", false), undefined);
	assert.equal(attention.terminal("f", "succeeded", true), "done");
	assert.deepEqual(
		["a", "b", "c", "d", "e", "f"].map((id) => attention.indicator(id, false, false)),
		["done", "failed", "failed", undefined, undefined, undefined],
	);
});

test("状态优先级为待批准、运行中、未读，查看后清除未读", () => {
	const attention = createAttention();
	attention.terminal("a", "failed", false);
	assert.equal(attention.indicator("a", true, true), "approval");
	assert.equal(attention.indicator("a", false, true), "running");
	assert.equal(attention.indicator("a", false, false), "failed");
	assert.equal(attention.clear("a"), true);
	assert.equal(attention.clear("a"), false);
	assert.equal(attention.indicator("a", false, false), undefined);
});
