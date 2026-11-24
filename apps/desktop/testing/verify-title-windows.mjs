import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

// 会话自动标题与「用 AI 重命名」的 Windows 实机验收，模型为本机回环夹具。
const [productArg, evidenceArg, toolingArg] = process.argv.slice(2);
assert(
	process.platform === "win32" && toolingArg,
	"用法：verify-title-windows.mjs <正式 EXE> <新证据目录> <Playwright>",
);
const evidence = resolve(evidenceArg);
const workspace = join(evidence, "标题工作区");
const profile = join(evidence, "local-profile");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
await mkdir(workspace);
await writeFile(join(workspace, "notes.txt"), "二月预算 500，报价 537。\n");

const first = "请核对二月预算和报价的差额并生成汇总表";
const fixture = await startMockModel({
	attachmentReply: () => ({ text: "已核对：差额 37。" }),
	titleReply: async (body) => {
		if (body.includes("没有模型标题")) return { status: 500 };
		return { text: body.includes("<conversation>") ? "季度对账" : "“二月预算差额核对”。" };
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
	await page.locator("#prompt").fill(first);
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

	step("首条消息自动命名");
	await task(first).locator('.status[data-state="succeeded"]').waitFor({ timeout: 20000 });
	await page.locator('.session-row[title="二月预算差额核对"]').waitFor({ timeout: 20000 });
	assert.equal(await page.locator("#title").innerText(), "二月预算差额核对");
	assert.equal(fixture.observations.titles[0].reasoning, null);
	assert.match(
		fixture.observations.titles[0].body,
		/<user_message>\n请核对二月预算和报价的差额并生成汇总表\n<\/user_message>/,
	);
	await page.screenshot({ path: join(evidence, "首条命名.png") });
	results.push("新会话首条消息后侧栏与标题栏换成模型生成的标题，标题请求不带推理参数、消息在分隔符内");

	step("用 AI 重命名");
	await page.getByRole("button", { name: "会话操作：二月预算差额核对" }).click();
	await page.locator("#sidebar-options").getByRole("menuitem", { name: "用 AI 重命名" }).click();
	await page.locator('.session-row[title="季度对账"]').waitFor({ timeout: 20000 });
	await page.locator(".toast").filter({ hasText: "已重命名为「季度对账」。" }).waitFor();
	assert.match(fixture.observations.titles.at(-1).body, /<conversation>\n用户：请核对二月预算/);
	await page.screenshot({ path: join(evidence, "AI重命名.png") });
	results.push("会话菜单「用 AI 重命名」按整段对话改名并提示");

	step("新会话失败保留临时标题");
	await page.locator("#new-session").click();
	await until(async () => (await state()).sessions.length === 2);
	await send("这条消息没有模型标题");
	await task("这条消息没有模型标题").locator('.status[data-state="succeeded"]').waitFor({ timeout: 20000 });
	await until(() => fixture.observations.titles.some(({ body }) => body.includes("没有模型标题")));
	await setTimeout(500);
	assert.equal(await page.locator('.session-row[title="这条消息没有模型标题"]').count(), 1, "模型失败时应保留临时标题");
	results.push("模型生成标题失败时保留首条消息作为标题，无错误提示");

	await shutdown();
	await writeFile(join(evidence, "标题验收.json"), `${JSON.stringify({ results }, null, "\t")}\n`);
	console.log(results.join("\n"));
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	if (app) await shutdown();
	await fixture.close();
	globalThis.clearTimeout(watchdog);
}
