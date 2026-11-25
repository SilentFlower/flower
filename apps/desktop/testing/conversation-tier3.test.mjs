import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportSelectedSegments } from "../workbench/conversation-export.mjs";
import { launchDesktop } from "./desktop-harness.mjs";
import { startMockModel } from "./mock-model.mjs";

test("真实桌面通过安全前缀分叉、编辑重发和回退，区分单条消息并走原生导出路由", { timeout: 30000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-tier3-conversation-"));
	const workspace = join(root, "工作区");
	const attachment = join(root, "来源资料.txt");
	await mkdir(workspace);
	await writeFile(attachment, "历史附件原文");
	const received = [];
	const fixture = await startMockModel({
		attachmentReply(messages) {
			const current = messages.findLast(({ role }) => role === "user")?.content;
			const input = typeof current === "string" ? current : current[0].text;
			received.push({ input, messages });
			if (input === "第二个提问" && messages.at(-1).role !== "tool") {
				return { markdown: "# 独占产物\n\n来自第二轮。" };
			}
			if (input === "第一个提问") {
				const alias = /attachment:[a-f\d]{64}/.exec(JSON.stringify(messages))?.[0];
				return {
					text: `第一个回复 **加粗**\n\n<script>代码仅作文字</script>\n\n![远程图](https://example.org/image.png)\n\n核对引用 ${alias}`,
				};
			}
			return { text: `已回复 ${input}` };
		},
	});
	const desktop = await launchDesktop(root);
	const { api } = desktop;
	t.after(async () => {
		await desktop.close();
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	});
	await desktop.state((s) => s.ready);
	await api.saveModel({ serviceId: "", name: "本机回环", baseUrl: fixture.baseUrl, modelId: "local-test", apiKey: "" });
	desktop.choose(workspace);
	const original = await api.chooseWorkspace();
	desktop.choose(attachment);
	await api.chooseFile(original);
	async function finish(run) {
		const event = await desktop.event((item) => item.type === "terminal" && item.requestId === run.requestId);
		assert.equal(event.status, "succeeded", event.failure?.message);
		return event;
	}
	const first = await api.submit(original, "第一个提问");
	await finish(first);
	const second = await api.submit(original, "第二个提问");
	await finish(second);
	const history = await api.history(original);
	assert.equal(history.length, 2);
	assert.equal(history[1].artifacts.length, 1);
	const fid = history[0].attachments[0];
	const artifact = history[1].artifacts[0];

	const selection = [
		{ requestId: second.requestId, kind: "user", index: 0 },
		{ requestId: first.requestId, kind: "reply", index: 0 },
	];
	const chosen = await api.sessionImageContent(original, selection);
	assert.equal(chosen.title, "对话摘选");
	assert.deepEqual(
		chosen.segments.map(({ role, text }) => [role, text.split("\n")[0]]),
		[
			["Flower", "第一个回复 **加粗**"],
			["你", "第二个提问"],
		],
	);
	assert(!JSON.stringify(chosen).includes("第一个提问"));
	assert(!JSON.stringify(chosen).includes("已回复 第二个提问"));
	await assert.rejects(api.sessionImageContent(original, [selection[0], selection[0]]), /重复/);
	await assert.rejects(api.sessionImageContent(original, [{ ...selection[0], requestId: randomUUID() }]), /已结束/);
	await assert.rejects(api.sessionImageContent(original, [{ ...selection[1], index: 2 }]), /已变化/);
	await assert.rejects(api.pasteClipboardImage(original), /剪贴板中没有图片/);
	const screenshot = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC",
		"base64",
	);
	desktop.seedClipboard(screenshot);
	await api.pasteClipboardImage(original);
	const screenshotRef = (await api.state()).sessions.find(({ id }) => id === original).attachments[0];
	assert.equal(screenshotRef.name, "截图 1.png");
	const pasted = await api.attachmentImage(original, null, screenshotRef.id);
	assert.equal(pasted.mime, "image/png");
	assert.deepEqual(Buffer.from(pasted.bytes), screenshot);
	await api.removeAttachment(original, screenshotRef.id);
	const png = Buffer.alloc(33);
	Buffer.from("89504e470d0a1a0a", "hex").copy(png);
	png.write("IHDR", 12);
	png.writeUInt32BE(960, 16);
	png.writeUInt32BE(200, 20);
	await api.copySessionImage(original, new Uint8Array(png));
	assert.deepEqual(desktop.clipboardWrites.at(-1).png, png);
	await api.copySessionMarkdown(original);
	assert.match(desktop.clipboardWrites.at(-1).text, /\*\*加粗\*\*/);
	desktop.save(join(root, "导出的会话.html"));
	assert.equal(await api.exportSessionHtml(original), true);
	const html = await readFile(join(root, "导出的会话.html"), "utf8");
	assert.match(html, /<strong>加粗<\/strong>/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script>|<img\s/i);
	await assert.rejects(api.exportSessionHtml(original), /目标文件已存在/);

	const modelCalls = received.length;
	const proposal = await api.sessionRevisionPreview(original, first.requestId, "fork");
	assert.equal(proposal.retained, 1);
	assert.equal(proposal.excluded, 1);
	assert.deepEqual(proposal.files, [{ path: artifact, status: "ready" }]);
	await assert.rejects(
		api.applySessionRevision(original, first.requestId, "fork", proposal.revision - 1, "", []),
		/已变化/,
	);
	const { id: fork } = await api.applySessionRevision(original, first.requestId, "fork", proposal.revision, "", []);
	assert.equal(received.length, modelCalls);
	const forkHistory = await api.history(fork);
	assert.equal(forkHistory.length, 1);
	assert.equal(forkHistory[0].requestId, first.requestId);
	assert.notEqual(forkHistory[0].attachments[0].id, fid.id);
	const preview = await api.previewAttachment(fork, first.requestId, forkHistory[0].attachments[0].id);
	assert.equal(preview.text, "历史附件原文");
	await assert.rejects(api.previewAttachment(fork, first.requestId, fid.id), /不属于/);
	await assert.rejects(api.sessionImageContent(fork, [selection[0]]), /已结束/);
	await finish(await api.submit(fork, "分叉续接"));
	const forkContext = JSON.stringify(received.at(-1).messages);
	assert.match(forkContext, /第一个提问|历史附件原文/);
	assert(!forkContext.includes("第二个提问"));
	assert(forkContext.includes(forkHistory[0].attachments[0].id.slice(6)));
	assert(!forkContext.includes(fid.id.slice(6)));
	assert.equal(forkHistory[0].text, history[0].text);

	await api.selectSession(original);
	const edit = await api.sessionRevisionPreview(original, first.requestId, "edit");
	assert.equal(edit.retained, 0);
	const { id: edited } = await api.applySessionRevision(
		original,
		first.requestId,
		"edit",
		edit.revision,
		"编辑后的提问",
		[],
	);
	await desktop.event((row) => row.type === "terminal" && row.sessionId === edited);
	const editedHistory = await api.history(edited);
	assert.deepEqual(
		editedHistory.map(({ input }) => input),
		["编辑后的提问"],
	);
	assert.equal(editedHistory[0].attachments[0].name, fid.name);
	assert(!JSON.stringify(received.at(-1).messages).includes("第一个提问"));

	await api.selectSession(original);
	const rewind = await api.sessionRevisionPreview(original, first.requestId, "rewind");
	assert(rewind.canUndo);
	const outcome = await api.applySessionRevision(original, first.requestId, "rewind", rewind.revision, "", [artifact]);
	assert.equal(outcome.undone, 1);
	assert.equal((await api.history(outcome.id)).length, 1);
	assert.equal((await api.history(original)).length, 2);
	assert((await api.state()).sessions.some(({ id, title }) => id === original && title.endsWith("回退前")));
	await assert.rejects(stat(join(workspace, artifact)), { code: "ENOENT" });
	await desktop.restart();
	await desktop.state((s) => s.ready);
	assert.equal((await api.history(outcome.id)).length, 1);
	assert.equal((await api.history(original)).length, 2);
});

test("图片选择兼容旧原文和插话的独立位置，保留原顺序", () => {
	const a = {
		requestId: "a",
		input: "旧 Host 装饰文本",
		status: "succeeded",
		text: "甲前甲后",
		steers: [{ input: "选择口径", textOffset: 2 }],
	};
	const b = { requestId: "b", input: "问题乙", status: "succeeded", text: "回答乙" };
	const picked = exportSelectedSegments({ requests: [a, b], desktopMessages: { a: { input: "问题甲" } } }, [
		{ requestId: "b", kind: "user", index: 0 },
		{ requestId: "a", kind: "reply", index: 1 },
		{ requestId: "a", kind: "steer", index: 0 },
	]);
	assert.deepEqual(
		picked.map(({ text }) => text),
		["选择口径", "甲后", "问题乙"],
	);
	assert(!JSON.stringify(picked).includes("旧 Host"));
});
