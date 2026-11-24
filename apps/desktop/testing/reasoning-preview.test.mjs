import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openModelStream } from "../workbench/gateway.mjs";
import { runtimeSelection, updateService } from "../workbench/model-library.mjs";
import { createReasoningPreview, latestSentence } from "../workbench/reasoning-preview.mjs";
import { createRuntimeHost } from "../workbench/runtime-host.mjs";
import { approveWorkspace } from "../workbench/workspace.mjs";
import { startMockModel } from "./mock-model.mjs";

test("推理预览取最近一句完整的话，过长时截断", () => {
	assert.equal(latestSentence("先读取预算表。再核对报价单的第 2 页"), "先读取预算表。");
	assert.equal(latestSentence("先读取预算表。再核对报价单。"), "再核对报价单。");
	assert.equal(latestSentence("正在比较两列"), "正在比较两列");
	assert.equal(latestSentence("  "), "");
	const long = latestSentence(`${"很长".repeat(100)}。`);
	assert.equal(Array.from(long).length, 120);
	assert.ok(long.endsWith("…"));
});

test("推理预览按会话节流，清理后不再输出", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const published = [];
	const preview = createReasoningPreview((session, sentence) => published.push([session, sentence]), 1000);
	preview.push("a", "第一句。");
	preview.push("a", "第二句。");
	preview.push("b", "另一会话。");
	assert.deepEqual(published, [
		["a", "第一句。"],
		["b", "另一会话。"],
	]);
	t.mock.timers.tick(1000);
	assert.deepEqual(published.at(-1), ["a", "第二句。"]);
	preview.push("a", "第三句。");
	preview.clear("a");
	t.mock.timers.tick(2000);
	assert.equal(published.length, 3);
});

test("Desktop 子进程把回环网关的推理转为瞬时预览，不增加会话提交", { timeout: 20000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-reasoning-"));
	const directory = join(root, "profile");
	const workspaceDirectory = join(root, "工作区");
	await mkdir(workspaceDirectory);
	const workspace = await approveWorkspace(workspaceDirectory);
	const session = randomUUID();
	const fixture = await startMockModel({
		attachmentReply: () => ({
			reasoning: ["先确认用户要的口径。", "再给出结论。"],
			reasoningDelay: 1100,
			text: "结论：差额 37。",
		}),
	});
	const library = updateService(
		{ activeId: "", services: [] },
		{ name: "回环夹具", baseUrl: fixture.baseUrl, modelId: "local-test" },
		{},
	);
	const settings = library.services[0];
	const { model } = runtimeSelection(settings);
	const bootstrap = join(root, "utility-shim.mjs");
	await writeFile(
		bootstrap,
		`
		const listeners = [];
		const pending = [];
		process.on("message", data => listeners.length ? listeners.forEach(listener => listener({ data })) : pending.push(data));
		Object.defineProperty(process, "parentPort", { value: {
			postMessage: (value) => process.send(value),
			on: (_kind, listener) => { listeners.push(listener); for (const data of pending.splice(0)) listener({ data }); },
		} });
		await import(process.argv[2]);
	`,
	);
	const events = [];
	const previews = [];
	const done = Promise.withResolvers();
	let child;
	const host = createRuntimeHost({
		directory,
		model,
		fork(entry) {
			child = fork(bootstrap, [pathToFileURL(entry).href], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
			child.postMessage = (message) => child.send(message);
			return child;
		},
		onExit() {},
		onEvent(event) {
			events.push(event);
			if (event.type === "terminal") done.resolve(event);
		},
		onReasoning(frame) {
			previews.push(frame);
		},
		gateway: ({ context, signal, maxTokens }) => openModelStream({ context, signal, maxTokens, model, settings }),
		authorizeWrite: async () => "deny",
	});
	t.after(async () => {
		const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined;
		host.close();
		await exited;
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	});
	await host.ready;
	await host.call("register", { session, workspace });
	const { requestId } = await host.call("submit", { session, input: "核对差额" });
	assert.equal((await done.promise).status, "succeeded");
	assert.deepEqual(previews, [
		{ sessionId: session, requestId, text: "先确认用户要的口径。" },
		{ sessionId: session, requestId, text: "再给出结论。" },
	]);
	// 推理不经共享核心提交：会话序号只覆盖运行时事件，历史也不含推理文本。
	const saved = JSON.parse(await readFile(join(directory, "sessions", `${session}.json`), "utf8"));
	assert.equal(saved.lastSequence, events.length);
	const [row] = await host.call("history", { session });
	assert.equal(row.text, "结论：差额 37。");
	assert.doesNotMatch(JSON.stringify(row), /口径/);
});
