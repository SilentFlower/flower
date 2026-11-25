import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

const [binary, output, tooling] = process.argv.slice(2);
assert(process.platform === "win32" && tooling, "需要 Windows 应用、独立证据目录和 Playwright 路径。");
const evidence = resolve(output);
const profile = join(evidence, "profile");
const workspace = join(evidence, "首发工作区");
const external = join(evidence, "仓外附件.txt");
await mkdir(evidence);
await mkdir(workspace);
await writeFile(external, "仅供此轮首发核对。\n");

const { _electron: electron } = createRequire(join(resolve(tooling), "package.json"))("playwright");
const fixture = await startMockModel({
	attachmentReply: (messages) => ({
		text: JSON.stringify(messages).includes("仅供此轮首发核对") ? "已读取首发附件。" : "已收到消息。",
	}),
	titleReply: () => ({ text: "首发附件核对" }),
});
let application;
let page;
const watchdog = globalThis.setTimeout(() => {
	application?.process().kill();
	process.exit(2);
}, 80_000);

async function boot() {
	application = await electron.launch({ executablePath: resolve(binary), args: [`--user-data-dir=${profile}`] });
	page = await application.firstWindow();
	page.setDefaultTimeout(12_000);
	await application.evaluate(
		({ app, dialog, BrowserWindow }, input) => {
			if (app.getPath("userData").toLowerCase() !== input.profile.toLowerCase()) throw new Error("验收资料路径不符");
			dialog.showOpenDialog = async (_owner, options) => ({
				canceled: false,
				filePaths: [options.properties.includes("openDirectory") ? input.workspace : input.external],
			});
			dialog.showMessageBox = async () => ({ response: 0 });
			BrowserWindow.getAllWindows()[0].setContentSize(1180, 790);
		},
		{ profile, workspace, external },
	);
	await page.locator("#workspace:not(:disabled)").waitFor();
}

async function shutdown() {
	if (!application) return;
	const owned = application;
	application = undefined;
	await Promise.race([owned.close(), delay(5000, undefined, { ref: false }).then(() => owned.process().kill())]);
}

const by = (id) => page.locator(`#${id}`);
const state = () => page.evaluate(() => window.flower.state());
const attachment = () => page.getByRole("button", { name: "预览附件：仓外附件.txt", exact: true });
async function attach() {
	await by("composer-add").click();
	await by("file").click();
	await attachment().waitFor();
}

try {
	await boot();
	await by("new-session").press("Enter");
	await page.waitForFunction(() => document.activeElement.id === "prompt");
	assert.equal((await state()).sessions.length, 0);
	await by("prompt").fill("核对首发材料的内容");
	await by("send").click();
	await page.waitForFunction(() => window.flower.state().then(({ draft }) => Boolean(draft)));
	const first = (await state()).draft.id;
	assert.equal(await by("prompt").inputValue(), "核对首发材料的内容");
	await attach();
	await by("send").click();
	await by("model-dialog").waitFor();
	assert.equal((await state()).sessions.length, 0);
	assert.equal(await by("prompt").inputValue(), "核对首发材料的内容");
	await page.keyboard.press("Escape");
	await by("model-dialog").waitFor({ state: "hidden" });
	await by("new-session").click();
	await page.waitForFunction((id) => window.flower.state().then(({ draft }) => draft?.id !== id), first);
	const second = (await state()).draft.id;
	assert.equal(await by("prompt").inputValue(), "");
	await by("new-session").press("Enter");
	await by("new-session").press("Enter");
	await page.waitForFunction(() => document.activeElement.id === "prompt");
	assert.equal((await state()).draft.id, second);
	assert.equal((await state()).sessions.length, 0);
	await by("sidebar-back").press("Enter");
	await attachment().waitFor();
	assert.equal((await state()).draft.id, first);
	assert.equal(await by("prompt").inputValue(), "核对首发材料的内容");
	await page.screenshot({ path: join(evidence, "首发前草稿.png") });
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(660, 615));
	assert(await by("prompt").isVisible());
	assert(await by("send").isVisible());
	await page.screenshot({ path: join(evidence, "首发前草稿-窄窗.png") });
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 790));
	await page.evaluate(
		(baseUrl) => window.flower.saveModel({ serviceId: "", baseUrl, modelId: "local-test", apiKey: "" }),
		fixture.baseUrl,
	);
	await page.waitForFunction(() => document.querySelector("#send").title === "提交任务");
	await by("send").evaluate((button) => {
		button.click();
		button.click();
	});
	await page.getByText("已读取首发附件。", { exact: true }).waitFor();
	await page.waitForFunction(() => window.flower.state().then(({ sessions }) => sessions[0]?.title === "首发附件核对"));
	assert.equal((await state()).sessions.length, 1);
	assert.equal((await state()).selected, first);
	assert.equal((await state()).draft, undefined);
	assert.equal(fixture.observations.model.length, 1);
	await page.screenshot({ path: join(evidence, "首发后会话.png") });
	await by("new-session").click();
	await by("prompt").fill("关窗前的未发送草稿");
	await attach();
	assert.equal((await state()).sessions.length, 1);
	await shutdown();
	await boot();
	await page.getByText("已读取首发附件。", { exact: true }).waitFor();
	assert.equal((await state()).sessions.length, 1);
	assert.equal((await state()).selected, first);
	assert.equal((await state()).draftIds.length, 0);
	assert.equal(fixture.observations.model.length, 1);
	await writeFile(
		join(evidence, "首发验收.json"),
		JSON.stringify(
			{
				first,
				second,
				retained: 1,
				modelCalls: 1,
				screenshots: ["首发前草稿.png", "首发前草稿-窄窗.png", "首发后会话.png"],
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	await shutdown();
	await fixture.close();
	globalThis.clearTimeout(watchdog);
}
