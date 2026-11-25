import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveFirstIntent } from "../workbench/first-session.mjs";
import { launchDesktop } from "./desktop-harness.mjs";
import { startMockModel } from "./mock-model.mjs";

test("临时草稿首发接受后才创建会话，失败和并发保留归属，重启只恢复真正接受的请求", { timeout: 35_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-first-session-"));
	const dir = join(root, "工作区");
	const external = join(root, "仓外证据.txt");
	const data = join(root, "profile", "local-workbench");
	const workbenchFile = join(data, "workbench.json");
	const sessions = join(data, "sessions");
	await mkdir(dir);
	await writeFile(external, "首发附件内容。\n");
	await writeFile(join(dir, "本地.txt"), "工作区本地文件。");
	const fixture = await startMockModel({
		attachmentReply: (messages) => ({
			text: `收到${JSON.stringify(messages).includes("首发附件内容") ? "附件" : "消息"}。`,
		}),
		titleReply: () => ({ text: "核对收到的附件" }),
	});
	t.after(() => fixture.close());
	const desktop = await launchDesktop(root);
	t.after(async () => {
		await desktop.close();
		await rm(root, { recursive: true, force: true });
	});
	const { api } = desktop;
	await desktop.state(({ ready }) => ready);
	desktop.choose(dir);
	const id = await api.chooseWorkspace();
	const initial = await api.state();
	assert.equal(initial.selected, id);
	assert.equal(initial.draft.id, id);
	assert.equal(initial.draft.path, dir);
	assert.equal(initial.sessions.length, 0);
	assert.equal(initial.workspaces.length, 0);
	assert.equal(await api.chooseWorkspace(), id);
	assert((await api.workspaceFiles(id, "本地")).includes("本地.txt"));
	await api.setWriteMode(id, "read");
	desktop.choose(external);
	await api.chooseFile(id);
	const [original] = (await api.state()).draft.attachments;
	assert.match(original.id, /^asset:/);
	const preview = await api.previewAttachment(id, null, original.id);
	assert.match(preview.text, /首发附件内容/);
	await assert.rejects(access(workbenchFile), { code: "ENOENT" });
	await assert.rejects(access(join(sessions, `${id}.json`)), { code: "ENOENT" });
	await assert.rejects(api.submit(id, "先做一次模型未配置的校验", true), /先配置模型/);
	assert.equal((await api.state()).draft.attachments[0].id, original.id);

	await api.saveModel({ serviceId: "", baseUrl: fixture.baseUrl, modelId: "local-test", apiKey: "" });
	const moved = join(root, "临时移开的工作区");
	await rename(dir, moved);
	await assert.rejects(api.submit(id, "工作区已变化时保留草稿", true), /工作区位置已变化/);
	assert.equal((await api.state()).draft.attachments[0].id, original.id);
	await rename(moved, dir);
	const snapshotPath = join(sessions, `${id}.json`);
	// 制造真实 worker 读取失败，确认未接收的请求不产生侧栏记录。
	await mkdir(snapshotPath);
	await assert.rejects(api.submit(id, "检查读取失败后仍可发送", true), /记录位置|会话记录/);
	await rm(snapshotPath, { recursive: true });
	assert.equal((await api.state()).sessions.length, 0);
	assert.equal((await api.state()).draft.attachments[0].id, original.id);
	const results = await Promise.allSettled([
		api.submit(id, "请核对本轮附件", true),
		api.submit(id, "重复首发不得入队", true),
	]);
	assert.equal(results[0].status, "fulfilled");
	assert.equal(results[1].status, "rejected");
	assert.match(results[1].reason.message, /已发送|在发送/);
	const { requestId } = results[0].value;
	await desktop.event(
		(event) => event.requestId === requestId && event.type === "terminal" && event.status === "succeeded",
	);
	await desktop.state(({ sessions }) => sessions[0]?.title === "核对收到的附件");
	const live = await api.state();
	assert.equal(live.draft, undefined);
	assert.equal(live.sessions.length, 1);
	assert.equal(live.sessions[0].id, id);
	assert.equal(live.sessions[0].attachments.length, 0);
	assert.equal(live.writeMode, "read");
	const history = await api.history(id);
	assert.equal(history.length, 1);
	assert.equal(history[0].attachments[0].id, original.id);
	assert.match(history[0].text, /收到附件/);

	const second = await api.newSession(id);
	await api.chooseFile(second);
	assert.equal((await api.state()).sessions.length, 1);
	await api.selectSession(id);
	await assert.rejects(api.previewAttachment(second, null, (await api.state()).draft?.attachments?.[0]?.id), /当前会话/);
	await api.selectSession(second);
	assert.equal((await api.state()).draft.attachments[0].name, "仓外证据.txt");
	await desktop.restart();
	await desktop.state(({ ready }) => ready);
	assert.equal((await api.state()).selected, id);
	assert.equal((await api.state()).draft, undefined);
	await assert.rejects(access(join(sessions, "attachment-assets", second)), { code: "ENOENT" });
	assert.match((await api.previewAttachment(id, requestId, original.id)).text, /首发附件内容/);

	// 模拟首发已接收而侧栏索引未落盘时退出。重启依据真实请求修复索引，不再次调用模型。
	await desktop.close();
	const workbench = JSON.parse(await readFile(workbenchFile, "utf8"));
	const [owner] = workbench.sessions;
	await saveFirstIntent(sessions, owner);
	await writeFile(workbenchFile, JSON.stringify({ ...workbench, selected: "", sessions: [] }));
	const modelsBeforeRestart = fixture.observations.model.length;
	desktop.launch();
	await desktop.state(({ ready }) => ready);
	const recovered = await api.state();
	assert.equal(recovered.sessions.length, 1);
	assert.equal(recovered.selected, id);
	assert.equal(recovered.sessions[0].title, "请核对本轮附件");
	assert.equal((await api.history(id))[0].requestId, requestId);
	assert.equal(fixture.observations.model.length, modelsBeforeRestart);
	assert.equal(fixture.observations.titles.length, 1);
});
