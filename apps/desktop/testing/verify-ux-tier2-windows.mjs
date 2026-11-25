import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

const [productArg, evidenceArg, toolingArg] = process.argv.slice(2);
assert(
	process.platform === "win32" && toolingArg,
	"用法：verify-ux-tier2-windows.mjs <正式 EXE> <新证据目录> <Playwright>",
);
const evidence = resolve(evidenceArg);
const workspace = join(evidence, "第二档工作区");
const profile = join(evidence, "local-profile");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
await mkdir(workspace);
await writeFile(join(workspace, "notes.txt"), "行动项：核对二月预算。\n");
await writeFile(join(workspace, "FLOWER.md"), "# 采购部口径\n\n金额保留两位小数。\n");

const text = (message) =>
	typeof message.content === "string"
		? message.content
		: (message.content ?? []).map((part) => part.text ?? "").join("\n");
const systems = [];
const fixture = await startMockModel({
	attachmentReply(messages) {
		const system = text(messages.find(({ role }) => role === "system") ?? { content: "" });
		if (system.includes("生成 Flower 会话检查点")) return { text: "检查点：二月预算 500，报价 537。" };
		systems.push(system);
		const prompt = text(messages.findLast(({ role }) => role === "user"));
		if (prompt.includes("长任务"))
			return { reasoning: ["等待外部数据。", "仍在等待。"], reasoningDelay: 60000, text: "不会到达" };
		if (prompt.includes("改成二月")) return { text: "已按二月口径核对：差额 37。" };
		if (prompt.includes("侧边")) return { text: "侧边回答：差额来自报价与预算。" };
		const slow = prompt.includes("慢") ? { reasoning: ["先核对报价。", "再核对预算。"], reasoningDelay: 2500 } : {};
		return { ...slow, text: `回答「${prompt.slice(0, 16)}」：二月预算 500，报价 537。` };
	},
});

const results = [];
let app;
let page;
const step = (name) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}`);
const watchdog = globalThis.setTimeout(() => {
	console.error("验收超时，结束应用进程");
	app?.process().kill();
	process.exit(2);
}, 420_000);
async function until(test, message = "等待 Windows 状态超时") {
	for (let i = 0; i < 300; i++) {
		const value = await test();
		if (value) return value;
		await setTimeout(100);
	}
	assert.fail(message);
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
const task = (input) => page.locator(".task").filter({ hasText: input }).last();
async function send(input) {
	await page.locator("#prompt").fill(input);
	await page.locator("#send").click();
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
	// 在主进程替换系统接口，记录菜单与对话框，不真正弹出。
	await app.evaluate(({ Menu, dialog, shell }, root) => {
		const qa = { menus: [], boxes: [], answers: [], pick: "", reveals: [] };
		globalThis.flowerQA = qa;
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
		dialog.showMessageBox = async (_window, options) => {
			qa.boxes.push(options.message);
			return { response: qa.answers.shift() ?? 1 };
		};
		shell.showItemInFolder = (path) => qa.reveals.push(path);
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

try {
	await boot();
	// 首次提交选择工作区并配置模型。
	await page.locator("#prompt").fill("慢：核对二月预算");
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

	step("排队与插话");
	await task("慢：核对二月预算").locator('.status[data-state="running"]').waitFor();
	await send("补充三月的数据");
	await send("改成二月");
	await page.locator("#queue .queue-item").nth(1).waitFor();
	assert.equal(await page.locator(".task").count(), 1, "排队消息不应出现在时间线");
	await page.screenshot({ path: join(evidence, "排队.png") });
	await page.locator("#queue .queue-item").filter({ hasText: "改成二月" }).getByRole("button", { name: "插话" }).click();
	await task("慢：核对二月预算").locator(".steer-message").filter({ hasText: "改成二月" }).waitFor({ timeout: 20000 });
	await task("慢：核对二月预算").locator('.status[data-state="succeeded"]').waitFor({ timeout: 20000 });
	await task("补充三月的数据").locator('.status[data-state="succeeded"]').waitFor({ timeout: 20000 });
	assert.equal(await page.locator("#queue").isHidden(), true);
	await page.screenshot({ path: join(evidence, "插话气泡.png") });
	results.push("运行中发送的消息排在输入框上方；插话送达后以气泡显示在回复中，队首随后自动发送");

	step("回复选区右键菜单");
	const reply = task("慢：核对二月预算").locator(".markdown-reply p").first();
	const menusBefore = (await qa(() => globalThis.flowerQA.menus.length)) ?? 0;
	await reply.selectText();
	await app.evaluate(() => {
		globalThis.flowerQA.pick = "引用";
	});
	await reply.click({ button: "right" });
	await until(() => qa(() => globalThis.flowerQA.menus.length));
	await setTimeout(500);
	const menus = await qa(() => globalThis.flowerQA.menus);
	assert.deepEqual(menus.slice(menusBefore), [["复制", "separator", "引用", "侧边追问"]], "回复选区只应弹出一个菜单");
	await until(async () => (await page.locator("#prompt").inputValue()).startsWith("> "), "引用未插入输入框");
	await page.locator("#prompt").fill("");
	results.push("回复选区右键只弹出「复制、引用、侧边追问」一个菜单，原生默认菜单被拦下；选择「引用」后输入框出现引用块");

	step("文件行拖入输入框");
	if (await page.locator("#workspace-panel").isHidden()) await page.locator("#workspace-panel-toggle").click();
	const row = page.locator("#workspace-panel .panel-file-row").filter({ hasText: "notes.txt" });
	await row.waitFor();
	await row.dragTo(page.locator("#composer"));
	await page.locator("#attachment").getByText("notes.txt").waitFor({ timeout: 10000 });
	results.push("工作区文件面板的文件行可拖入输入框并成为附件");
	await page.locator("#attachment").getByRole("button", { name: /移除/ }).first().click();

	step("@ 补全");
	await page.locator("#prompt").focus();
	await page.keyboard.type("看 @no");
	await page.locator("#mention-list .mention-option").first().waitFor();
	await page.keyboard.press("Enter");
	await page.locator("#attachment").getByText("notes.txt").waitFor();
	assert.equal(await page.locator("#prompt").inputValue(), "看 ");
	await page.locator("#attachment").getByRole("button", { name: /移除/ }).first().click();
	await page.locator("#prompt").fill("");
	results.push("输入 @ 后补全工作区文件，回车加入附件并删除 @ 文字");

	step("侧边追问");
	await reply.selectText();
	await page.locator("#selection-actions [data-selection=side]").click();
	await page.locator("#side-chat-view").waitFor();
	assert.match(await page.locator("#side-chat-prompt").inputValue(), /^> /);
	await page.locator("#side-chat-prompt").fill("侧边：差额是怎么来的");
	await page.locator("#side-chat-send").click();
	await page.locator("#side-chat-timeline").getByText("侧边回答：差额来自报价与预算。").waitFor({ timeout: 20000 });
	assert.match(systems.at(-1), /当前是侧边追问/);
	await page.screenshot({ path: join(evidence, "侧边追问.png") });
	results.push("从回复选区打开右栏侧边追问，引用带入侧边输入框，得到回答且系统提示为只读侧边追问");

	step("侧边追问标签直接发送");
	await page.locator("#side-chat-close").click();
	await page.locator("#confirm-apply").click();
	await until(async () => !(await state()).sideChats.length, "侧边追问未关闭");
	assert.equal(await page.locator("#panel-side").isVisible(), true, "有当前会话时应显示侧边追问标签");
	await page.locator("#panel-side").click();
	assert.match(await page.locator("#side-chat-reference").innerText(), /发送第一条后/);
	await page.locator("#side-chat-prompt").fill("侧边：直接从标签提问");
	await page.locator("#side-chat-send").click();
	await page.locator("#side-chat-timeline").getByText("侧边回答：差额来自报价与预算。").waitFor({ timeout: 20000 });
	assert.match(await page.locator("#side-chat-reference").innerText(), /基于主会话已完成的 \d+ 轮对话/);
	results.push("未建立侧边追问时从右栏标签进入，发送第一条即新建并得到回答");

	step("全局指令");
	await page.locator("#theme-open").click();
	await page.locator("#settings-instructions").click();
	await page.locator("#instructions-text").fill("结论写在开头。");
	await page.getByRole("button", { name: "保存" }).last().click();
	await page
		.locator("#instructions-feedback")
		.getByText(/已保存/)
		.waitFor();
	await page.locator("#settings-close-dialog").click();
	await send("按口径再总结一次");
	await task("按口径再总结一次").locator('.status[data-state="succeeded"]').waitFor({ timeout: 20000 });
	assert.match(systems.at(-1), /【个人全局指令】\n结论写在开头。[\s\S]*【工作区约定（FLOWER\.md）】\n# 采购部口径/);
	results.push("保存全局指令后，下一轮系统提示依次包含个人指令与 FLOWER.md");

	step("手动压缩");
	await page.locator("#context-usage").focus();
	await page.locator("#context-compact").click();
	await page.locator(".toast").filter({ hasText: "已压缩上下文" }).waitFor({ timeout: 20000 });
	await page.locator(".compaction-divider:visible").first().waitFor({ timeout: 10000 });
	assert.equal(await page.locator(".compaction-divider:visible").first().innerText(), "以上对话已手动压缩为摘要");
	await page.screenshot({ path: join(evidence, "压缩分隔.png") });
	results.push("详情卡「压缩上下文」完成后出现 Toast 与时间线分隔「以上对话已手动压缩为摘要」");

	step("正文搜索与跳转");
	const sessionId = (await state()).selected;
	await page.locator("#new-session").click();
	await until(async () => (await state()).selected !== sessionId);
	const blank = (await state()).selected;
	assert.equal((await state()).draft.id, blank);
	await send("准备一条可删除的验收会话");
	await task("准备一条可删除的验收会话").locator('.status[data-state="succeeded"]').waitFor();
	assert.equal(await page.locator("#session-search-toggle").innerText(), "搜索");
	await page.keyboard.press("Control+K");
	assert.equal(await page.locator("#session-search").getAttribute("placeholder"), "搜索标题或内容…");
	await page.locator("#session-search").fill("差");
	await page.locator("#session-search-hint").waitFor();
	await page.locator("#session-search").fill("差额来自");
	assert.equal(await page.locator(".session-snippet").count(), 0, "侧边追问内容不应被搜到");
	await page.locator("#session-search").fill("二月口径");
	await page.locator(".session-snippet").first().click({ timeout: 10000 });
	await until(async () => (await state()).selected === sessionId);
	await until(() => page.evaluate(() => CSS.highlights.has("flower-search")), "命中关键词未高亮");
	await page.screenshot({ path: join(evidence, "搜索跳转.png") });
	await page.keyboard.press("Escape");
	results.push("侧栏「搜索」按正文命中显示片段，点击后切回会话并高亮关键词；侧边追问内容不被搜到");

	step("删除会话确认");
	const title = (await state()).sessions.find(({ id }) => id === sessionId).title;
	await page.evaluate((id) => window.flower.manageSidebar("session", id, "rename", "待删除会话"), blank);
	// 清空上一步的搜索词，侧栏恢复完整列表。
	await page.keyboard.press("Control+K");
	await page.locator("#session-search").fill("");
	await page.locator('.session-row[title="待删除会话"]').click({ button: "right" });
	await page.locator("#sidebar-options").getByRole("menuitem", { name: "删除会话" }).click();
	await page.locator("#sidebar-dialog").waitFor();
	assert.match(await page.locator("#sidebar-detail").innerText(), /删除后无法恢复/);
	await page.locator("#sidebar-apply").click();
	await until(async () => !(await state()).sessions.some(({ id }) => id === blank), "确认后会话未删除");
	assert.equal(await page.locator(".toast").filter({ hasText: "撤销" }).count(), 0, "不应再出现撤销提示");
	results.push("删除会话弹出确认框并注明无法恢复，确认后立即删除，不再出现撤销提示");

	step("中断恢复");
	await page.locator(`.session-row[title="${title}"]`).click();
	await until(async () => (await state()).selected === sessionId);
	await send("长任务：等待外部数据");
	await task("长任务：等待外部数据").locator('.status[data-state="running"]').waitFor();
	await shutdown();
	await boot();
	await page.locator("#interrupted-banner").waitFor({ timeout: 20000 });
	assert.match(await page.locator("#interrupted-title").innerText(), /1 个任务上次被中断/);
	await page.screenshot({ path: join(evidence, "中断横幅.png") });
	await page.locator(`.session-row[title="${title}"]`).click();
	await task("长任务：等待外部数据").getByRole("button", { name: "继续任务" }).waitFor();
	await page.locator("#interrupted-dismiss").click();
	await page.locator("#interrupted-banner").waitFor({ state: "hidden" });
	results.push("运行中关闭后重启，侧栏顶部列出被中断的会话；会话内按钮为「继续任务」，可忽略横幅");

	step("浮动开关与底部渐隐");
	const toggleBox = await page.locator("#workspace-panel-toggle").boundingBox();
	const chromeBox = await page.locator(".desktop-chrome").boundingBox();
	const bodyBox = await page.locator("#conversation-body").boundingBox();
	assert.ok(toggleBox.y >= chromeBox.y + chromeBox.height, "文件浏览器开关应在标题栏下方");
	assert.ok(bodyBox.y < toggleBox.y, "会话内容应从开关下方滚过，开关不占行");
	const scrollable = await page.locator("#thread-scroll").evaluate((node) => node.scrollHeight > node.clientHeight + 80);
	if (scrollable) {
		await page.locator("#thread-scroll").evaluate((node) => (node.scrollTop = 0));
		await until(async () => (await page.locator("#thread-scroll").getAttribute("data-more")) !== null, "回看时未渐隐");
		await page.screenshot({ path: join(evidence, "底部渐隐.png") });
		await page.locator("#thread-scroll").evaluate((node) => (node.scrollTop = node.scrollHeight));
		await until(async () => (await page.locator("#thread-scroll").getAttribute("data-more")) === null, "贴底时仍渐隐");
	}
	results.push(
		`文件浏览器开关浮在会话区右上角、不占行；${scrollable ? "回看时输入框上方渐隐，贴底时取消" : "会话较短，未触发渐隐"}`,
	);

	step("窄窗与深色");
	await app.evaluate(({ BrowserWindow, nativeTheme }) => {
		nativeTheme.themeSource = "dark";
		const window = BrowserWindow.getAllWindows()[0];
		window.unmaximize();
		window.setBounds({ x: 80, y: 60, width: 680, height: 760 });
	});
	await setTimeout(900);
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
	assert.equal(overflow, false, "窄窗出现横向滚动");
	await page.screenshot({ path: join(evidence, "窄窗深色.png") });
	results.push("680 像素窄窗、深色模式下页面无横向溢出");

	await shutdown();
	await writeFile(join(evidence, "第二档验收.json"), `${JSON.stringify({ results }, null, "\t")}\n`);
	console.log(results.join("\n"));
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	if (app) await shutdown();
	await fixture.close();
	globalThis.clearTimeout(watchdog);
}
