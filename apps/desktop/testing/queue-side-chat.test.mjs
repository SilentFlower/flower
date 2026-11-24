import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
	await assert.rejects(api.compactContext(id), /会话正在运行/);
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

	// 手动压缩：空闲时把迄今的对话归纳为摘要，分隔落在最后一轮之后；没有新对话时不再压缩。
	assert.equal(await api.compactContext(id), true);
	history = await api.history(id);
	assert.equal(history.at(-1).compactedAfter, true);
	assert.equal(history.filter(({ compactedBefore, compactedAfter }) => compactedBefore || compactedAfter).length, 1);
	assert.equal(await api.compactContext(id), false);
	assert.equal((await api.state()).compacting, false);

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
	assert.ok(fixture.observations.tools.slice(0, -1).some((names) => names.includes("write_report")));
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
	// 正文搜索：两个字起匹配提问与回复，侧边追问内容不被搜到。
	const found = await api.searchSessions("二月核对");
	assert.deepEqual(
		found.map(({ id: key, snippets }) => [key, snippets[0].field, snippets[0].match]),
		[[id, "text", "二月核对"]],
	);
	assert.equal(found[0].snippets[0].requestId, first.requestId);
	assert.deepEqual(await api.searchSessions("侧边回答"), []);
	assert.deepEqual(await api.searchSessions("二"), []);
	await assert.rejects(api.searchSessions(7), /搜索内容无效/);
	await api.closeSideChat(id);
	await assert.rejects(access(sideFile));
	assert.deepEqual((await api.state()).sideChats, []);

	// 编辑中的队首在当前任务结束时暂缓发送，保存后按修改后的原文发送。
	const held = await api.submit(id, "慢：编辑期间运行");
	// 主会话运行中打开侧边追问：只带入已完成的轮次；队列项可转为侧边追问并移出队列。
	await desktop.event((event) => event.requestId === held.requestId && event.type === "started");
	const during = await api.openSideChat(id);
	const duringFile = JSON.parse(
		await readFile(join(root, "profile", "local-workbench", "sessions", `${during.id}.json`), "utf8"),
	);
	assert.equal(
		duringFile.messages.some((message) => text(message).includes("慢：编辑期间运行")),
		false,
	);
	const toSide = await api.submit(id, "侧边：转过去的问题");
	assert.equal((await api.queueToSideChat(id, toSide.queued)).dropped, 0);
	assert.equal((await api.state()).queue.items.length, 0);
	for (let tries = 0; ; tries++) {
		const rows = await api.sideChatHistory(id);
		if (rows.some(({ input, status }) => input === "侧边：转过去的问题" && status === "succeeded")) break;
		assert(tries < 300, "转为侧边追问的消息未得到回答");
		await delay(50);
	}
	await api.closeSideChat(id);
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
	// 压缩后的第一条成功请求之前显示分隔。
	assert.equal(history.find(({ compactedBefore }) => compactedBefore)?.input, "慢：编辑期间运行");
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
	// 运行中退出的会话在重启后列入中断横幅；全部继续时先续跑中断的请求，再发送保留的排队消息。
	state = await desktop.state((current) => current.interrupted.length);
	assert.deepEqual(state.interrupted, [{ id, title: state.sessions[0].title }]);
	await assert.rejects(api.resumeInterrupted([randomUUID()]), /中断任务已变化/);
	// 忽略后本次运行不再显示横幅；仍可从会话内继续。
	await api.dismissInterrupted();
	assert.deepEqual((await api.state()).interrupted, []);
	await api.resumeInterrupted([id]);
	assert.deepEqual((await api.state()).interrupted, []);
	await desktop.state((current) => !current.queue.items.length && !current.sessions[0].busy, 20000);
	history = await api.history(id);
	assert.deepEqual(
		history.slice(-3).map(({ input, status }) => [input, status]),
		[
			["慢：第五问", "interrupted"],
			["慢：第五问", "succeeded"],
			["第六问", "succeeded"],
		],
	);

	// 删除会话：立即移出列表，撤销期内保留记录文件，撤销后恢复原位置与侧边追问。
	const another = await api.openSideChat(id);
	const sessionsDirectory = join(root, "profile", "local-workbench", "sessions");
	const anotherFile = join(sessionsDirectory, `${another.id}.json`);
	await api.manageSidebar("session", id, "delete");
	state = await api.state();
	assert.deepEqual([state.sessions.length, state.sideChats.length], [0, 0]);
	await access(anotherFile);
	await access(join(sessionsDirectory, `${id}.json`));
	await api.undoDeleteSession(id);
	state = await api.state();
	assert.deepEqual([state.sessions[0].id, state.sideChats[0]?.id, state.selected], [id, another.id, id]);
	assert.equal((await api.history(id)).length > 0, true);
	// 撤销期内退出应用视为确认删除，重启后会话与侧边追问的记录文件都已清理。
	await api.manageSidebar("session", id, "delete");
	await desktop.restart();
	state = await desktop.state((current) => current.ready);
	assert.deepEqual([state.sessions.length, state.sideChats.length], [0, 0]);
	await assert.rejects(access(anotherFile));
	await assert.rejects(access(join(sessionsDirectory, `${id}.json`)));
	assert.deepEqual(await api.searchSessions("二月核对"), []);
	await assert.rejects(api.undoDeleteSession(id), /无法撤销/);
});

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
