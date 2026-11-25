import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

const [entry, output, playwright] = process.argv.slice(2).map((part) => resolve(part));
const { _electron } = createRequire(join(playwright, "package.json"))("playwright");
const profile = join(output, "profile");
const store = join(profile, "local-workbench");
const workspace = join(output, "技能工作区");
const skill = join(output, "任意文件名的周报.md");
const received = [];
const fixture = await startMockModel({
	attachmentReply(messages) {
		const prompt = JSON.stringify(messages);
		const used = prompt.includes("WEEKLY-731");
		received.push(used);
		return { text: used ? "已读取周报技能 WEEKLY-731。" : "未读取周报技能。" };
	},
});
let app;

async function open() {
	app = await _electron.launch({
		executablePath: entry,
		args: [`--user-data-dir=${profile}`],
		chromiumSandbox: true,
		timeout: 45000,
	});
	const page = await app.firstWindow();
	await page.locator("#workspace:not(:disabled)").waitFor();
	await app.evaluate(
		({ dialog }, paths) => {
			dialog.showOpenDialog = async (_window, options) => ({
				canceled: false,
				filePaths: [options.properties.includes("openDirectory") ? paths.workspace : paths.skill],
			});
			dialog.showMessageBox = async () => ({ response: 0 });
		},
		{ workspace, skill },
	);
	return page;
}

async function showSkills(page) {
	await page.locator("#composer-add").click();
	await page.locator("#composer-local-extensions").click();
	await page.locator("#workbench[data-management='extensions'] #extension-settings").waitFor();
	assert.equal(
		await page.locator("#extension-filters [data-package-filter='skill']").getAttribute("aria-pressed"),
		"true",
	);
}

try {
	await mkdir(store, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await writeFile(join(store, "model.json"), JSON.stringify({ modelId: fixture.modelId, baseUrl: fixture.baseUrl }));
	await writeFile(
		skill,
		"---\nname: 周报核对\ndescription: 核对本周进展和风险\n---\n\n# 周报核对\n\n根据工作区资料汇总。内部校验标记 WEEKLY-731。\n",
	);
	let page = await open();
	await page.locator("#workspace").click();
	await showSkills(page);
	await page.locator("#extension-install").click();
	let row = page.locator("[data-extension]").filter({ hasText: "周报核对" });
	await row.getByText("已启用", { exact: false }).waitFor();
	await row.press("Enter");
	await page.locator("#extension-skill-text").getByText("WEEKLY-731", { exact: false }).waitFor();
	await page.screenshot({ path: join(output, "已安装周报技能.png") });
	await page.locator("#extension-detail").getByRole("button", { name: "用于本次对话" }).click();
	await page.locator("#composer-skill").getByText("周报核对", { exact: false }).waitFor();
	await page.locator("#prompt").fill("汇总本周进展。");
	await page.locator("#send").click();
	await page.getByText("已读取周报技能 WEEKLY-731。").waitFor();
	const primary = await page.evaluate(async () => (await window.flower.state()).selected);
	const history = await page.evaluate((id) => window.flower.history(id), primary);
	assert.equal(history[0].input, "汇总本周进展。");
	assert(history[0].skill);

	await page.locator("#sidebar-tools").click();
	await page.locator("#sidebar-automation").click();
	await page.locator("#automation-new").click();
	await page.locator("#automation-name").fill("周报自动化");
	await page.locator("#automation-prompt").fill("执行周报自动化。");
	await page.locator("#automation-skill-choice").press("ArrowDown");
	await page.locator("#automation-skill-choice-options").getByRole("option", { name: "周报核对" }).click();
	assert(await page.locator("#automation-overview").isHidden());
	assert(await page.locator("#automation-toolbar").isHidden());
	await page.screenshot({ path: join(output, "自动化选用技能.png") });
	await page.getByRole("button", { name: "保存计划", exact: true }).click();
	await page.locator("#automation-plans").getByRole("button", { name: "立即执行" }).click();
	await page.locator("#background-tasks").getByText("已读取周报技能 WEEKLY-731。").first().waitFor();
	const scheduled = await page.evaluate(async () => (await window.flower.automationState()).runs[0]);
	for (let attempt = 0; attempt < 60; attempt++) {
		const record = await page.evaluate(async () => (await window.flower.automationState()).runs[0]);
		if (record.status === "succeeded") break;
		await delay(150);
	}
	assert.equal((await page.evaluate(async () => (await window.flower.automationState()).runs[0])).status, "succeeded");

	await app.close();
	page = await open();
	await showSkills(page);
	row = page.locator("[data-extension]").filter({ hasText: "周报核对" });
	await row.press("Enter");
	const detail = page.locator("#extension-detail");
	await detail.getByRole("button", { name: "停用", exact: true }).click();
	await detail.getByRole("button", { name: "启用", exact: true }).waitFor();
	assert(await detail.getByRole("button", { name: "用于本次对话" }).isDisabled());
	await detail.getByRole("button", { name: "卸载", exact: true }).click();
	await page.locator("#confirm-apply").click();
	await row.waitFor({ state: "detached" });
	assert(received.filter(Boolean).length >= 2);
	await writeFile(
		join(output, "result.json"),
		JSON.stringify(
			{
				installed: "周报核对",
				session: primary,
				automation: scheduled.id,
				usedInModel: received.filter(Boolean).length,
				disabled: true,
				uninstalled: true,
				userMessage: history[0].input,
			},
			null,
			2,
		),
	);
} finally {
	await app?.close().catch(() => {});
	await fixture.close();
}
