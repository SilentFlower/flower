import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSessionQueue, storedQueue } from "../workbench/session-queue.mjs";

/** 用内存记录与可控的运行状态驱动队列，按提交顺序记录发送内容。 */
function harness() {
	const id = randomUUID();
	const record = { id };
	const sent = [];
	const steered = [];
	const notices = [];
	let tail = Promise.resolve();
	const state = { busy: false, run: undefined, failSubmit: undefined, persisted: 0 };
	const queue = createSessionQueue({
		find: (key) => (key === id ? record : undefined),
		list: () => [record],
		persist: async () => {
			state.persisted++;
		},
		submit: async (_key, item) => {
			if (state.failSubmit) throw new Error(state.failSubmit);
			sent.push(item.input);
			state.busy = true;
			return { requestId: randomUUID(), input: item.input };
		},
		steer: async (_key, runId, item) => {
			steered.push([runId, item.input]);
		},
		running: () => state.run,
		busy: () => state.busy,
		notify: (_key, text) => notices.push(text),
		serialize(action) {
			const next = tail.then(action);
			tail = next.catch(() => {});
			return next;
		},
	});
	return {
		id,
		record,
		queue,
		sent,
		steered,
		notices,
		state,
		settle: () => tail,
		inputs: () => storedQueue(record).map(({ input }) => input),
		/** 当前运行结束，Main 已移除活动请求后交给队列。 */
		async finish(runId = state.run?.runId) {
			state.busy = false;
			state.run = undefined;
			queue.receive({ type: "terminal", sessionId: id, runId, status: "succeeded" });
			await tail;
			await tail;
		},
	};
}

test("空闲时直接提交，忙时排队，当前任务结束后按顺序逐条发送", async () => {
	const h = harness();
	const direct = await h.queue.accept(h.record, "第一问");
	assert.equal(direct.input, "第一问");
	assert.deepEqual(h.sent, ["第一问"]);
	assert.ok((await h.queue.accept(h.record, "第二问")).queued);
	await h.queue.accept(h.record, "第三问", [{ id: "file:a.md", name: "a.md" }]);
	assert.deepEqual(h.inputs(), ["第二问", "第三问"]);
	assert.deepEqual(h.queue.view(h.id).items[1].attachments, [{ id: "file:a.md", name: "a.md" }]);
	await h.finish("run-1");
	assert.deepEqual(h.sent, ["第一问", "第二问"]);
	assert.deepEqual(h.inputs(), ["第三问"]);
	await h.finish("run-2");
	assert.deepEqual(h.sent, ["第一问", "第二问", "第三问"]);
	assert.equal(h.record.queue, undefined);
	await assert.rejects(h.queue.accept(h.record, "  "), /有效任务说明/);
});

test("停止后暂停，点继续或再次发送时恢复，新消息排在队尾", async () => {
	const h = harness();
	h.state.busy = true;
	await h.queue.accept(h.record, "甲");
	await h.queue.accept(h.record, "乙");
	h.queue.pause(h.id);
	await h.finish("run-1");
	assert.deepEqual(h.sent, []);
	assert.equal(h.queue.view(h.id).paused, true);
	await h.queue.resume(h.id);
	await h.settle();
	assert.deepEqual(h.sent, ["甲"]);
	h.queue.pause(h.id);
	await h.finish("run-2");
	assert.deepEqual(h.sent, ["甲"]);
	// 暂停且空闲时再次发送：恢复队列，先发送更早的队首。
	await h.queue.accept(h.record, "丙");
	await h.settle();
	assert.deepEqual(h.sent, ["甲", "乙"]);
	assert.deepEqual(h.inputs(), ["丙"]);
	assert.equal(h.queue.view(h.id).paused, false);
});

test("队首发送失败时保留并暂停，提示原因", async () => {
	const h = harness();
	h.state.busy = true;
	await h.queue.accept(h.record, "甲");
	h.state.failSubmit = "请先配置模型。";
	await h.finish("run-1");
	assert.deepEqual(h.inputs(), ["甲"]);
	assert.equal(h.queue.view(h.id).paused, true);
	assert.deepEqual(h.notices, ["排队消息未能发送：请先配置模型。"]);
});

test("行内编辑保持位置，只保留指定附件；重排要求同一组消息；上限 20 条", async () => {
	const h = harness();
	h.state.busy = true;
	const refs = [
		{ id: "asset:1", name: "一.png" },
		{ id: "file:b.md", name: "b.md" },
	];
	await h.queue.accept(h.record, "甲", refs);
	await h.queue.accept(h.record, "乙");
	const [first, second] = h.queue.view(h.id).items;
	const removed = await h.queue.edit(h.id, first.id, "甲（改）", ["file:b.md"]);
	assert.deepEqual(removed, [refs[0]]);
	assert.deepEqual(h.inputs(), ["甲（改）", "乙"]);
	assert.deepEqual(h.queue.view(h.id).items[0].attachments, [refs[1]]);
	await assert.rejects(h.queue.edit(h.id, randomUUID(), "丙", []), /已发送或已删除/);
	await assert.rejects(h.queue.reorder(h.id, [first.id]), /队列已变化/);
	await assert.rejects(h.queue.reorder(h.id, [first.id, first.id]), /队列已变化/);
	await h.queue.reorder(h.id, [second.id, first.id]);
	assert.deepEqual(h.inputs(), ["乙", "甲（改）"]);
	assert.equal((await h.queue.take(h.id, second.id)).input, "乙");
	assert.deepEqual(h.inputs(), ["甲（改）"]);
	for (let index = 1; index < 20; index++) await h.queue.accept(h.record, `第 ${index} 条`);
	await assert.rejects(h.queue.accept(h.record, "第 21 条"), /最多 20 条/);
});

test("插话送达后移出队列并附上原文；运行在送达前结束时回到队首并暂停", async () => {
	const h = harness();
	h.state.busy = true;
	await h.queue.accept(h.record, "甲");
	await h.queue.accept(h.record, "乙");
	const [first, second] = h.queue.view(h.id).items;
	await assert.rejects(h.queue.steer(h.id, first.id), /没有运行中的任务/);
	h.state.run = { runId: "run-1" };
	assert.equal(h.queue.view(h.id).steerable, true);
	await h.queue.steer(h.id, second.id);
	assert.deepEqual(h.steered, [["run-1", "乙"]]);
	assert.equal(h.queue.view(h.id).items[1].steering, true);
	await assert.rejects(h.queue.edit(h.id, second.id, "改", []), /正在插话/);
	assert.deepEqual(h.queue.receive({ type: "steered", sessionId: h.id, steerId: second.id }), {
		input: "乙",
		attachments: [],
	});
	await h.settle();
	assert.deepEqual(h.inputs(), ["甲"]);

	await h.queue.steer(h.id, first.id);
	await h.finish("run-1");
	assert.deepEqual(h.inputs(), ["甲"]);
	assert.equal(h.queue.view(h.id).paused, true);
	assert.equal(h.queue.view(h.id).items[0].steering, false);
	assert.deepEqual(h.notices, ["插话未能送达，已放回队首并暂停队列。"]);
	assert.deepEqual(h.sent, []);
});

test("工作进程退出时暂停所有队列", async () => {
	const h = harness();
	h.state.busy = true;
	await h.queue.accept(h.record, "甲");
	h.queue.pauseAll();
	assert.equal(h.record.queuePaused, true);
});

test("编辑中的队首在任务结束时暂缓发送，保存或放弃编辑后补发", async () => {
	const h = harness();
	h.state.busy = true;
	await h.queue.accept(h.record, "甲");
	await h.queue.accept(h.record, "乙");
	const [first, second] = h.queue.view(h.id).items;
	h.queue.hold(h.id, first.id);
	await h.finish("run-1");
	assert.deepEqual(h.sent, []);
	await h.queue.edit(h.id, first.id, "甲（改）", []);
	await h.settle();
	assert.deepEqual(h.sent, ["甲（改）"]);
	// 编辑非队首时不影响队首发送；放弃编辑后照常继续。
	h.queue.hold(h.id, second.id);
	h.queue.hold(h.id);
	await h.finish("run-2");
	assert.deepEqual(h.sent, ["甲（改）", "乙"]);
	assert.throws(() => h.queue.hold(h.id, randomUUID()), /已发送或已删除/);
	// 切换会话时放弃暂缓。
	h.state.busy = true;
	await h.queue.accept(h.record, "丙");
	h.queue.hold(h.id, h.queue.view(h.id).items[0].id);
	h.state.busy = false;
	h.queue.release(h.id);
	await h.settle();
	assert.deepEqual(h.sent, ["甲（改）", "乙", "丙"]);
});
