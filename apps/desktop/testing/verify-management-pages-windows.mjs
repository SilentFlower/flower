import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

const [entry, output, tooling] = process.argv.slice(2).map((part) => resolve(part));
assert(process.platform === "win32" && tooling, "需要 Windows 应用、独立证据目录和 Playwright 路径。");
const { _electron: electron } = createRequire(join(tooling, "package.json"))("playwright");
const profile = join(output, "profile");
const workspace = join(output, "管理页面工作区");
const otherWorkspace = join(output, "隔离工作区");
const skill = join(output, "核对周报.md");
const extension = join(output, "todo.json");
await mkdir(output);
await mkdir(workspace);
await mkdir(otherWorkspace);
await writeFile(join(workspace, "合成资料.txt"), "标题\nTODO 核对周报\n");
await writeFile(join(workspace, "重试资料.txt"), "TODO 重试路径通过\n");
await writeFile(
	skill,
	[
		"---",
		"name: 核对周报",
		"description: 核对每周进展和实际证据",
		"---",
		"",
		"# 周报复核说明",
		"",
		"- 完成情况",
		"- 待跟进事项",
		"",
		"```text",
		"WEEKLY-962",
		"```",
		"",
		'<img src="https://example.invalid/probe.png">',
	].join("\n"),
);
await writeFile(
	extension,
	JSON.stringify({
		schemaVersion: 1,
		id: "find-todo",
		name: "提取待办",
		description: "从文本核对待办事项",
		action: "find-lines",
		contains: "TODO",
	}),
);
const model = await startMockModel({
	titleReply: () => ({ text: "首个会话" }),
	attachmentReply: (messages) => ({
		text: JSON.stringify(messages).includes("WEEKLY-962") ? "已用核对周报技能。" : "管理页面验证回执。",
	}),
});
const site = createServer((_, response) =>
	response.writeHead(200, { "Content-Type": "text/html" }).end("<title>Flower panel QA</title><h1>Local test page</h1>"),
);
await new Promise((done) => site.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${site.address().port}/`;
let app;
let page;
const errors = [];
const by = (id) => page.locator(`#${id}`);
const state = () => page.evaluate(() => window.flower.state());
const shot = (name) => page.screenshot({ path: join(output, `${name}.png`) });

async function open() {
	app = await electron.launch({
		executablePath: entry,
		args: [`--user-data-dir=${profile}`, "--force-device-scale-factor=1"],
		chromiumSandbox: true,
		timeout: 45000,
	});
	page = await app.firstWindow();
	page.setDefaultTimeout(14000);
	page.on("pageerror", (error) => errors.push(error.message));
	await app.evaluate(
		({ app, BrowserWindow, dialog }, { profile, workspace, otherWorkspace, skill, extension }) => {
			if (app.getPath("userData").toLowerCase() !== profile.toLowerCase()) throw new Error("验收目录有误。");
			BrowserWindow.getAllWindows()[0].setContentSize(1282, 800);
			globalThis.flowerLibraryQA = { file: "skill", other: false };
			dialog.showOpenDialog = async (_, options) => {
				if (options.properties.includes("openDirectory"))
					return { canceled: false, filePaths: [globalThis.flowerLibraryQA.other ? otherWorkspace : workspace] };
				if (options.filters?.[0]?.extensions?.join(",") !== "md,json")
					throw new Error("导入窗口须同时支持 Markdown 和 JSON。");
				return { canceled: false, filePaths: [globalThis.flowerLibraryQA.file === "skill" ? skill : extension] };
			};
			dialog.showMessageBox = async () => ({ response: 0 });
		},
		{ profile, workspace, otherWorkspace, skill, extension },
	);
	await page.locator("#workspace:not(:disabled)").waitFor();
}

async function route(id, section, trigger = id) {
	await by(trigger).press("Enter");
	await page.waitForFunction((section) => document.getElementById("workbench").dataset.management === section, section);
	assert.equal(await page.locator("dialog[open]").count(), 0);
	assert(await by("prompt").isHidden());
	assert(await by("workspace-panel").isHidden());
	await by(id).waitFor();
}

const filter = (name) => by("extension-filters").getByRole("button", { name, exact: true });
const packageRow = (name) => by("extension-list").getByRole("button", { name, exact: true });

async function size(width) {
	await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width);
	await page.waitForFunction((width) => innerWidth === width, width);
}

async function checkAlignment() {
	const measured = await page.evaluate(() => {
		const back = document.getElementById("settings-close-dialog");
		const title = document.getElementById("automation-heading").getBoundingClientRect();
		return {
			width: innerWidth,
			backX: back.getBoundingClientRect().x + Number.parseFloat(getComputedStyle(back).paddingInlineStart),
			titleX: title.x,
		};
	});
	assert(Math.abs(measured.backX - measured.titleX) <= 2, JSON.stringify(measured));
	return measured;
}

async function visit(id, expected) {
	await by(id).press("Enter");
	await page.waitForFunction(
		(expected) => (document.getElementById("workbench").dataset.management ?? "") === expected,
		expected,
	);
}

async function until(read, match) {
	for (let i = 0; i < 90; i++) {
		const value = await read();
		if (value && match(value)) return value;
		await delay(120);
	}
	throw new Error("等待实际界面状态超时。");
}

const browser = () =>
	app.evaluate(({ BrowserWindow }, url) => {
		const view = BrowserWindow.getAllWindows()[0].contentView.children.find((item) => item.webContents?.getURL() === url);
		if (!view) return null;
		return { id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds() };
	}, url);

try {
	await open();
	assert.equal(await by("sidebar-tools").getAttribute("aria-expanded"), "false");
	assert(await by("sidebar-automation").isHidden());
	assert(await by("sidebar-extensions").isHidden());
	assert(await by("theme-open").isVisible());
	await shot("工具-默认收起");
	await by("sidebar-tools").press("Enter");
	await by("sidebar-automation").waitFor();
	await route("automation-settings", "automation", "sidebar-automation");
	const alignments = [];
	for (const width of [1782, 1282]) {
		await size(width);
		alignments.push(await checkAlignment());
		assert.equal(
			await page
				.locator(".automation-examples")
				.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length),
			2,
		);
		await shot(`自动化-起点-${width}`);
	}
	for (const [name, frequency] of [
		["每日待办", "daily"],
		["每周工作摘要", "weekly"],
	]) {
		await by("automation-plans").getByRole("button", { name }).press("Enter");
		assert.equal(await by("automation-name").inputValue(), name);
		assert.equal(await by("automation-frequency").inputValue(), frequency);
		assert((await by("automation-prompt").inputValue()).length > 10);
		await by("automation-cancel-edit").click();
	}
	assert.equal((await page.evaluate(() => window.flower.automationState())).plans.length, 0);
	await route("extension-settings", "extensions", "sidebar-extensions");
	await by("extension-list").getByText("技能与扩展按工作区管理。").waitFor();
	assert(await by("extension-install").isHidden());
	assert(await by("extension-choose-workspace").isEnabled());
	await shot("目录-未选工作区");
	await by("extension-choose-workspace").press("Enter");
	await by("extension-list").getByText("暂无技能与扩展").waitFor();
	assert(await by("extension-install").isVisible());
	assert(await by("extension-install").isEnabled());
	await shot("目录-已选工作区且未导入");
	await route("model-dialog", "models", "theme-open");
	await by("service-name").fill("本地验收模型");
	await by("base-url").fill(model.baseUrl);
	await by("model-id").fill(model.modelId);
	await by("save-settings").click();
	await by("model-overview").waitFor();
	await shot("设置-模型与服务商");
	await by("settings-edit-service").press("Enter");
	assert.equal(await by("service-name").inputValue(), "本地验收模型");
	await by("service-name").fill("未保存的修改");
	await page.keyboard.press("Escape");
	await by("model-overview").waitFor();
	await route("instructions-dialog", "instructions", "settings-instructions");
	await by("instructions-text").fill("验收指令。");
	await by("instructions-form").getByRole("button", { name: "保存", exact: true }).click();
	await by("instructions-feedback")
		.getByText(/已保存/)
		.waitFor();
	await route("desktop-update", "update", "settings-update");
	await by("desktop-update-version")
		.getByText(/当前版本/)
		.waitFor();
	await route("appearance-page", "appearance", "settings-appearance");
	const firstScheme = await page.locator("html").getAttribute("data-scheme");
	await by("appearance-page")
		.getByText(firstScheme === "dark" ? "浅色" : "深色", { exact: true })
		.click();
	await route("desktop-update", "update", "settings-update");
	assert.equal(await page.locator("html").getAttribute("data-scheme"), firstScheme, "离开时应还原未保存的主题");
	await by("settings-close-dialog").press("Enter");

	await page.waitForFunction(() => window.flower.state().then(({ draft }) => Boolean(draft)));
	await by("prompt").fill("第一次正常提交");
	await by("send").click();
	await page.getByText("管理页面验证回执。", { exact: true }).waitFor();
	const original = (await state()).selected;
	await by("prompt").fill("原会话未发送的草稿");
	await by("workspace-panel-toggle").click();
	await by("panel-more-tools").click();
	await page.locator('#panel-tool-menu [data-panel-mode="browser"]').click();
	await by("native-browser-address").fill(url);
	await by("native-browser-address").press("Enter");
	const browserBefore = await until(browser, (view) => view.visible && view.bounds.width > 100);
	await route("extension-settings", "extensions", "sidebar-extensions");
	await until(browser, (view) => !view.visible);
	assert.equal(await by("extension-workspace").textContent(), "管理页面工作区");
	assert.equal(await by("extension-workspace").getAttribute("title"), workspace);
	assert.equal(await filter("全部").getAttribute("aria-pressed"), "true");
	const skillRow = () => packageRow("核对周报");
	const extRow = () => packageRow("提取待办");
	await by("extension-install").click();
	await skillRow().press("Enter");
	const article = by("extension-skill-text");
	await article.getByRole("heading", { name: "周报复核说明" }).waitFor();
	assert.deepEqual(await article.getByRole("listitem").allTextContents(), ["完成情况", "待跟进事项"]);
	assert.match(await article.locator("pre > code").textContent(), /WEEKLY-962/);
	assert.equal(await article.locator("img, script").count(), 0);
	assert(await by("extension-install").isHidden());
	await shot("技能-详情");
	await by("extension-detail-back").press("Enter");
	await filter("技能").press("Enter");
	await visit("sidebar-back", "");
	assert.equal(await by("prompt").inputValue(), "原会话未发送的草稿");
	assert.equal((await until(browser, (view) => view.visible)).id, browserBefore.id);
	await visit("sidebar-forward", "extensions");
	assert.equal(await filter("技能").getAttribute("aria-pressed"), "true");
	await app.evaluate(() => {
		globalThis.flowerLibraryQA.file = "extension";
	});
	await by("extension-install").click();
	await extRow().waitFor();
	assert.equal(await filter("全部").getAttribute("aria-pressed"), "true");
	assert.equal(await skillRow().locator(".package-type").textContent(), "技能");
	assert.equal(await extRow().locator(".package-type").textContent(), "扩展");
	await shot("目录-混合列表");
	await filter("扩展").press("Enter");
	assert.equal(await skillRow().count(), 0);
	await extRow().press("Enter");
	const runExtension = by("extension-detail").getByRole("button", { name: "试运行" });
	await by("extension-detail-toggle").click();
	await by("extension-detail-toggle").getByText("启用", { exact: true }).waitFor();
	assert(await runExtension.isDisabled());
	await by("extension-detail-toggle").click();
	await by("extension-detail-toggle").getByText("停用", { exact: true }).waitFor();
	await runExtension.click();
	const runToggle = by("extension-run-toggle");
	await runToggle.getByText("收起试运行", { exact: true }).waitFor();
	assert.equal(await runToggle.getAttribute("aria-expanded"), "true");
	assert.equal(await by("extension-detail").locator("button.primary:visible").count(), 1);
	assert.equal(await page.evaluate(() => document.activeElement.id), "extension-path");
	await by("extension-path").fill("合成资料.txt");
	await by("extension-run-form").getByRole("button", { name: "运行扩展" }).click();
	await by("extension-result")
		.getByText(/TODO 核对周报/)
		.waitFor();
	assert.match(await by("extension-result-summary").textContent(), /匹配 1 行/);
	await shot("扩展-单主动作");
	await by("extension-path").fill("重试资料.txt");
	await by("extension-run-form").getByRole("button", { name: "运行扩展" }).click();
	await by("extension-result")
		.getByText(/TODO 重试路径通过/)
		.waitFor();
	await by("extension-path").press("Escape");
	assert.equal(await runToggle.getAttribute("aria-expanded"), "false");
	assert.equal(await page.evaluate(() => document.activeElement.id), "extension-run-toggle");
	await runToggle.press("Enter");
	assert.equal(await by("extension-path").inputValue(), "重试资料.txt");
	assert(await by("extension-result-panel").isHidden());
	await by("extension-detail-toggle").click();
	await by("extension-detail-toggle").getByText("启用", { exact: true }).waitFor();
	assert(await by("extension-run-form").isHidden());
	assert(await runToggle.isDisabled());
	assert.equal(await page.evaluate(() => document.activeElement.id), "extension-detail-toggle");
	await by("extension-detail-toggle").press("Enter");
	await by("extension-detail-toggle").getByText("停用", { exact: true }).waitFor();
	await by("extension-detail-back").click();
	assert.equal(await filter("扩展").getAttribute("aria-pressed"), "true");
	await route("automation-settings", "automation", "sidebar-automation");
	await by("automation-new").click();
	await by("automation-name").fill("周报计划");
	await by("automation-prompt").fill("汇总验收工作区。");
	const skills = by("automation-skill-choice");
	await skills.press("Enter");
	await by("automation-skill-choice-options").getByRole("option", { name: "核对周报" }).click();
	assert.equal(await page.locator("dialog[open]").count(), 0);
	await shot("自动化-编辑");
	await by("automation-form").getByRole("button", { name: "保存计划" }).click();
	const planRow = page.locator("[data-plan]").filter({ hasText: "周报计划" });
	await planRow.waitFor();
	assert.match(await planRow.locator(".plan-schedule").textContent(), /每天 09:00/);
	const more = planRow.getByRole("button", { name: "更多计划操作" });
	await more.press("Enter");
	const planMenu = by("automation-plan-menu");
	await planMenu.getByRole("menuitem", { name: "编辑" }).press("Enter");
	assert.equal(await by("automation-name").inputValue(), "周报计划");
	await by("automation-cancel-edit").click();
	await more.press("Enter");
	await planMenu.getByRole("menuitem", { name: "暂停", exact: true }).press("Enter");
	await planRow.getByText("已暂停", { exact: true }).waitFor();
	await more.press("Enter");
	await planMenu.getByRole("menuitem", { name: "启用", exact: true }).press("Enter");
	await planRow.getByText("已启用", { exact: true }).waitFor();
	await shot("自动化-列表");
	await by("automation-new").click();
	await by("automation-name").fill("待删除的临时计划");
	await by("automation-prompt").fill("审核菜单的删除入口。");
	await by("automation-form").getByRole("button", { name: "保存计划" }).click();
	const obsolete = page.locator("[data-plan]").filter({ hasText: "待删除的临时计划" });
	await obsolete.getByRole("button", { name: "更多计划操作" }).press("Enter");
	await planMenu.getByRole("menuitem", { name: "删除", exact: true }).press("Enter");
	await by("confirm-apply").click();
	await obsolete.waitFor({ state: "detached" });
	await by("settings-close-dialog").click();
	assert.equal(await by("prompt").inputValue(), "原会话未发送的草稿");
	assert.equal((await state()).selected, original);
	const browserAfter = await until(browser, (view) => view.visible && view.bounds.width > 100);
	assert.equal(browserAfter.id, browserBefore.id);

	await route("automation-settings", "automation", "sidebar-automation");
	await by("automation-plans").getByRole("button", { name: "立即执行" }).click();
	await by("background-tasks").getByText("已用核对周报技能。").first().waitFor();
	const run = await until(
		() => page.evaluate(() => window.flower.automationState().then(({ runs }) => runs[0])),
		(record) => record.status === "succeeded",
	);
	await by("background-tasks").getByRole("button", { name: "周报计划" }).click();
	await by("timeline").getByText("已用核对周报技能。").waitFor();
	await route("model-dialog", "models", "theme-open");
	await page.locator(".session-row").filter({ hasText: "首个会话" }).first().click();
	await by("prompt").waitFor();
	assert.equal(await by("prompt").inputValue(), "原会话未发送的草稿");
	assert.equal((await state()).selected, original);
	await by("workspace-panel-close").click();
	await size(660);
	await route("model-dialog", "models", "theme-open");
	await route("appearance-page", "appearance", "settings-appearance");
	await by("appearance-page").getByText("深色", { exact: true }).click();
	await by("appearance-page").getByRole("button", { name: "保存", exact: true }).press("Enter");
	await by("appearance-page").getByText("已保存外观。", { exact: true }).waitFor();
	await by("settings-close-dialog").focus();
	await shot("设置-660深色");
	await route("automation-settings", "automation", "sidebar-automation");
	alignments.push(await checkAlignment());
	await by("automation-new").click();
	await by("automation-name").fill("未保存计划");
	assert(await by("management-page").evaluate((node) => node.scrollWidth <= node.clientWidth));
	await page.keyboard.press("Escape");
	await by("automation-new").waitFor();
	await route("extension-settings", "extensions", "sidebar-extensions");
	assert(await by("management-page").evaluate((node) => node.scrollWidth <= node.clientWidth));
	await filter("全部").press("Enter");
	await extRow().waitFor();
	assert(
		await page.locator("#extension-list [data-package-kind]").evaluateAll((rows) =>
			rows.every((row) => {
				const [type, status] = [...row.querySelectorAll(".management-badge")].map((badge) => badge.getBoundingClientRect());
				return type.width > 0 && status.width > 0 && (type.right <= status.left || type.bottom <= status.top);
			}),
		),
	);
	await shot("目录-660深色");
	await filter("技能").press("Enter");
	await app.evaluate(() => {
		globalThis.flowerLibraryQA.other = true;
	});
	await by("extension-choose-workspace").click();
	await by("extension-workspace").getByText("隔离工作区").waitFor();
	await by("extension-list").getByText("暂无技能与扩展").waitFor();
	assert.equal(await filter("全部").getAttribute("aria-pressed"), "true");
	assert.equal(await page.locator("[data-package-kind]").count(), 0);
	await page.locator(".session-row").filter({ hasText: "首个会话" }).first().click();
	await by("prompt").waitFor();
	assert.equal(await by("prompt").inputValue(), "原会话未发送的草稿");
	await by("sidebar-toggle").press("Enter");
	await by("sidebar-tools").press("Enter");
	assert(await by("sidebar-automation").isHidden());
	assert(await by("theme-open").isVisible());
	await by("sidebar-tools").press("Enter");
	await page.keyboard.press("Tab");
	assert.equal(await page.evaluate(() => document.activeElement.id), "sidebar-automation");
	await page.keyboard.press("Tab");
	assert.equal(await page.evaluate(() => document.activeElement.id), "sidebar-extensions");
	await route("extension-settings", "extensions", "sidebar-extensions");
	await shot("工具-折叠侧栏");
	await by("sidebar-toggle").press("Enter");
	await app.close();
	app = undefined;

	await open();
	assert.equal(await by("sidebar-tools").getAttribute("aria-expanded"), "true");
	assert.equal(await page.locator("html").getAttribute("data-scheme"), "dark");
	assert.equal((await state()).instructions, "验收指令。");
	assert.equal((await state()).modelSettings.name, "本地验收模型");
	await route("extension-settings", "extensions", "sidebar-extensions");
	assert.equal(await filter("全部").getAttribute("aria-pressed"), "true");
	await extRow().waitFor();
	await skillRow().press("Enter");
	await by("extension-detail-toggle").click();
	await by("extension-detail-toggle").getByText("启用", { exact: true }).waitFor();
	assert(await by("extension-detail").getByRole("button", { name: "用于本次对话" }).isDisabled());
	await by("extension-detail").getByRole("button", { name: "卸载" }).click();
	await by("confirm-apply").click();
	await skillRow().waitFor({ state: "detached" });
	await extRow().waitFor();
	await by("sidebar-tools").press("Enter");
	await app.close();
	app = undefined;
	await open();
	assert.equal(await by("sidebar-tools").getAttribute("aria-expanded"), "false");
	assert(await by("sidebar-automation").isHidden());
	const automation = await page.evaluate(() => window.flower.automationState());
	assert.equal(automation.plans.length, 1);
	assert.equal(automation.runs[0].id, run.id);
	assert.deepEqual(errors, []);
	await writeFile(
		join(output, "result.json"),
		JSON.stringify(
			{
				original,
				run: run.id,
				browser: browserAfter.id,
				darkWidth: 660,
				alignments,
				markdown: true,
				mixedLibrary: true,
				workspaceIsolation: true,
				rememberedTools: true,
				errors,
			},
			null,
			2,
		),
	);
} finally {
	await app?.close().catch(() => {});
	await model.close();
	await new Promise((done) => site.close(done));
}
