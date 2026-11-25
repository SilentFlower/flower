import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

const [binary, output, tooling] = process.argv.slice(2);
assert(
	process.platform === "win32" && tooling,
	"在独立 Window Station 中运行：verify-ux-tier3-windows.mjs <候选 EXE> <新证据目录> <Playwright 目录>",
);
const evidence = resolve(output);
const profile = join(evidence, "profile");
const workspace = join(evidence, "非 Git 合成工作区");
const htmlPath = join(evidence, "导出的会话.html");
const { _electron: electron } = createRequire(join(resolve(tooling), "package.json"))("playwright");
await mkdir(evidence);
await mkdir(workspace);
await writeFile(join(workspace, "用户原有资料.txt"), "保留这份文件。");

const firstPrompt = "甲一提问标记：核对年度预算";
const firstReply = "乙一助手标记：已按原始口径核对 **差额**。";
const secondPrompt = "丙二提问标记：生成核对报告";
const secondReply = "丁二助手标记：核对报告已保存。";
const questionPrompt = "第三轮：请先确认最终报告口径和附列";
const questionReply = "已收到调整后预算，并保留来源记录。";
const questions = [
	{ question: "核对报告采用哪种口径？", options: ["原始预算", "调整后预算"] },
	{
		question: "报告还应包含哪些章节？请同时考虑数据来源和需要人工核对的条目。",
		options: ["差异说明", "数据来源与原始附件的详细行号和页码", "后续核对计划"],
		multiple: true,
	},
];
const seenAnswers = [];
const text = (message) =>
	typeof message?.content === "string" ? message.content : (message?.content ?? []).map(({ text }) => text).join("");
const fixture = await startMockModel({
	titleReply: () => ({ text: "年度预算核对" }),
	attachmentReply(messages) {
		const input = text(messages.findLast(({ role }) => role === "user"));
		const last = messages.at(-1);
		if (input === firstPrompt)
			return { text: `${firstReply}\n\n<script>脚本只作文字</script>\n\n![外链图](https://example.org/foreign.png)` };
		if (input === secondPrompt)
			return last.role === "tool" ? { text: secondReply } : { markdown: "# 实际产物\n\n来自第二轮。" };
		if (input === questionPrompt) {
			if (last.role !== "tool") return { toolCall: { name: "ask_user_question", args: { questions } } };
			seenAnswers.push(JSON.parse(text(last)));
			return { text: questionReply };
		}
		return { text: "收到新的核对要求。" };
	},
});
const verifies = [];
const results = {
	checks: verifies,
	evidence,
	clipboard: "独立 Window Station，实读写 Electron 系统剪贴板",
	candidate: resolve(binary),
};
let app;
let page;
const watchdog = globalThis.setTimeout(() => {
	console.error("专项验收超时，清理专用 profile 的应用。");
	app?.process().kill();
	process.exit(2);
}, 140_000);

const step = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const by = (id) => page.locator(`#${id}`);
const task = (prompt) => page.locator("article.task").filter({ has: page.getByText(prompt, { exact: true }) });
function bounded(promise, description) {
	return Promise.race([
		promise,
		delay(20000, undefined, { ref: false }).then(() => {
			throw new Error(`等待超时：${description}`);
		}),
	]);
}
async function until(check, description) {
	for (let count = 0; count < 100; count++) {
		const value = await check();
		if (value) return value;
		await delay(100);
	}
	throw new Error(`等待超时：${description}`);
}
const state = () =>
	bounded(
		page.evaluate(() => window.flower.state()),
		"工作台状态",
	);
const QA = () =>
	bounded(
		app.evaluate(() => globalThis.flowerTier3QA),
		"读取已拦截的原生调用",
	);

async function boot() {
	app = await electron.launch({
		executablePath: resolve(binary),
		args: [`--user-data-dir=${profile}`, "--force-device-scale-factor=1"],
		chromiumSandbox: true,
		timeout: 30000,
	});
	page = await app.firstWindow();
	page.setDefaultTimeout(14000);
	await bounded(
		app.evaluate(
			({ app, BrowserWindow, clipboard, ClipboardItem, dialog }, input) => {
				if (app.getPath("userData").toLowerCase() !== input.profile.toLowerCase()) throw new Error("验收资料路径不符");
				if (
					typeof ClipboardItem !== "function" ||
					typeof clipboard.read !== "function" ||
					typeof clipboard.write !== "function"
				)
					throw new Error("Electron 缺少剪贴板 ClipboardItem 接口");
				const qa = { savePath: input.savePath, saved: [], confirmations: [] };
				globalThis.flowerTier3QA = qa;
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.workspace] });
				dialog.showSaveDialog = async (_owner, options) => {
					qa.saved.push({
						title: options.title,
						defaultPath: options.defaultPath,
						filters: options.filters,
						path: qa.savePath,
					});
					return { canceled: false, filePath: qa.savePath };
				};
				dialog.showMessageBox = async (_owner, options) => {
					qa.confirmations.push({ message: options.message, buttons: options.buttons });
					const action = options.buttons.findIndex((label) => label !== "取消");
					return { response: action >= 0 ? action : 0 };
				};
				BrowserWindow.getAllWindows()[0].setContentSize(1180, 790);
			},
			{ profile, workspace, savePath: htmlPath },
		),
		"安装原生接口记录",
	);
	await by("workspace").waitFor();
	await until(async () => (await state()).ready, "工作台初始化");
}
async function close() {
	if (!app) return;
	const owned = app;
	await Promise.race([
		owned.close().catch(() => owned.process().kill()),
		delay(5000, undefined, { ref: false }).then(() => owned.process().kill()),
	]);
	app = undefined;
}
async function send(prompt) {
	await by("prompt").fill(prompt);
	await by("send").click();
	await task(prompt).waitFor();
}
async function share(operation) {
	await by("conversation-actions-open").click();
	await by("conversation-actions").locator(`[data-share="${operation}"]`).click();
}
async function freezeWindow(width, height, mode) {
	await bounded(
		app.evaluate(
			({ BrowserWindow }, geometry) => {
				BrowserWindow.getAllWindows()[0].setContentSize(geometry.width, geometry.height);
			},
			{ width, height },
		),
		"调整专用窗口",
	);
	await bounded(
		page.evaluate((appearance) => {
			const themes = window.flowerTheme;
			themes.apply({ ...themes.saved, mode: appearance });
		}, mode),
		"应用验收配色",
	);
	await page.waitForFunction(
		({ width, mode }) => innerWidth === width && document.documentElement.dataset.scheme === mode,
		{ width, mode },
	);
}

try {
	await boot();
	step("经首发建立两轮对话");
	await bounded(
		page.evaluate(
			(baseUrl) =>
				window.flower.saveModel({ serviceId: "", name: "本机回环", baseUrl, modelId: "local-test", apiKey: "" }),
			fixture.baseUrl,
		),
		"配置回环模型",
	);
	await by("workspace").click();
	await until(async () => Boolean((await state()).draft), "临时会话选定工作区");
	await send(firstPrompt);
	await task(firstPrompt).locator(".status").filter({ hasText: "已完成" }).waitFor();
	await send(secondPrompt);
	await task(secondPrompt).locator(".status").filter({ hasText: "已完成" }).waitFor();
	await task(secondPrompt).locator(".turn-changes").waitFor();
	const session = (await state()).selected;
	const history = await bounded(
		page.evaluate((id) => window.flower.history(id), session),
		"读取两轮历史",
	);
	assert.equal(history.length, 2);
	assert.equal(history[1].artifacts.length, 1);
	const artifact = history[1].artifacts[0];

	step("Markdown 剪贴板和原生 HTML 保存路径");
	await share("markdown");
	const markdown = await until(async () => {
		const value = await bounded(
			app.evaluate(({ clipboard }) => clipboard.readText()),
			"读取原生文本剪贴板",
		);
		return value.includes(firstPrompt) && value;
	}, "Markdown 写剪贴板");
	for (const expected of [firstPrompt, firstReply, secondPrompt, secondReply]) assert(markdown.includes(expected));
	await writeFile(join(evidence, "复制的会话.md"), markdown, "utf8");
	await share("html");
	await until(() => stat(htmlPath).catch(() => undefined), "HTML 文件出现");
	const html = await readFile(htmlPath, "utf8");
	assert.match(html, /<strong>差额<\/strong>/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script\b|<img\s/i);
	for (const expected of [firstPrompt, secondPrompt, secondReply]) assert(html.includes(expected));
	const save = (await QA()).saved.find(({ path }) => path === htmlPath);
	assert.match(save.title, /HTML/);
	assert.deepEqual(save.filters[0].extensions, ["html"]);
	verifies.push("真实会话菜单经 Electron 剪贴板写 Markdown，经原生保存选择流程写离线 HTML");

	step("按单条可见消息选中首轮助手回复和第二轮用户问题");
	assert.equal(await page.locator("#timeline .tier3-select-message input:visible").count(), 0);
	await share("image");
	await task(firstPrompt).getByRole("checkbox", { name: "选择助手回复" }).check();
	await task(secondPrompt).getByRole("checkbox", { name: "选择提问" }).check();
	assert(!(await task(firstPrompt).getByRole("checkbox", { name: "选择提问" }).isChecked()));
	assert(!(await task(secondPrompt).getByRole("checkbox", { name: "选择助手回复" }).isChecked()));
	assert.equal(await by("conversation-selection-count").textContent(), "已选 2 条");
	const outlined = await bounded(
		page.evaluate(() => {
			const ids = [...document.querySelectorAll("#timeline .tier3-select-message input:checked")].map((node) => ({
				requestId: node.closest("[data-request]").dataset.request,
				kind: node.dataset.kind,
				index: Number(node.dataset.index),
			}));
			return window.flower.state().then(({ selected }) => window.flower.sessionImageContent(selected, ids));
		}),
		"校验界面实际选中的消息归属",
	);
	assert.equal(outlined.title, "对话摘选");
	assert.deepEqual(
		outlined.segments.map(({ role, text }) => [role, text.split("\n")[0]]),
		[
			["Flower", firstReply],
			["你", secondPrompt],
		],
	);
	assert(!JSON.stringify(outlined).includes(firstPrompt));
	assert(!JSON.stringify(outlined).includes(secondReply));
	await freezeWindow(660, 760, "dark");
	await page.screenshot({ path: join(evidence, "单条消息勾选-660深色.png") });
	await by("conversation-selection-copy").click();
	const image = await until(
		() =>
			bounded(
				app.evaluate(async ({ clipboard, nativeImage }) => {
					const mime = "image/png";
					const items = await clipboard.read();
					const item = items.find(({ types }) => types.includes(mime));
					if (!item) return null;
					const blob = await item.getType(mime);
					const bytes = Buffer.from(await blob.arrayBuffer());
					return { size: nativeImage.createFromBuffer(bytes).getSize(), png: bytes.toString("base64") };
				}),
				"读取原生 PNG 剪贴板",
			),
		"图片写剪贴板",
	);
	assert.equal(image.size.width, 960);
	assert(image.size.height > 60);
	const png = Buffer.from(image.png, "base64");
	assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	assert.equal(png.readUInt32BE(16), image.size.width);
	assert.equal(png.readUInt32BE(20), image.size.height);
	await by("conversation-selection").waitFor({ state: "hidden" });
	assert.equal(await page.locator("#timeline .tier3-select-message input:visible").count(), 0);
	await writeFile(join(evidence, "原生剪贴板图片.png"), png);
	results.image = {
		size: image.size,
		sha256: createHash("sha256").update(png).digest("hex"),
		segments: outlined.segments,
	};
	verifies.push("真实复选框分别选首轮助手回复和第二轮用户问题，选中数据无对应未选文本，从系统剪贴板回读 PNG");
	await by("composer-add").click();
	await by("paste-clipboard-image").click();
	const pasted = await until(
		async () =>
			(await state()).sessions.find(({ id }) => id === session)?.attachments.find(({ name }) => name === "截图 1.png"),
		"真实系统剪贴板图片导入",
	);
	await bounded(
		page.evaluate(({ id, attachment }) => window.flower.removeAttachment(id, attachment), {
			id: session,
			attachment: pasted.id,
		}),
		"移除本轮测试草稿图片",
	);
	verifies.push("同一系统剪贴板 PNG 也可从输入框菜单粘贴成真实草稿附件");

	step("回退预览范围和当前文件");
	await task(firstPrompt).getByRole("button", { name: "修订此轮消息" }).click();
	await by("turn-revision-menu").locator('[data-revision="rewind"]').click();
	await by("turn-revision").waitFor();
	assert.match(await by("turn-revision-impact").textContent(), /保留|后续/);
	const revisionFile = by("turn-revision-files").locator(".tier3-file");
	const fileSummary = revisionFile.locator(".tier3-file-summary");
	assert.equal(await fileSummary.locator(".tier3-file-name").textContent(), basename(artifact));
	assert.equal(await fileSummary.getAttribute("title"), artifact);
	const fullPath = revisionFile.locator(".tier3-file-full-path");
	assert(await fullPath.isHidden());
	await fileSummary.press("Enter");
	await fullPath.waitFor();
	assert.equal(await fullPath.textContent(), artifact);
	await fileSummary.press("Space");
	await fullPath.waitFor({ state: "hidden" });
	assert(await by("turn-revision-undo").isVisible());
	assert(!(await by("turn-revision-undo").isChecked()));
	await page.screenshot({ path: join(evidence, "回退预览-660深色.png") });
	await by("turn-revision-cancel").click();
	assert.equal((await state()).selected, session);
	assert.equal(await page.locator("article.task").count(), 2);
	assert((await stat(join(workspace, artifact))).isFile());
	verifies.push("回退预览列出后续受影响文件，默认保留文件，取消后原会话和文件完整");

	step("结构化问题键盘单选和多选");
	await send(questionPrompt);
	await by("ask-user").waitFor();
	assert(await by("answer-question").isDisabled());
	const radio = by("ask-user").getByRole("radio", { name: "原始预算", exact: true });
	await radio.focus();
	await page.keyboard.press("ArrowRight");
	assert(await by("ask-user").getByRole("radio", { name: "调整后预算", exact: true }).isChecked());
	const option = by("ask-user").getByRole("checkbox", { name: /数据来源与原始附件/ });
	await option.focus();
	await page.keyboard.press("Space");
	assert(await option.isChecked());
	const bounds = await by("ask-user").boundingBox();
	assert(bounds.x >= 0 && bounds.x + bounds.width <= 660 && bounds.y + bounds.height <= 760);
	await page.screenshot({ path: join(evidence, "结构化提问-660深色.png") });
	await by("answer-question").press("Enter");
	await by("ask-user").waitFor({ state: "hidden" });
	await task(questionPrompt).getByText(questionReply, { exact: true }).waitFor();
	assert.deepEqual(seenAnswers, [
		{
			status: "answered",
			answers: [
				{ question: questions[0].question, selected: ["调整后预算"] },
				{ question: questions[1].question, selected: [questions[1].options[1]] },
			],
		},
	]);
	verifies.push("660 深色窗使用键盘单选与多选，模型回环收到同一轮真实工具结果");

	step("非 Git 工作区撤销");
	await freezeWindow(1180, 790, "light");
	const changes = task(secondPrompt).locator(".turn-changes");
	await changes.locator("summary").click();
	await changes.getByText("新建 · 可撤销", { exact: true }).waitFor();
	await page.screenshot({ path: join(evidence, "本轮文件变更-浅色.png") });
	const before = await readFile(join(workspace, artifact), "utf8");
	await changes.getByRole("button", { name: /撤销本轮文件/ }).click();
	await changes.getByText("已撤销", { exact: true }).waitFor();
	await assert.rejects(stat(join(workspace, artifact)), { code: "ENOENT" });
	assert.equal(await readFile(join(workspace, "用户原有资料.txt"), "utf8"), "保留这份文件。");
	const outcome = await bounded(
		page.evaluate(({ id, requestId }) => window.flower.turnChanges(id, requestId), {
			id: session,
			requestId: history[1].requestId,
		}),
		"读取撤销结果",
	);
	assert.equal(outcome.files[0].status, "undone");
	assert.equal(await readFile(join(workspace, outcome.files[0].recoveryPath, basename(artifact)), "utf8"), before);
	verifies.push("真实写入产物通过非 Git 文件卡和确认框撤销，恢复位置字节相同，原有资料保留");

	step("旧版便携应用更新迁移说明");
	await by("theme-open").click();
	await by("settings-update").click();
	await by("desktop-update").waitFor();
	const update = await page.evaluate(() => window.flower.desktopUpdateState());
	assert.equal(update.phase, "unavailable");
	await by("desktop-update-feedback").filter({ hasText: "请改用最新版 Flower Desktop 启动器" }).waitFor();
	assert((await by("desktop-update-version").textContent()).includes(update.currentVersion));
	assert.equal(await by("desktop-update-source").count(), 0);
	assert(await by("desktop-update-check").isHidden());
	assert(await by("desktop-update-restart").isHidden());
	assert(await by("desktop-update-schedule").isHidden());
	await page.screenshot({ path: join(evidence, "应用更新-旧便携迁移.png") });
	await by("settings-close-dialog").click();
	verifies.push("旧版便携应用显示原版本及新版启动器迁移说明，工作台资料延续");
} catch (error) {
	results.failure = error.message;
	console.error(error);
	process.exitCode = 1;
} finally {
	await close();
	await fixture.close();
	await writeFile(join(evidence, "第三档专项验收.json"), JSON.stringify(results, null, 2), "utf8");
	globalThis.clearTimeout(watchdog);
}
