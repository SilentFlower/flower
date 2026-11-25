import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchDesktop } from "./desktop-harness.mjs";
import { startMockModel } from "./mock-model.mjs";

test("新会话首条消息自动命名、手动改名优先、失败保留临时标题，以及用 AI 重命名", { timeout: 60000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-session-title-"));
	const workspace = join(root, "工作区");
	await mkdir(workspace);
	// 标题请求的应答方式：ok 正常返回、fail 返回 500、hold 等待测试放行。
	let mode = "ok";
	let reply = "“二月预算差额核对”。";
	let release;
	const fixture = await startMockModel({
		attachmentReply: (messages) => ({
			text: `回答：${messages
				.findLast(({ role }) => role === "user")
				.content.toString()
				.slice(0, 8)}`,
		}),
		async titleReply() {
			if (mode === "fail") return { status: 500 };
			if (mode === "hold") await new Promise((resolve) => (release = resolve));
			return { text: reply };
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
		capability: { mode: "none", contextWindow: "65536", levels: [] },
	});
	desktop.choose(workspace);
	const id = await api.chooseWorkspace();
	const title = async (session) => (await api.state()).sessions.find((entry) => entry.id === session)?.title;
	const titles = (count) => desktop.state(() => fixture.observations.titles.length >= count);
	const settled = (session) => desktop.state((state) => !state.sessions.find((entry) => entry.id === session)?.busy);

	// 首条消息：提交返回时已是临时标题，随后换成模型结果（去掉引号与句号）。
	const first = "请核对二月预算和报价的差额并生成汇总表";
	await api.submit(id, first);
	assert.equal(await title(id), first);
	await desktop.state((state) => state.sessions.find((entry) => entry.id === id).title === "二月预算差额核对");
	const [request] = fixture.observations.titles;
	assert.equal(request.reasoning, null);
	assert.match(request.body, /<user_message>\n请核对二月预算和报价的差额并生成汇总表\n<\/user_message>/);
	// 对话请求的观察记录不含标题请求。
	await settled(id);
	assert.equal(fixture.observations.model.length, 1);
	// 第二条消息不再命名。
	await api.submit(id, "再看三月");
	await settled(id);
	assert.equal(fixture.observations.titles.length, 1);

	// 生成期间手动改名：结果返回后仍是手动的名字。
	mode = "hold";
	const second = await api.newSession(id);
	await api.submit(second, "核对供应商对账单");
	await titles(2);
	await api.manageSidebar("session", second, "rename", "我的标题");
	release();
	await settled(second);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(await title(second), "我的标题");

	// 模型失败：保留临时标题，长消息截断加省略号。
	mode = "fail";
	const third = await api.newSession(second);
	const long = `${"汇总".repeat(25)}的结果`;
	await api.submit(third, long);
	await titles(3);
	await settled(third);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(await title(third), `${"汇总".repeat(20)}…`);

	// 用 AI 重命名：按整段对话命名；空会话与模型失败报原因且标题不变。
	mode = "ok";
	reply = "季度对账";
	assert.equal(await api.renameSessionWithAI(id), "季度对账");
	assert.equal(await title(id), "季度对账");
	const conversation = fixture.observations.titles.at(-1).body;
	assert.match(conversation, /<conversation>\n用户：请核对二月预算和报价的差额并生成汇总表\n助手：回答：/);
	assert.match(conversation, /用户：再看三月/);
	const empty = await api.newSession(third);
	await assert.rejects(api.renameSessionWithAI(empty), /没有找到对应的本机会话/);
	mode = "fail";
	await assert.rejects(api.renameSessionWithAI(id), /暂时无法生成标题/);
	assert.equal(await title(id), "季度对账");

	// 升级前已有的会话没有待命名标记：首条消息不改名。
	mode = "ok";
	await desktop.close();
	const file = join(root, "profile", "local-workbench", "workbench.json");
	const stored = JSON.parse(await readFile(file, "utf8"));
	for (const entry of stored.sessions) delete entry.titlePending;
	stored.sessions.unshift({
		id: empty,
		title: "旧版新会话",
		workspace: stored.sessions[0].workspace,
		writeMode: "auto",
	});
	stored.selected = empty;
	await writeFile(file, JSON.stringify(stored));
	desktop.launch();
	await desktop.state((state) => state.ready);
	await assert.rejects(api.renameSessionWithAI(empty), /没有可用于命名的内容/);
	const before = fixture.observations.titles.length;
	await api.submit(empty, "旧会话的第一条消息");
	await settled(empty);
	assert.equal(fixture.observations.titles.length, before);
	assert.match(await title(empty), /新会话$/);
});
