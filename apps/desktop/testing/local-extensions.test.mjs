import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openModelStream } from "../workbench/gateway.mjs";
import { createLocalExtensions, readLocalExtensionPackage } from "../workbench/local-extensions.mjs";
import { runtimeSelection, updateService } from "../workbench/model-library.mjs";
import { createRuntimeHost } from "../workbench/runtime-host.mjs";
import { approveWorkspace } from "../workbench/workspace.mjs";
import { startMockModel } from "./mock-model.mjs";

const sampleFile = fileURLToPath(new URL("./fixtures/review-lines.flower-extension.json", import.meta.url));
const skillSample = fileURLToPath(new URL("./fixtures/weekly-report.SKILL.md", import.meta.url));
const toolName = "flower_extension_review_lines";
const skillTool = "flower_skill_weekly_report";

async function setup(context) {
	const temporary = await mkdtemp(join(tmpdir(), "flower-local-extension-"));
	const profile = join(temporary, "profile");
	const project = join(temporary, "project");
	const unrelated = join(temporary, "unrelated");
	await Promise.all([mkdir(project), mkdir(unrelated)]);
	await Promise.all([
		writeFile(join(project, "核对.txt"), "首页\r\nTODO：核对甲\r\ntodo：核对乙\r\n末页\r\n"),
		writeFile(join(unrelated, "核对.txt"), "TODO：另一工作区的文件\n"),
	]);
	context.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }));
	return {
		temporary,
		profile,
		project,
		unrelated,
		workspace: await approveWorkspace(project),
		other: await approveWorkspace(unrelated),
	};
}

test("扩展可安装调用，按工作区隔离，过期工具无法越过启停和卸载", async (t) => {
	const { profile, workspace, other } = await setup(t);
	const extensions = createLocalExtensions(profile);
	const manifest = await readLocalExtensionPackage(sampleFile);
	assert.deepEqual(await extensions.list(workspace.id), []);
	const installed = await extensions.install(workspace.id, manifest);
	assert.equal(installed.toolName, toolName);
	assert.equal(installed.enabled, true);
	await assert.rejects(extensions.install(workspace.id, manifest), /已安装/);
	assert.deepEqual(await extensions.list(other.id), []);
	assert.deepEqual(await extensions.tools(other), []);
	await assert.rejects(extensions.run(other, installed.id, "核对.txt"), /未安装/);
	await assert.rejects(extensions.run(workspace, installed.id, "../unrelated/核对.txt"), /无效/);
	await assert.rejects(extensions.run(workspace, installed.id, join(other.root, "核对.txt")), /相对路径/);

	const expected = {
		path: "核对.txt",
		examined: 4,
		matched: 2,
		matches: [
			{ line: 2, text: "TODO：核对甲" },
			{ line: 3, text: "todo：核对乙" },
		],
		truncated: false,
	};
	assert.deepEqual(await extensions.run(workspace, installed.id, "核对.txt"), expected);
	const [tool] = await extensions.tools(workspace);
	assert.equal(tool.name, toolName);
	const result = await tool.execute("test", { path: "核对.txt" });
	assert.deepEqual(JSON.parse(result.content[0].text), expected);

	const reopened = createLocalExtensions(profile);
	assert.deepEqual(await reopened.list(workspace.id), [installed]);
	await reopened.setEnabled(workspace.id, installed.id, false);
	assert.deepEqual(await extensions.tools(workspace), []);
	await assert.rejects(tool.execute("test", { path: "核对.txt" }), /停用|变化/);
	await reopened.setEnabled(workspace.id, installed.id, true);
	await assert.rejects(tool.execute("test", { path: "核对.txt" }), /变化/);
	assert.deepEqual(await reopened.run(workspace, installed.id, "核对.txt"), expected);

	await reopened.uninstall(workspace.id, installed.id);
	assert.deepEqual(await createLocalExtensions(profile).list(workspace.id), []);
	await assert.rejects(extensions.run(workspace, installed.id, "核对.txt"), /未安装/);
});

test("扩展声明经过版本和能力校验，统计与提取遵守输出和工作区读取边界", async (t) => {
	const { temporary, profile, project, workspace } = await setup(t);
	const extPath = join(temporary, "package.json");
	const manifest = await readLocalExtensionPackage(sampleFile);
	for (const [invalid, pattern] of [
		[{ ...manifest, schemaVersion: 0 }, /版本/],
		[{ ...manifest, exec: "unknown" }, /字段/],
		[{ ...manifest, id: "bad_name" }, /标识/],
		[{ ...manifest, action: "external" }, /能力/],
		[{ ...manifest, maxMatches: 999 }, /匹配上限/],
	]) {
		await writeFile(extPath, JSON.stringify(invalid));
		await assert.rejects(readLocalExtensionPackage(extPath), pattern);
	}
	await writeFile(extPath, "x".repeat(16 * 1024 + 1));
	await assert.rejects(readLocalExtensionPackage(extPath), /16 KiB/);
	const extensions = createLocalExtensions(profile);
	await Promise.all([
		extensions.install(workspace.id, { ...manifest, maxMatches: 1 }),
		extensions.install(workspace.id, { ...manifest, id: "count-todos", action: "count-lines", caseSensitive: true }),
	]);
	assert.equal((await extensions.list(workspace.id)).length, 2);
	const bounded = await extensions.run(workspace, manifest.id, "核对.txt");
	assert.equal(bounded.matched, 2);
	assert.equal(bounded.matches.length, 1);
	assert.equal(bounded.truncated, true);
	const count = await extensions.run(workspace, "count-todos", "核对.txt");
	assert.equal(count.matched, 1);
	assert.deepEqual(count.matches, []);
	await writeFile(join(project, "过大.txt"), "x".repeat(64 * 1024 + 1));
	await assert.rejects(extensions.run(workspace, manifest.id, "过大.txt"), /文件.*(大|上限|范围)/);
	await assert.rejects(extensions.run(workspace, manifest.id, "核对.txt", AbortSignal.abort()), { name: "AbortError" });
	if (process.platform !== "win32") {
		await symlink(sampleFile, `${extPath}.link.json`);
		await assert.rejects(readLocalExtensionPackage(`${extPath}.link.json`), /普通/);
		await symlink(join(temporary, "unrelated", "核对.txt"), join(project, "链接.txt"));
		await assert.rejects(extensions.run(workspace, manifest.id, "链接.txt"), /链接/);
	}
	await rename(project, `${project}-old`);
	await mkdir(project);
	await assert.rejects(extensions.run(workspace, manifest.id, "核对.txt"), /位置已变化/);
});

test("任意命名的 Markdown 技能保留正文，附属脚本、链接和工具声明只作为资料", async (t) => {
	const { temporary, profile, workspace, other } = await setup(t);
	const selected = join(temporary, "任意周报名称.markdown");
	const script = join(temporary, "helper.cjs");
	const sentinel = join(temporary, "不得创建");
	await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "脚本")`);
	const body = "# 周报模板\n\n先汇总工作记录。\n\n[脚本示例](helper.cjs)\n\n```sh\nnode helper.cjs\n```\n";
	await writeFile(
		selected,
		`---\r\nname: weekly-report\r\ndescription: >-\r\n  草拟周报，\r\n  含风险。\r\nallowed-tools: Bash\r\nscripts: [helper.cjs]\r\n---\r\n${body}`,
	);
	const manifest = await readLocalExtensionPackage(selected);
	assert.deepEqual(manifest, {
		kind: "skill",
		schemaVersion: 1,
		id: "weekly-report",
		name: "weekly-report",
		description: "草拟周报， 含风险。",
		body,
	});
	const catalog = createLocalExtensions(profile);
	const installed = await catalog.install(workspace.id, manifest);
	assert.equal(installed.kind, "skill");
	assert.equal(installed.toolName, skillTool);
	assert.deepEqual(await catalog.list(workspace.id), [installed]);
	const { enabled, ...publicSkill } = installed;
	assert.equal(enabled, true);
	assert.deepEqual(await catalog.run(workspace, installed.id, undefined), publicSkill);
	assert.deepEqual(await catalog.tools(other), []);
	await assert.rejects(catalog.selectedSkill(other, installed.id), /未安装/);
	const [tool] = await catalog.tools(workspace);
	assert.match(tool.description, /技能名称为 "weekly-report"/);
	assert.deepEqual(tool.parameters, { type: "object", properties: {}, additionalProperties: false });
	const response = await tool.execute("skill", {});
	assert.equal(response.content[0].text, body);
	await assert.rejects(access(sentinel), { code: "ENOENT" });
	await rm(selected);
	assert.deepEqual(await createLocalExtensions(profile).run(workspace, installed.id, undefined), publicSkill);
	await catalog.setEnabled(workspace.id, installed.id, false);
	assert.deepEqual(await catalog.tools(workspace), []);
	await assert.rejects(tool.execute("skill", {}), /停用/);
	await catalog.uninstall(workspace.id, installed.id);
	assert.deepEqual(await catalog.list(workspace.id), []);
});

test("Markdown 技能拒绝无效 YAML、别名字段与超限内容", async (t) => {
	const { temporary } = await setup(t);
	const path = join(temporary, "test.md");
	for (const [header, message] of [
		["name: weekly-report\nname: repeated\ndescription: 汇总", /YAML/],
		["name: &title 例子\ndescription: *title", /文字类型/],
		["name: !!js/function unsafe\ndescription: 汇总", /YAML/],
		["name: [a,b]\ndescription: 汇总", /文字类型/],
	]) {
		await writeFile(path, `---\n${header}\n---\n# 正文\n`);
		await assert.rejects(readLocalExtensionPackage(path), message);
	}
	await writeFile(path, "# 普通文本");
	await assert.rejects(readLocalExtensionPackage(path), /YAML 头部/);
	await writeFile(path, "字".repeat(16 * 1024));
	await assert.rejects(readLocalExtensionPackage(path), /16 KiB/);
});

test("真实工作进程调用扩展与技能，所选技能只进入当前出站用户块并在排队时复核", { timeout: 60000 }, async (t) => {
	const { temporary, profile, workspace, other } = await setup(t);
	const extensions = createLocalExtensions(profile);
	const manifest = await readLocalExtensionPackage(sampleFile);
	const arbitraryName = join(temporary, "这是周会整理.md");
	await copyFile(skillSample, arbitraryName);
	const skill = await readLocalExtensionPackage(arbitraryName);
	const selectedMessages = [];
	const heldRequest = Promise.withResolvers();
	const release = Promise.withResolvers();
	const fixture = await startMockModel({
		attachmentReply(messages) {
			const last = messages.at(-1);
			if (last.role === "tool") return { text: `读取扩展结果：${last.content}` };
			const prompt = JSON.stringify(last.content);
			if (prompt.includes("调用核对扩展")) return { toolCall: { name: toolName, args: { path: "核对.txt" } } };
			if (prompt.includes("请读取周报技能")) return { toolCall: { name: skillTool, args: {} } };
			if (prompt.includes("选用周报技能") || prompt.includes("下一轮查看") || prompt.includes("撤权后不得发送"))
				selectedMessages.push(messages);
			return { text: "检查工具表。" };
		},
	});
	const library = updateService(
		{ activeId: "", services: [] },
		{ name: "回环", baseUrl: fixture.baseUrl, modelId: "local-test" },
		{},
	);
	const settings = library.services[0];
	const { model } = runtimeSelection(settings);
	const bridge = join(temporary, "utility-process.mjs");
	await writeFile(
		bridge,
		`
		const listeners = [];
		const pending = [];
		process.on("message", data => listeners.length ? listeners.forEach(listener => listener({ data })) : pending.push(data));
		Object.defineProperty(process, "parentPort", { value: {
			postMessage: data => process.send(data),
			on: (_event, listener) => { listeners.push(listener); for (const data of pending.splice(0)) listener({ data }); },
		} });
		await import(process.argv[2]);
	`,
	);
	const events = new Map();
	let host;
	let child;
	let exited;

	async function close() {
		host?.close();
		await exited;
		host = undefined;
	}

	t.after(async () => {
		release.resolve();
		await close();
		await fixture.close();
	});

	async function start() {
		host = createRuntimeHost({
			directory: profile,
			model,
			fork(entry) {
				child = fork(bridge, [pathToFileURL(entry).href], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
				child.postMessage = (frame) => child.send(frame);
				exited = once(child, "exit");
				return child;
			},
			onExit() {},
			onEvent(event) {
				if (event.type === "terminal") events.set(event.requestId, event);
			},
			async gateway({ context, signal, maxTokens }) {
				if (JSON.stringify(context.messages.at(-1)?.content).includes("暂缓队首")) {
					heldRequest.resolve();
					await release.promise;
				}
				return openModelStream({ model, settings, context, signal, maxTokens });
			},
			authorizeWrite: async () => "deny",
		});
		await host.ready;
	}

	async function terminal(requestId, status = "succeeded") {
		for (let attempt = 0; attempt < 600 && !events.has(requestId); attempt++) await pause(15);
		assert.equal(events.get(requestId)?.status, status);
	}

	async function run(session, input, skillId) {
		const { requestId } = await host.call("submit", { session, input, skill: skillId });
		await terminal(requestId);
		return (await host.call("history", { session })).find((entry) => entry.requestId === requestId);
	}

	const session = randomUUID();
	const unrelated = randomUUID();
	await extensions.install(workspace.id, manifest);
	await extensions.install(workspace.id, skill);
	await start();
	await host.call("register", { session, workspace });
	await host.call("register", { session: unrelated, workspace: other });
	const result = await run(session, "调用核对扩展");
	assert.ok(result.steps.some(({ toolName: name }) => name === toolName));
	assert.match(result.text, /TODO：核对甲/);
	assert.ok(fixture.observations.tools.at(-1).includes(toolName));
	await run(unrelated, "检查其他工作区能力");
	assert.ok(!fixture.observations.tools.at(-1).includes(toolName));
	assert.ok(!fixture.observations.tools.at(-1).includes(skillTool));
	await assert.rejects(host.call("submit", { session: unrelated, input: "越过授权", skill: skill.id }), /所选技能/);

	const input = "选用周报技能";
	const explicit = await run(session, input, skill.id);
	assert.equal(explicit.input, input);
	assert.equal(explicit.skill, skill.id);
	assert.match(JSON.stringify(selectedMessages[0].at(-1).content), /本轮所选工作流技能资料.*周报工作流/);
	assert.doesNotMatch(
		JSON.stringify(selectedMessages[0].filter(({ role }) => role === "system")),
		/本轮所选工作流技能资料/,
	);
	const snapshot = JSON.parse(await readFile(join(profile, "sessions", `${session}.json`), "utf8"));
	assert.equal(snapshot.desktopMessages[explicit.requestId].input, input);
	assert.equal(snapshot.desktopMessages[explicit.requestId].skill.id, skill.id);
	assert.doesNotMatch(JSON.stringify(snapshot), /本轮所选工作流技能资料/);
	await run(session, "下一轮查看");
	assert.doesNotMatch(JSON.stringify(selectedMessages[1]), /本轮所选工作流技能资料/);

	const fromTool = await run(session, "请读取周报技能");
	assert.ok(fromTool.steps.some(({ toolName: name }) => name === skillTool));
	assert.match(fromTool.text, /周报工作流/);

	const first = await host.call("submit", { session, input: "暂缓队首" });
	await heldRequest.promise;
	const waiting = await host.call("submit", { session, input: "撤权后不得发送", skill: skill.id });
	await extensions.setEnabled(workspace.id, skill.id, false);
	release.resolve();
	await terminal(first.requestId);
	await terminal(waiting.requestId, "failed");
	assert.equal(selectedMessages.length, 2);
	await assert.rejects(host.call("submit", { session, input: "停用后直接使用", skill: skill.id }), /所选技能/);
	await extensions.setEnabled(workspace.id, skill.id, true);

	await close();
	await start();
	await host.call("register", { session, workspace });
	const afterRestart = await run(session, "再次调用核对扩展");
	assert.match(afterRestart.text, /核对乙/);
	assert.ok(fixture.observations.tools.at(-1).includes(skillTool));
	await extensions.uninstall(workspace.id, skill.id);
	await extensions.setEnabled(workspace.id, manifest.id, false);
	await run(session, "检查停用后的能力");
	assert.ok(!fixture.observations.tools.at(-1).includes(toolName));
	await extensions.uninstall(workspace.id, manifest.id);
	await run(session, "检查卸载后的能力");
	assert.ok(!fixture.observations.tools.at(-1).includes(toolName));
	assert.ok(!fixture.observations.tools.at(-1).includes(skillTool));
});
