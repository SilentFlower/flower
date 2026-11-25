import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [entry, output, playwright] = process.argv.slice(2).map((part) => resolve(part));
const { _electron } = createRequire(join(playwright, "package.json"))("playwright");
await mkdir(output, { recursive: true });
const app = await _electron.launch({
	executablePath: entry,
	args: [`--user-data-dir=${join(output, "profile")}`, "--force-device-scale-factor=1"],
	chromiumSandbox: true,
	timeout: 45000,
});
try {
	const page = await app.firstWindow();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const by = (id) => page.locator(`#${id}`);
	await by("workspace").waitFor();
	await by("workspace-panel-toggle").click();
	await by("panel-more-tools").press("Enter");
	const menu = by("panel-tool-menu");
	await menu.waitFor();
	assert.equal(await menu.locator('button[aria-checked="true"]').getAttribute("data-panel-mode"), "files");
	assert.equal(await menu.locator("button:not([hidden])").count(), 5);
	assert.equal(await menu.locator("button:not([hidden]) .icon").count(), 5);
	await page.screenshot({ path: join(output, "右栏面板菜单.png") });
	await page.keyboard.press("ArrowDown");
	assert.equal(await page.evaluate(() => document.activeElement.dataset.panelMode), "git");
	await page.keyboard.press("Escape");
	await by("workspace-panel-close").click();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(660, 760));
	await page.evaluate(() => window.flowerTheme.apply({ ...window.flowerTheme.saved, mode: "dark" }));
	await page.waitForFunction(() => innerWidth === 660 && document.documentElement.dataset.scheme === "dark");
	await by("sidebar-tools").press("Enter");
	await by("sidebar-automation").press("Enter");
	await by("automation-new").click();
	assert.equal(await by("automation-heading").textContent(), "新建计划");
	for (const id of ["automation-new", "automation-tasks", "automation-plans"]) assert(await by(id).isHidden());
	await by("automation-frequency-choice").press("ArrowDown");
	await by("automation-frequency-choice-options").getByRole("option", { name: "每周" }).press("Enter");
	await by("automation-weekday-choice").waitFor();
	await by("automation-weekday-choice").press("ArrowDown");
	await by("automation-weekday-choice-options").getByRole("option", { name: "周三" }).press("Enter");
	assert.equal(await by("automation-weekday-choice-value").textContent(), "周三");
	assert(await by("automation-scroll").evaluate((node) => node.scrollWidth <= node.clientWidth));
	await page.screenshot({ path: join(output, "新建计划-深色窄窗.png") });
	await page.keyboard.press("Escape");
	assert(await by("automation-new").isVisible());
	await by("settings-close-dialog").click();
	await by("theme-open").press("Enter");
	for (const id of [
		"settings-instructions",
		"sidebar-automation",
		"sidebar-extensions",
		"settings-update",
		"settings-appearance",
	])
		assert(await by(id).isVisible());
	await page.screenshot({ path: join(output, "设置入口-深色窄窗.png") });
	await by("sidebar-extensions").press("Enter");
	assert(await by("extension-settings").isVisible());
	await by("extension-format").locator("summary").press("Enter");
	assert(await by("extension-format").getByText("name: weekly-report", { exact: false }).isVisible());
	await page.screenshot({ path: join(output, "技能格式-深色窄窗.png") });
	assert.deepEqual(errors, []);
	await writeFile(
		join(output, "result.json"),
		JSON.stringify(
			{
				menuIcons: 5,
				selected: "files",
				keyboard: true,
				darkWidth: 660,
				focusedEditor: true,
				settingsEntries: true,
				help: true,
				errors,
			},
			null,
			2,
		),
	);
} finally {
	await app.close().catch(() => {});
}
