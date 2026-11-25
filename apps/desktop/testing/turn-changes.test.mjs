import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Excel from "exceljs";
import {
	listTurnChanges,
	recordedTurnChangeIds,
	recordTurnChanges,
	turnArtifacts,
	undoTurnChanges,
} from "../workbench/turn-changes.mjs";
import { approveWorkspace, workspaceTools } from "../workbench/workspace.mjs";
import { launchDesktop } from "./desktop-harness.mjs";
import { startMockModel } from "./mock-model.mjs";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "flower-turn-changes-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "sessions");
	const location = join(root, "工作区");
	await mkdir(location);
	const workspace = await approveWorkspace(location);
	const session = randomUUID();
	const request = randomUUID();
	const args = [directory, workspace, session, request];
	const tools = (approval = () => "allow") =>
		workspaceTools(workspace, approval, undefined, () => (receipt) => recordTurnChanges(...args, receipt));
	return { root, workspace, args, tools, session, request };
}

test("无 Git 工作区撤销真实产物，重启回读，其他请求和旧资料均不能借用证明", async (t) => {
	const { workspace, args, tools, session, request } = await fixture(t);
	const report = tools().find(({ name }) => name === "write_report");
	const independent = "原有文件不可撤销";
	await writeFile(join(workspace.root, "核对报告.md"), independent);
	const markdown = "# 本轮报告\n\n未编辑的内容。";
	const result = await report.execute("write", { markdown });
	const [path] = JSON.parse(result.content[0].text).artifacts;
	assert.deepEqual(Object.keys(JSON.parse(result.content[0].text)), ["artifacts"]);
	assert.equal(await readFile(join(workspace.root, path), "utf8"), markdown);
	assert.deepEqual([...(await recordedTurnChangeIds(args[0], session))], [request]);
	assert.deepEqual(await listTurnChanges(...args), [{ path, status: "ready" }]);
	assert.deepEqual(await listTurnChanges(args[0], workspace, session, randomUUID(), [path]), [
		{ path, status: "legacy" },
	]);
	assert.deepEqual(await undoTurnChanges(args[0], workspace, randomUUID(), request), { files: [], undone: 0 });
	await assert.rejects(undoTurnChanges(args[0], workspace, "../other-session", request), /会话无效/);
	const saved = await undoTurnChanges(...args);
	assert.equal(saved.undone, 1);
	assert.equal(saved.files[0].status, "undone");
	await assert.rejects(readFile(join(workspace.root, path)), { code: "ENOENT" });
	assert.equal(await readFile(join(workspace.root, saved.files[0].recoveryPath, "核对报告.md"), "utf8"), markdown);
	assert.equal(await readFile(join(workspace.root, "核对报告.md"), "utf8"), independent);
	assert.deepEqual(await listTurnChanges(...args), saved.files);
	assert.deepEqual(await undoTurnChanges(...args), { files: saved.files, undone: 0 });
	const ledger = join(args[0], "turn-changes", session, request);
	const [receipt] = await readdir(ledger);
	const recorded = JSON.parse(await readFile(join(ledger, receipt), "utf8"));
	// 模拟整组移动后进程来不及标记完成，重启仍可定位已保存的恢复目录。
	await writeFile(join(ledger, receipt), JSON.stringify({ ...recorded, undoneAt: undefined }));
	assert.deepEqual(await listTurnChanges(...args), saved.files);
	assert.equal((await undoTurnChanges(...args)).undone, 0);
	await writeFile(join(ledger, receipt), JSON.stringify(recorded));
	await rm(join(workspace.root, dirname(saved.files[0].recoveryPath)), { recursive: true });
	assert.deepEqual(await listTurnChanges(...args), [{ path, status: "undone" }]);
});

test("工作簿产物成组保护编辑和额外文件，并保留本轮的其他可撤销产物", async (t) => {
	const { workspace, args, tools } = await fixture(t);
	const book = new Excel.Workbook();
	book.addWorksheet("明细").addRows([
		["地区", "金额"],
		["华东", 37],
	]);
	await book.xlsx.writeFile(join(workspace.root, "原始数据.xlsx"));
	const analyze = tools().find(({ name }) => name === "analyze_excel");
	const options = {
		path: "原始数据.xlsx",
		sheet: "明细",
		groupColumn: "地区",
		valueColumn: "金额",
		createOutputs: true,
	};
	const result = await analyze.execute("analysis", options);
	const [report, workbook] = JSON.parse(result.content[0].text).artifacts;
	const reportTool = tools().find(({ name }) => name === "write_report");
	const [separate] = JSON.parse(
		(await reportTool.execute("report", { markdown: "备用报告" })).content[0].text,
	).artifacts;
	const workbookBytes = await readFile(join(workspace.root, workbook));
	await writeFile(join(workspace.root, report), "用户稍后编辑");
	await writeFile(join(workspace.root, dirname(report), "用户附注.txt"), "业务备注");
	const preview = Object.fromEntries((await listTurnChanges(...args)).map(({ path, status }) => [path, status]));
	assert.deepEqual(preview, { [report]: "changed", [workbook]: "changed", [separate]: "ready" });
	assert.equal((await undoTurnChanges(...args, [], [report])).undone, 0);
	const resultUndo = await undoTurnChanges(...args);
	assert.equal(resultUndo.undone, 1);
	assert.equal(await readFile(join(workspace.root, report), "utf8"), "用户稍后编辑");
	assert.equal(await readFile(join(workspace.root, dirname(report), "用户附注.txt"), "utf8"), "业务备注");
	assert.deepEqual(await readFile(join(workspace.root, workbook)), workbookBytes);
	assert.deepEqual(
		turnArtifacts({
			toolResults: [
				{ toolName: "read_text_file", text: [result.content[0].text] },
				{ toolName: "analyze_excel", isError: true, text: [result.content[0].text] },
				{ toolName: "write_report", text: [JSON.stringify({ artifacts: ["../外部.md", separate, separate] })] },
			],
		}),
		[separate],
	);
});

test("写入拒绝与同名目录不留账本，原目录被替换或链接到外部时不撤销", async (t) => {
	const { root, workspace, args, tools, session } = await fixture(t);
	const write = (decide) => tools(decide).find(({ name }) => name === "write_report");
	await assert.rejects(write(() => "read").execute("read", { markdown: "无权限" }), /只读/);
	let existing;
	await assert.rejects(
		write(async ({ directory }) => {
			existing = join(workspace.root, directory);
			await mkdir(existing);
			return "allow";
		}).execute("existing", { markdown: "已有目录" }),
		{ code: "EEXIST" },
	);
	assert.deepEqual(await readdir(existing), []);
	assert.equal((await recordedTurnChangeIds(args[0], session)).size, 0);
	const result = await write().execute("report", { markdown: "原内容" });
	const [path] = JSON.parse(result.content[0].text).artifacts;
	const folder = join(workspace.root, dirname(path));
	const moved = join(root, "其他用户数据");
	await rename(folder, moved);
	await symlink(moved, folder, process.platform === "win32" ? "junction" : "dir");
	assert.deepEqual(await undoTurnChanges(...args), { files: [{ path, status: "changed" }], undone: 0 });
	assert.equal(await readFile(join(moved, "核对报告.md"), "utf8"), "原内容");
});

test("真实 worker 写后失败仍可从账本回读，Main 按所选会话、权限和原生确认裁决撤销", { timeout: 30000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-turn-worker-"));
	const workspaceDirectory = join(root, "工作区");
	await mkdir(workspaceDirectory);
	let desktop;
	const model = await startMockModel({
		attachmentReply(messages) {
			// 在确认工具结果已送回后故意截断下一次流，模拟写入之后的模型中断。
			if (messages.at(-1).role === "tool") throw new Error("受控模型中断");
			return { toolCall: { name: "write_report", args: { markdown: "# 正式产物\n\n来源依据" } } };
		},
	});
	t.after(async () => {
		await desktop?.close();
		await model.close();
		await rm(root, { recursive: true, force: true });
	});
	desktop = await launchDesktop(root);
	const { api } = desktop;
	await desktop.state(({ ready }) => ready);
	await api.saveModel({ serviceId: "", name: "回环模型", baseUrl: model.baseUrl, modelId: "local-test", apiKey: "" });
	desktop.choose(workspaceDirectory);
	const session = await api.chooseWorkspace();
	const { requestId } = await api.submit(session, "生成核对报告");
	const terminal = await desktop.event((event) => event.requestId === requestId && event.type === "terminal");
	assert.equal(terminal.status, "failed");
	const [record] = await api.history(session);
	assert.equal(record.hasTurnChanges, true);
	assert.equal(record.artifacts.length, 1);
	const workspace = await approveWorkspace(workspaceDirectory);
	const directory = join(root, "profile", "local-workbench", "sessions");
	const [change] = await listTurnChanges(directory, workspace, session, requestId);
	assert.deepEqual(change, { path: record.artifacts[0], status: "ready" });
	await desktop.restart();
	await desktop.state(({ ready }) => ready);
	assert.equal((await desktop.api.history(session))[0].hasTurnChanges, true);
	const current = desktop.api;
	await assert.rejects(() => current.turnChanges(session, randomUUID()), /消息不属于/);
	await current.selectSession("");
	await assert.rejects(() => current.turnChanges(session, requestId), /当前|会话/);
	await current.selectSession(session);
	await current.setWriteMode(session, "read");
	assert.equal((await current.turnChanges(session, requestId)).canUndo, false);
	await assert.rejects(() => current.undoTurnChanges(session, requestId), /只读/);
	assert.equal(desktop.prompts.length, 0);
	await current.setWriteMode(session, "ask");
	assert.equal((await current.turnChanges(session, requestId)).canUndo, true);
	assert.equal(await current.undoTurnChanges(session, requestId), undefined);
	assert.deepEqual(desktop.prompts[0].buttons, ["取消", "撤销变更"]);
	assert.equal(desktop.prompts[0].defaultId, 0);
	assert.ok(desktop.prompts[0].detail.includes(change.path));
	assert.equal(await readFile(join(workspace.root, change.path), "utf8"), "# 正式产物\n\n来源依据");
	desktop.confirm(1);
	assert.equal((await current.undoTurnChanges(session, requestId)).undone, 1);
	assert.equal((await current.turnChanges(session, requestId)).files[0].status, "undone");
	await assert.rejects(readFile(join(workspace.root, change.path)), { code: "ENOENT" });
});
