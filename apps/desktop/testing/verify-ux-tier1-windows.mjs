import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

const [productArg, evidenceArg, toolingArg, bookArg] = process.argv.slice(2);
assert(
	process.platform === "win32" && bookArg,
	"用法：verify-ux-tier1-windows.mjs <正式 EXE> <新证据目录> <Playwright> <orders.xlsx>",
);
const evidence = resolve(evidenceArg);
const workspace = join(evidence, "第一档工作区");
const profile = join(evidence, "local-profile");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
await mkdir(workspace);
await copyFile(resolve(bookArg), join(workspace, "orders.xlsx"));
await writeFile(join(workspace, "notes.txt"), "行动项：核对库存清单。\n");
// 8×8 的红色 PNG，用于回复内联图片。
await writeFile(
	join(workspace, "chart.png"),
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAD///9BHTQRAAAAEUlEQVQI12P4z8DwHwYZGBgAJ9wD/ZJxP6oAAAAASUVORK5CYII=",
		"base64",
	),
);

const pastedLines = Array.from({ length: 25 }, (_, index) => `粘贴第 ${index + 1} 行｜金额 ${index * 10}`);
const seen = { pasted: false, cancelRuns: 0 };
const fixture = await startMockModel({
	attachmentReply(messages) {
		const text = (message) =>
			typeof message.content === "string"
				? message.content
				: (message.content ?? []).map((part) => part.text ?? "").join("\n");
		const prompt = text(messages.findLast(({ role }) => role === "user"));
		const afterTool = messages.at(-1).role === "tool";
		if (messages.some((message) => text(message).includes(pastedLines[24]))) seen.pasted = true;
		if (prompt.includes("取消用例") && seen.cancelRuns++ === 0)
			return { reasoning: ["先等待外部数据。", "仍在等待。"], reasoningDelay: 60000, text: "不会到达" };
		if (prompt.includes("读取说明") && !afterTool)
			return {
				reasoning: ["先读取说明文件，确认行动项。", "然后整理结论。"],
				// 后台用例留出时间切走并让窗口离开前台。
				reasoningDelay: prompt.includes("后台") ? 5000 : 1500,
				toolCall: { name: "read_text_file", args: { path: "notes.txt" } },
			};
		if (prompt.includes("读取说明"))
			return { text: "已读取 [说明](notes.txt)，数据见 `orders.xlsx`。\n\n![趋势](chart.png)\n\n完成：核对库存清单。" };
		return { text: "已完成。" };
	},
});

const results = [];
let app;
let page;
const step = (name) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}`);
// 任何一步卡住时结束本次启动的应用进程，避免残留在私有桌面。
const watchdog = globalThis.setTimeout(() => {
	console.error("验收超时，结束应用进程");
	app?.process().kill();
	process.exit(2);
}, 300_000);
async function until(test, message = "等待 Windows 状态超时") {
	for (let i = 0; i < 300; i++) {
		const value = await test();
		if (value) return value;
		await setTimeout(100);
	}
	assert.fail(message);
}
/** 关闭应用；若仍有任务，确认框选择「仍然关闭」，超时则直接结束进程。 */
async function shutdown() {
	await limit(
		app.evaluate(() => {
			globalThis.flowerQA.answers = [0, 0];
		}),
		"设置关窗确认",
	).catch(() => {});
	await limit(app.close(), "关闭应用").catch(() => app.process().kill());
	app = undefined;
}
async function boot() {
	app = await electron.launch({
		executablePath: resolve(productArg),
		chromiumSandbox: true,
		timeout: 30000,
		args: [`--user-data-dir=${profile}`, "--force-device-scale-factor=1"],
	});
	page = await app.firstWindow();
	// 在主进程替换系统接口，记录通知、菜单、对话框与文件定位，不真正弹出。
	await app.evaluate(({ BrowserWindow, Menu, Notification, dialog, shell }, root) => {
		const qa = { notices: [], menus: [], flashes: [], reveals: [], boxes: [], answers: [], pick: "" };
		globalThis.flowerQA = qa;
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
		dialog.showMessageBox = async (_window, options) => {
			qa.boxes.push(options.message);
			return { response: qa.answers.shift() ?? 1 };
		};
		shell.showItemInFolder = (path) => qa.reveals.push(path);
		const show = Notification.prototype.show;
		Notification.prototype.show = function () {
			const record = { title: this.title, body: this.body, instance: this };
			qa.notices.push(record);
			this.once("show", () => {
				record.shown = true;
			});
			this.once("failed", (_event, error) => {
				record.failed = String(error);
			});
			return show.call(this);
		};
		const flash = BrowserWindow.prototype.flashFrame;
		BrowserWindow.prototype.flashFrame = function (value) {
			qa.flashes.push(value);
			return flash.call(this, value);
		};
		Menu.buildFromTemplate = (template) => ({
			popup(options) {
				qa.menus.push(template.map((item) => item.label ?? item.type));
				template.find((item) => item.label === qa.pick)?.click?.();
				qa.pick = "";
				options?.callback?.();
			},
		});
	}, workspace);
	await page.waitForFunction(() => window.flower && document.querySelector("#prompt"));
}
const limit = (promise, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => globalThis.setTimeout(() => reject(new Error(`${label} 超时`)), 20_000)),
	]);
const qa = (read) => limit(app.evaluate(read), "主进程调用");
const state = () =>
	limit(
		page.evaluate(() => window.flower.state()),
		"读取状态",
	);
const task = (text) => page.locator(".task").filter({ hasText: text }).last();
async function send(text) {
	await page.locator("#prompt").fill(text);
	await page.locator("#send").click();
}

try {
	await boot();
	// 首次提交依次选择工作区、配置模型。
	await page.locator("#prompt").fill("读取说明");
	await page.locator("#send").click();
	await until(async () => (await state()).selected);
	if (await page.locator("#send").isEnabled()) await page.locator("#send").click();
	await page.locator("#model-dialog").waitFor();
	await page.locator("#base-url").fill(fixture.baseUrl);
	await page.locator("#model-id").fill(fixture.modelId);
	await page.locator("#save-settings").click();
	await page.locator("#model-form").waitFor({ state: "hidden" });
	if (await page.locator("#model-dialog").isVisible()) await page.locator("#settings-close-dialog").click();
	await page.waitForFunction((id) => document.querySelector("#model").textContent === id, fixture.modelId);
	if (!(await page.locator(".task").count())) await page.locator("#send").click();
	const first = task("读取说明");
	await first.locator(".reasoning-preview").filter({ hasText: "先读取说明文件，确认行动项。" }).waitFor();
	await page.screenshot({ path: join(evidence, "运行中推理.png") });
	await first.locator('.status[data-state="succeeded"]').waitFor();
	const summary = await first.locator(".step-list summary").innerText();
	assert.match(summary, /^已处理 \d+ 秒 · 读取 1 个文件$/);
	assert.equal(await first.locator(".step-list").evaluate((node) => node.open), false);
	assert.equal(await first.locator(".reasoning-preview").isHidden(), true);
	results.push(`运行中显示最新一句推理，结束后折叠为「${summary}」`);

	// 回复中的路径与图片
	step("回复中的路径与图片");
	await until(() => first.locator(".markdown-image").evaluate((node) => node.naturalWidth > 0));
	await first.locator('[data-workspace-path="notes.txt"]').click();
	await page.locator("#workspace-panel").waitFor();
	await page.locator("#workspace-panel").getByText("行动项：核对库存清单").waitFor();
	await app.evaluate(() => {
		globalThis.flowerQA.pick = "在资源管理器中显示";
	});
	await first.locator('code[data-workspace-path="orders.xlsx"]').click({ button: "right" });
	await until(() => qa(() => globalThis.flowerQA.reveals.length));
	const revealed = await qa(() => globalThis.flowerQA.reveals[0]);
	assert.match(revealed, /orders\.xlsx$/);
	await page.screenshot({ path: join(evidence, "回复路径与图片.png") });
	results.push(`回复路径可预览，图片内联显示，右键在资源管理器中显示 ${revealed}`);

	// 原生右键菜单
	step("原生右键菜单");
	await page.locator("#prompt").fill("右键测试");
	await page.locator("#prompt").click({ button: "right" });
	await until(() => qa(() => globalThis.flowerQA.menus.at(-1)?.includes("粘贴")));
	assert.deepEqual(await qa(() => globalThis.flowerQA.menus.at(-1)), ["剪切", "复制", "粘贴", "separator", "全选"]);
	await first.locator(".markdown-reply p").last().selectText();
	await first.locator(".markdown-reply p").last().click({ button: "right" });
	// 第二档起回复选区改用复制、引用、侧边追问菜单。
	await until(
		async () =>
			JSON.stringify(await qa(() => globalThis.flowerQA.menus.at(-1))) === '["复制","separator","引用","侧边追问"]',
	);
	await page.locator("#prompt").fill("");
	results.push("输入框与回复选区的右键菜单项正确");

	// 历史召回与长粘贴
	step("历史召回与长粘贴");
	await page.locator("#prompt").focus();
	await page.keyboard.press("ArrowUp");
	assert.equal(await page.locator("#prompt").inputValue(), "读取说明");
	await page.keyboard.press("Escape");
	assert.equal(await page.locator("#prompt").inputValue(), "");
	await page.locator("#prompt").evaluate((node, text) => {
		const data = new DataTransfer();
		data.setData("text/plain", text);
		node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
	}, pastedLines.join("\r\n"));
	await page.locator("#attachment").getByText("粘贴的文本（25 行）.txt").waitFor();
	assert.equal(await page.locator("#prompt").inputValue(), "");
	await send("总结粘贴的内容");
	await task("总结粘贴的内容").locator('.status[data-state="succeeded"]').waitFor();
	assert(seen.pasted, "模型请求缺少粘贴附件的正文");
	results.push("↑/Esc 召回并恢复草稿；25 行粘贴转为附件并进入模型请求");

	// 运行中关窗确认、取消后重试与编辑
	step("运行中关窗确认、取消后重试与编辑");
	await send("取消用例");
	const cancelling = task("取消用例");
	await cancelling.locator('.status[data-state="running"]').waitFor();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
	await until(() => qa(() => globalThis.flowerQA.boxes.length));
	assert.match(await qa(() => globalThis.flowerQA.boxes[0]), /还有 1 个任务未完成/);
	await setTimeout(300);
	assert.equal(await cancelling.locator(".status").getAttribute("data-state"), "running");
	await cancelling.getByRole("button", { name: "取消任务" }).click();
	await cancelling.locator('.status[data-state="cancelled"]').waitFor();
	await cancelling.getByRole("button", { name: "重试" }).click();
	await page.locator(".task").filter({ hasText: "取消用例" }).locator('.status[data-state="succeeded"]').waitFor();
	assert.equal(await page.locator(".task").filter({ hasText: "取消用例" }).count(), 2);
	// 重试新增了一轮，原来已取消的那条仍保留「编辑」。
	await page.locator('.task[data-status="cancelled"]').getByRole("button", { name: "编辑" }).click();
	await until(async () => (await page.locator("#prompt").inputValue()) === "取消用例", "编辑未放回原文");
	await page.locator("#prompt").fill("");
	results.push("运行中关窗先确认，取消后窗口与任务保留；取消的请求可重试与放回输入框");

	// 侧栏状态与后台通知
	step("侧栏状态与后台通知");
	const firstSession = (await state()).selected;
	await page.locator("#new-session").click();
	await until(async () => (await state()).selected !== firstSession);
	const second = (await state()).selected;
	await send("读取说明（后台）");
	await until(async () => (await state()).sessions.some(({ id }) => id === second), "首发未创建侧栏会话");
	const firstTitle = (await state()).sessions.find(({ id }) => id === firstSession).title;
	await page.locator(`.session-row[title="${firstTitle}"]`).click();
	await until(async () => (await state()).selected === firstSession);
	step("已切回第一个会话");
	await until(async () => (await state()).sessions.find(({ id }) => id === second)?.indicator === "running");
	// 私有桌面无法切换真实前台窗口，在主进程模拟窗口处于后台；前台时不通知的分支由上一段已覆盖。
	const before = (await qa(() => globalThis.flowerQA.notices.length)) ?? 0;
	assert.equal(before, 0, "窗口在前台时不应弹出通知");
	await qa(({ BrowserWindow }) => {
		globalThis.flowerQA.isFocused = BrowserWindow.prototype.isFocused;
		BrowserWindow.prototype.isFocused = () => false;
	});
	const focused = await qa(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());
	const seenIndicators = new Set();
	await until(async () => {
		const indicator = (await state()).sessions.find(({ id }) => id === second)?.indicator;
		if (indicator) seenIndicators.add(indicator);
		return indicator === "done";
	}, "后台会话未标为完成未读");
	step(`后台会话状态：${[...seenIndicators].join(" → ")}；窗口前台：${focused}`);
	await until(() => qa(() => globalThis.flowerQA.notices.some(({ body }) => body === "任务已完成")));
	const notice = await qa(() => {
		const record = globalThis.flowerQA.notices.findLast(({ body }) => body === "任务已完成");
		return {
			title: record.title,
			shown: record.shown,
			failed: record.failed,
			flashed: globalThis.flowerQA.flashes.includes(true),
		};
	});
	assert(notice.flashed, "未闪烁任务栏");
	await app.evaluate(() =>
		globalThis.flowerQA.notices.findLast(({ body }) => body === "任务已完成").instance.emit("click"),
	);
	await until(async () => (await state()).selected === second, "点击通知未回到会话");
	await qa(({ BrowserWindow }) => {
		BrowserWindow.prototype.isFocused = globalThis.flowerQA.isFocused;
	});
	await until(async () => !(await state()).sessions.find(({ id }) => id === second)?.indicator, "查看后未清除未读");
	results.push(
		`后台完成（模拟窗口在后台）：侧栏 ${[...seenIndicators].join(" → ")}，任务栏闪烁；系统通知${notice.shown ? "已显示" : notice.failed ? `显示失败（${notice.failed}）` : "未收到显示回执"}，点击回到会话并清除未读`,
	);

	// 窗口状态
	step("侧栏折叠定位、细滚动条与右栏样式");
	if (!(await page.locator("#sessions-collapse").isVisible())) await page.locator("#sidebar-view").click();
	await page.locator("#sessions-collapse").waitFor();
	if ((await page.locator("#sessions-collapse").getAttribute("title")) === "全部折叠")
		await page.locator("#sessions-collapse").click();
	assert.equal(await page.locator("#sessions-collapse").getAttribute("title"), "全部展开");
	assert.equal(await page.locator(".session-row:visible").count(), 0);
	await page.locator("#sessions-locate").click();
	await until(() =>
		page.evaluate(
			() =>
				document.activeElement?.classList.contains("session-row") &&
				document.activeElement.getAttribute("aria-current") === "true",
		),
	);
	assert.equal(await page.locator("#sessions-collapse").getAttribute("title"), "全部折叠");
	// 标准属性 scrollbar-width 会让自定义滑块失效，三个滚动区都应使用自动隐藏的细滚动条。
	const scrollers = await page.evaluate(() =>
		["#sidebar-scroll", "#thread-scroll", "#workspace-panel-view"].map((selector) => {
			const node = document.querySelector(selector);
			return [node.classList.contains("soft-scroll"), getComputedStyle(node).scrollbarWidth];
		}),
	);
	assert.deepEqual(scrollers, [
		[true, "auto"],
		[true, "auto"],
		[true, "auto"],
	]);
	await page.locator("#thread-scroll").evaluate((node) => {
		node.scrollTop = node.scrollHeight / 3;
	});
	await page.screenshot({ path: join(evidence, "细滚动条-主会话.png") });
	if (await page.locator("#workspace-panel").isHidden()) await page.locator("#workspace-panel-toggle").click();
	// 前面预览过 notes.txt，返回上一级回到文件列表。
	if (await page.locator("#panel-up").isVisible()) await page.locator("#panel-up").click();
	await page.locator("#workspace-panel .panel-file-row").first().waitFor();
	const tones = await page.evaluate(() =>
		Object.fromEntries(
			[...document.querySelectorAll("#workspace-panel .panel-file-row")].map((row) => [
				row.dataset.ext || row.dataset.kind,
				getComputedStyle(row.querySelector(".icon")).color,
			]),
		),
	);
	assert.notEqual(tones.png, tones.txt);
	assert.notEqual(tones.xlsx, tones.txt);
	await page.screenshot({ path: join(evidence, "右栏文件.png") });
	results.push(
		`工作区模式下全部折叠、定位当前会话可用；三个滚动区使用自动隐藏细滚动条；右栏图标按类型着色 ${JSON.stringify(tones)}`,
	);

	step("窗口状态");
	// 前面预览路径时已打开侧栏，先收起，确保外扩从未扩展的外框开始。
	if (await page.locator("#workspace-panel").isVisible()) {
		await page.locator("#workspace-panel-toggle").click();
		await page.locator("#workspace-panel").waitFor({ state: "hidden" });
	}
	await app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0];
		window.restore();
		window.setBounds({ x: 120, y: 90, width: 1250, height: 760 });
	});
	await setTimeout(900);
	await page.locator("#workspace-panel-toggle").click();
	await until(
		async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width)) > 1250,
	);
	await setTimeout(900);
	await shutdown();
	await boot();
	const restored = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
	for (const [key, expected] of Object.entries({ x: 120, y: 90, width: 1250, height: 760 }))
		assert(Math.abs(restored[key] - expected) <= 2, `${key}: ${restored[key]} ≠ ${expected}`);
	await page.locator(".session-row").first().click();
	await page
		.locator(".step-list summary")
		.filter({ hasText: /^已处理 .* · 读取 1 个文件$/ })
		.first()
		.waitFor();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
	await setTimeout(900);
	await shutdown();
	await boot();
	assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()));
	await page.screenshot({ path: join(evidence, "重启后最大化.png") });
	results.push(`窗口外框重启恢复为 ${JSON.stringify(restored)}（不含侧栏外扩），最大化状态保留；重启后步骤摘要仍在`);
	await shutdown();
	await writeFile(join(evidence, "第一档验收.json"), `${JSON.stringify({ results }, null, "\t")}\n`);
	console.log(results.join("\n"));
} catch (error) {
	// 先输出失败原因，再收尾，避免收尾卡住时看不到错误。
	console.error(error);
	process.exitCode = 1;
} finally {
	if (app) await shutdown();
	await fixture.close();
	globalThis.clearTimeout(watchdog);
}
