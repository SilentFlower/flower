import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import Excel from "exceljs";
import { importAttachmentFile, readStoredEvidence } from "../workbench/attachment-assets.mjs";
import { openModelStream } from "../workbench/gateway.mjs";
import { runtimeSelection, updateService } from "../workbench/model-library.mjs";
import { createRuntimeHost } from "../workbench/runtime-host.mjs";
import { approveWorkspace } from "../workbench/workspace.mjs";
import { startMockModel } from "./mock-model.mjs";

function quotePdf() {
	const pages = ["Vendor: Flower Test", "Quote amount 537"];
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 2 /Kids [4 0 R 6 0 R] >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		...pages.flatMap((content, index) => {
			const commands = `BT /F1 10 Tf 12 40 Td (${content}) Tj ET`;
			return [
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 80] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
				`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`,
			];
		}),
	];
	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const offset = pdf.length;
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return `${String(offset).padStart(10, "0")} 00000 n \n`;
	});
	return `${pdf}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
}

function messageText(message) {
	return typeof message.content === "string"
		? message.content
		: (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

test("Desktop 子进程经真实 pi、回环网关和附件，摘要后重启续接报价与预算出处", { timeout: 25000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-context-continuity-"));
	const directory = join(root, "profile");
	const files = join(root, "原始证据");
	const workspaceDirectory = join(root, "工作区");
	await mkdir(files);
	await mkdir(workspaceDirectory);
	const quote = join(files, "供应商报价.pdf");
	const budget = join(files, "预算.xlsx");
	await writeFile(quote, quotePdf());
	const book = new Excel.Workbook();
	book.addWorksheet("预算表").getCell("B7").value = 500;
	await book.xlsx.writeFile(budget);
	const session = randomUUID();
	const workspace = await approveWorkspace(workspaceDirectory);
	const attachments = await Promise.all(
		[quote, budget].map((file) => importAttachmentFile(join(directory, "sessions"), session, file)),
	);
	const trace = [];
	const approvals = [];
	const fixture = await startMockModel({
		attachmentReply(messages) {
			const body = messages.map(messageText).join("\n");
			const prompt = messageText(messages.findLast(({ role }) => role === "user"));
			const compacting = messages.some(
				(message) => message.role === "system" && messageText(message).includes("生成 Flower 会话检查点"),
			);
			trace.push({ compacting, body, messages });
			const price = /(?:Quote amount|报价金额)\s+(\d+)/.exec(body)?.[1];
			const allowed = /(?:B7="|预算金额\s+)(\d+)/.exec(body)?.[1];
			const quoteLine = price ? `报价金额 ${price}（供应商报价.pdf 第 2 页）` : "";
			const budgetLine = allowed ? `预算金额 ${allowed}（预算.xlsx 预算表!B7）` : "";
			const difference = price && allowed ? `差额 ${Number(price) - Number(allowed)}` : "";
			const summary = [quoteLine, budgetLine, difference].filter(Boolean).join("\n");
			if (compacting) return { text: `目标：继续核对同一供应商的报价和预算。\n${summary}` };
			if (prompt.includes("生成核对报告") && messages.at(-1).role !== "tool") {
				assert.match(body, /第 1 页\nVendor: Flower Test/);
				assert.match(body, /第 2 页\nQuote amount 537/);
				assert.match(body, /行 7｜B7="500"/);
				return { markdown: `# 核对结果\n\n${summary}`, source: `attachment:${attachments[0].id.slice(6)}` };
			}
			return { text: summary || "已记下补充材料。" };
		},
	});
	const library = updateService(
		{ activeId: "", services: [] },
		{
			name: "回环夹具",
			baseUrl: fixture.baseUrl,
			modelId: "local-test",
			capability: { contextWindow: 4096 },
		},
		{},
	);
	const settings = library.services[0];
	const { model } = runtimeSelection(settings);
	assert.equal(model.contextWindow, 4096);
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
	let active;
	const caps = [];
	t.after(async () => {
		await active?.stop();
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	});
	async function boot(sessionId = session, selectedModel = model) {
		const events = new Map();
		const waiters = new Map();
		let child;
		const host = createRuntimeHost({
			directory,
			model: selectedModel,
			fork(entry) {
				child = fork(bootstrap, [pathToFileURL(entry).href], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
				child.postMessage = (message) => child.send(message);
				return child;
			},
			onExit() {},
			onEvent(event) {
				if (event.type !== "terminal") return;
				events.set(event.requestId, event);
				waiters.get(event.requestId)?.(event);
			},
			gateway({ context, signal, maxTokens }) {
				caps.push({ budget: maxTokens, first: context.messages[0]?.content });
				return openModelStream({ context, signal, maxTokens, model: selectedModel, settings });
			},
			async authorizeWrite(plan) {
				approvals.push(plan);
				return plan.workspaceId === workspace.id && plan.files?.join() === "核对报告.md" ? "allow" : "deny";
			},
		});
		active = {
			host,
			async submit(input, refs) {
				const { requestId } = await host.call("submit", { session: sessionId, input, attachments: refs });
				const result = events.get(requestId) ?? (await new Promise((resolve) => waiters.set(requestId, resolve)));
				assert.equal(result.status, "succeeded", result.failure?.message);
				return requestId;
			},
			async stop() {
				const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined;
				host.close();
				await exited;
			},
		};
		await host.ready;
		await host.call("register", { session: sessionId, workspace });
		return active;
	}
	const first = await boot();
	const id = await first.submit("核对两份附件并生成核对报告", attachments);
	for (let index = 0; index < 6; index++) await first.submit(`补充记录 ${index}：${"仓储交付记录".repeat(130)}`);
	assert(trace.some(({ compacting }) => compacting));
	assert(caps.some(({ budget, first }) => budget < 819 && String(first).includes("生成 Flower 会话检查点")));
	assert.equal(approvals.length, 1);
	const reports = await readdir(workspaceDirectory);
	assert.equal(reports.length, 1);
	assert.match(await readFile(join(workspaceDirectory, reports[0], "核对报告.md"), "utf8"), /差额 37/);
	const saved = JSON.parse(await readFile(join(directory, "sessions", `${session}.json`), "utf8"));
	assert.match(saved.contextCheckpoint.summary, /预算表!B7/);
	assert(saved.messages.some((message) => messageText(message).includes("Vendor: Flower Test")));
	await first.stop();
	const restart = await boot();
	const previousCalls = trace.length;
	assert.deepEqual(await restart.host.call("context-usage", { session }), {
		tokens: (await restart.host.call("context-usage", { session })).tokens,
		limit: 4096,
		estimated: true,
		// 未设置全局指令、工作区没有 FLOWER.md。
		instructions: { personal: false },
	});
	await restart.submit("重启后只回答差额和原始出处");
	assert.equal(trace.length, previousCalls + 1);
	const resumed = trace.at(-1);
	assert.match(resumed.body, /此前会话的检查点[\s\S]*报价金额 537（供应商报价.pdf 第 2 页）/);
	assert.match(resumed.body, /预算金额 500（预算.xlsx 预算表!B7）[\s\S]*差额 37/);
	const restored = await restart.host.call("history", { session });
	// 自动压缩同样标出最近一次压缩的位置，且只有一处。
	assert.equal(restored.filter(({ compactedBefore, compactedAfter }) => compactedBefore || compactedAfter).length, 1);
	const original = restored.find(({ requestId }) => requestId === id);
	assert.equal(original.input, "核对两份附件并生成核对报告");
	assert.deepEqual(original.attachments, attachments);
	// 工具步骤与起止时间随会话落盘，重启后附件编号仍显示为附件名。
	assert.deepEqual(
		original.steps.map(({ toolName, target }) => [toolName, target]),
		[["write_report", attachments[0].name]],
	);
	assert(original.steps.every(({ startedAt, endedAt }) => startedAt <= endedAt));
	assert(original.startedAt <= original.endedAt);
	const readAgain = await Promise.all(
		original.attachments.map((ref) => readStoredEvidence(join(directory, "sessions"), session, ref)),
	);
	assert.match(readAgain[0][0].text, /第 2 页\nQuote amount 537/);
	assert.match(readAgain[1][0].text, /行 7｜B7="500"/);
	assert.equal(approvals.length, 1);
	await restart.stop();

	const legacySession = randomUUID();
	const legacyFile = join(directory, "sessions", `${legacySession}.json`);
	const long = "useful old context ".repeat(16000);
	const assistant = saved.messages.find(({ role }) => role === "assistant");
	assert(assistant);
	await writeFile(
		legacyFile,
		JSON.stringify({
			version: 1,
			workspaceId: workspace.id,
			lastSequence: 0,
			artifacts: [],
			operations: [],
			requests: [],
			messages: [
				{ role: "user", timestamp: 1, content: long },
				{ ...assistant, timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "已读旧资料" }] },
				{ role: "user", timestamp: 3, content: "请保留最近一轮" },
				{ ...assistant, timestamp: 4, stopReason: "stop", content: [{ type: "text", text: "已核对预算出处" }] },
			],
		}),
	);
	const legacy = await boot(legacySession, { ...model, contextWindow: 8192 });
	const oldCalls = trace.length;
	await legacy.submit("继续");
	const calls = trace.slice(oldCalls);
	const batches = calls.filter(({ compacting }) => compacting);
	assert(batches.length > 1 && batches.length <= 20);
	assert(batches.every(({ messages }) => messages.every(({ role }) => role !== "tool")));
	const excerpts = batches.map(({ messages }) => messageText(messages.at(-1)).split("有序会话记录片段\n")[1]);
	assert(excerpts.every(Boolean));
	assert(excerpts.join("").includes(long));
	assert(excerpts.join("").includes("已读旧资料"));
	assert.equal(calls.length, batches.length + 1);
	assert.match(calls.at(-1).body, /此前会话的检查点[\s\S]*请保留最近一轮[\s\S]*已核对预算出处[\s\S]*继续/);
	assert.equal(JSON.parse(await readFile(legacyFile, "utf8")).messages[0].content, long);
	assert.equal(approvals.length, 1);
	t.diagnostic(`8192 token 窗口：${batches.length} 次摘要，1 次续接，无新增工具调用。`);
});
