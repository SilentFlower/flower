import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchDesktop } from "./desktop-harness.mjs";
import { startMockModel } from "./mock-model.mjs";

function text(message) {
	return typeof message.content === "string"
		? message.content
		: (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

test("排队、插话、暂停继续与侧边追问经真实 Main、worker 与回环模型", { timeout: 60000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-queue-side-"));
	const workspace = join(root, "工作区");
	await mkdir(workspace);
	const systems = [];
	const fixture = await startMockModel({
		attachmentReply(messages) {
			const system = messages.find(({ role }) => role === "system");
			systems.push(system ? text(system) : "");
			const prompt = text(messages.findLast(({ role }) => role === "user"));
			// 带「慢」的请求先输出几段推理，留出排队与插话的时间。
			const slow = prompt.includes("慢") ? { reasoning: ["想", "再想", "还在想"], reasoningDelay: 500 } : {};
			if (prompt.includes("改成二月")) return { text: "已按二月核对。" };
			if (prompt.includes("侧边")) return { text: "侧边回答。" };
			return { ...slow, text: `回答：${prompt.slice(0, 12)}` };
		},
	});
	const desktop = await launchDesktop(root);
	t.after(async () => {
		await desktop.close();
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	});
	const { api } = desktop;
	await desktop.state((state) => state.ready);
	await api.saveModel({
		serviceId: "",
		name: "回环夹具",
		baseUrl: fixture.baseUrl,
		modelId: "local-test",
		apiKey: "",
		capability: { mode: "none", contextWindow: "8192", levels: [] },
	});
	await mkdir(join(workspace, "财务"));
	await writeFile(join(workspace, "财务", "预算.xlsx"), "");
	await writeFile(join(workspace, "预算.bin"), "");
	desktop.choose(workspace);
	const id = await api.chooseWorkspace();
	// @ 补全只读当前会话工作区，只列可加入对话的文件。
	assert.deepEqual(await api.workspaceFiles(id, "预算"), ["财务/预算.xlsx"]);
	await assert.rejects(api.workspaceFiles(id, 3), /查询无效/);
	const terminal = (requestId) => desktop.event((event) => event.requestId === requestId && event.type === "terminal");

	// 主会话尚无完成的回答时不能打开侧边追问。
	await assert.rejects(api.openSideChat(id), /请先等待主会话完成一次回答/);

	// 空闲时直接提交；运行中再发的消息进入队列，不出现在运行时请求中。
	const first = await api.submit(id, "慢：第一问");
	assert.ok(first.requestId);
	const second = await api.submit(id, "第二问");
	const steer = await api.submit(id, "改成二月");
	assert.ok(second.queued && steer.queued);
	let state = await desktop.state((current) => current.queue?.steerable);
	assert.deepEqual(
		state.queue.items.map(({ input }) => input),
		["第二问", "改成二月"],
	);
	assert.equal(state.sessions.find((entry) => entry.id === id).busy, true);
	await api.steerQueueItem(id, steer.queued);
	const steered = await desktop.event((event) => event.type === "steered");
	assert.equal(steered.steerId, steer.queued);
	assert.equal(steered.input, "改成二月");
	assert.equal((await terminal(first.requestId)).status, "succeeded");
	// 当前任务结束后自动发送队首。
	state = await desktop.state((current) => !current.queue.items.length && !current.sessions[0].busy);
	let history = await api.history(id);
	assert.deepEqual(
		history.map(({ input }) => input),
		["慢：第一问", "第二问"],
	);
	assert.equal(history[1].status, "succeeded");
	const [withSteer] = history;
	assert.match(withSteer.text, /回答：慢：第一问[\s\S]*已按二月核对。/);
	assert.deepEqual(
		withSteer.steers.map(({ input, textOffset }) => [input, textOffset]),
		[["改成二月", "回答：慢：第一问".length]],
	);

	// 用户停止运行后队列暂停，点继续后发送队首。
	const third = await api.submit(id, "慢：第三问");
	const fourth = await api.submit(id, "第四问");
	assert.ok(fourth.queued);
	const running = await desktop.event((event) => event.requestId === third.requestId && event.type === "started");
	await api.cancel(id, third.requestId, running.runId);
	assert.equal((await terminal(third.requestId)).status, "cancelled");
	state = await desktop.state((current) => current.queue.paused);
	assert.deepEqual(
		state.queue.items.map(({ input }) => input),
		["第四问"],
	);
	await delay(300);
	assert.equal((await api.history(id)).length, 3);
	await api.resumeQueue(id);
	await desktop.state((current) => !current.queue.items.length);
	history = await api.history(id);
	assert.equal(history.at(-1).input, "第四问");
	await terminal(history.at(-1).requestId);

	// 侧边追问：复制已完成的上下文，只读工具集，关闭后删除记录。
	const side = await api.openSideChat(id);
	assert.equal(side.turns, 3);
	state = await api.state();
	assert.deepEqual(
		state.sideChats.map(({ id: key, parent }) => [key, parent]),
		[[side.id, id]],
	);
	assert.equal(
		state.sessions.some((entry) => entry.id === side.id),
		false,
	);
	const asked = await api.submitSideChat(id, "侧边：二月差额是多少");
	assert.equal((await terminal(asked.requestId)).status, "succeeded");
	assert.match(systems.at(-1), /当前是侧边追问/);
	assert.equal(fixture.observations.tools.at(-1).includes("write_report"), false);
	assert.equal(fixture.observations.tools.at(-2).includes("write_report"), true);
	const sideHistory = await api.sideChatHistory(id);
	assert.deepEqual(
		sideHistory.map(({ input, text: reply }) => [input, reply]),
		[["侧边：二月差额是多少", "侧边回答。"]],
	);
	const sideFile = join(root, "profile", "local-workbench", "sessions", `${side.id}.json`);
	const forked = JSON.parse(await readFile(sideFile, "utf8"));
	assert.ok(forked.messages.some((message) => text(message).includes("慢：第一问")));
	// 主会话的历史不受侧边追问影响。
	assert.equal((await api.history(id)).length, 4);
	await api.closeSideChat(id);
	await assert.rejects(access(sideFile));
	assert.deepEqual((await api.state()).sideChats, []);

	// 编辑中的队首在当前任务结束时暂缓发送，保存后按修改后的原文发送。
	const held = await api.submit(id, "慢：编辑期间运行");
	const pending = await api.submit(id, "待修改的原文");
	await api.holdQueueItem(id, pending.queued);
	assert.equal((await terminal(held.requestId)).status, "succeeded");
	await delay(300);
	assert.deepEqual(
		(await api.state()).queue.items.map(({ input }) => input),
		["待修改的原文"],
	);
	await api.editQueueItem(id, pending.queued, "修改后的原文", []);
	await desktop.state((current) => !current.queue.items.length);
	history = await api.history(id);
	assert.equal(history.at(-1).input, "修改后的原文");
	await terminal(history.at(-1).requestId);

	// 重启后排队消息保留并暂停。
	const fifth = await api.submit(id, "慢：第五问");
	await api.submit(id, "第六问");
	await desktop.event((event) => event.requestId === fifth.requestId && event.type === "started");
	await desktop.restart();
	state = await desktop.state((current) => current.ready);
	assert.deepEqual(
		state.queue.items.map(({ input }) => input),
		["第六问"],
	);
	assert.equal(state.queue.paused, true);

	// 删除主会话时一并删除其侧边追问记录。
	const another = await api.openSideChat(id);
	const anotherFile = join(root, "profile", "local-workbench", "sessions", `${another.id}.json`);
	await access(anotherFile);
	await api.manageSidebar("session", id, "delete");
	await desktop.state((current) => !current.sideChats.length && !current.sessions.length);
	await assert.rejects(access(anotherFile));
});

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
