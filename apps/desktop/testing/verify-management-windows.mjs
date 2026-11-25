import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { startMockModel } from "./mock-model.mjs";

const [binary, output, tooling, linuxRepo] = process.argv.slice(2);
assert(process.platform === "win32" && linuxRepo, "需要 Windows 程序、验收目录、Playwright 及独立 WSL 仓库。");
const profile = join(resolve(output), "profile");
const workspace = join(resolve(output), "桌面项目");
await mkdir(workspace, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { windowsHide: true });
git("init", "-q", "-b", "main");
await writeFile(join(workspace, "项目计划.md"), "# 项目计划\n\n周三提交初稿。\n");
git("add", "--", "项目计划.md");
await writeFile(join(workspace, "项目计划.md"), "# 项目计划\n\n周五提交初稿。\n");
await writeFile(join(workspace, "验收清单.txt"), "核对交付日期。");
const { _electron: electron } = createRequire(join(resolve(tooling), "package.json"))("playwright");
const fixture = await startMockModel({
	attachmentReply: () => ({ text: "管理验收记录完成。" }),
	titleReply: (body) => ({ text: /<user_message>\n([^\n]+)/.exec(body)?.[1] ?? "验收会话" }),
});
let app;
let page;
async function boot() {
	app = await electron.launch({
		executablePath: resolve(binary),
		args: [`--user-data-dir=${profile}`],
		chromiumSandbox: true,
	});
	page = await app.firstWindow();
	page.setDefaultTimeout(14000);
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1282, 800));
	await page.locator("#workspace:not(:disabled)").waitFor();
}
const by = (id) => page.locator(`#${id}`);
const exact = (name) => page.getByRole("button", { name, exact: true });
async function choose(path) {
	await app.evaluate(({ dialog }, root) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
	}, path);
	await by("workspace").click();
}
async function keepDraft(title) {
	await page.waitForFunction(() => window.flower.state().then(({ draft }) => Boolean(draft)));
	await by("prompt").fill(title);
	await by("send").click();
	await page.locator('.task[data-status="succeeded"]').waitFor();
	await exact(`会话操作：${title}`).waitFor();
}
async function menu(label, operation) {
	await exact(label).focus();
	await exact(label).click();
	await by("sidebar-options").locator(`[data-operation="${operation}"]`).click();
}
async function rename(label, name) {
	await menu(label, "rename");
	await by("sidebar-name").fill(name);
	await by("sidebar-apply").click();
}
async function gitPane() {
	await by("workspace-panel-toggle").click();
	await by("panel-git").click();
	await exact("未暂存：项目计划.md，修改").click();
	await page.locator(".diff-added").filter({ hasText: "周五提交初稿" }).waitFor();
	await page.locator(".diff-removed").filter({ hasText: "周三提交初稿" }).waitFor();
}
try {
	await boot();
	await page.evaluate(
		(baseUrl) => window.flower.saveModel({ serviceId: "", baseUrl, modelId: "local-test", apiKey: "" }),
		fixture.baseUrl,
	);
	await choose(workspace);
	await keepDraft("桌面项目");
	await gitPane();
	const width = (await by("workspace-panel").boundingBox()).width;
	await page.locator(".diff-number").first().waitFor();
	assert(!(await page.locator(".git-diff").textContent()).includes("diff --git"));
	assert(width >= 480 && width <= 530);
	await page.screenshot({ scale: "css", path: join(output, "Git差异.png") });
	await by("panel-up").click();
	await exact("已暂存：项目计划.md，新增").click();
	await page.locator(".diff-added").filter({ hasText: "周三提交初稿" }).waitFor();
	await by("panel-up").click();
	await exact("未暂存：验收清单.txt，未跟踪").click();
	await by("panel-content").getByText("核对交付日期。").waitFor();
	await by("panel-files").click();
	await by("workspace-panel-close").click();
	const external = join(resolve(output), "会议记录.txt");
	await writeFile(external, "原件保留。");
	await app.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, external);
	await by("composer-add").click();
	await by("file").click();
	await exact("预览附件：会议记录.txt").waitFor();
	const owner = await page.evaluate(async () => (await window.flower.state()).selected);
	const assets = join(profile, "local-workbench", "sessions", "attachment-assets", owner);
	assert((await stat(assets)).isDirectory());
	await rename("会话操作：桌面项目", "排期讨论");
	await menu("会话操作：排期讨论", "pin");
	await by("new-session").click();
	await page.waitForFunction(() => window.flower.state().then(({ draft }) => Boolean(draft)));
	assert.equal(await by("prompt").inputValue(), "");
	assert.equal(await page.locator(".session-row").count(), 1);
	assert.equal(await exact("预览附件：会议记录.txt").count(), 0);
	await keepDraft("桌面项目 · 新会话");
	await page.waitForFunction(() => document.querySelectorAll(".session-row").length === 2);
	assert.equal(
		await page
			.locator(".session-row")
			.first()
			.textContent()
			.then((s) => s.replace("待批准", "")),
		"排期讨论",
	);
	await by("sidebar-view").click();
	await rename("工作区操作：桌面项目", "桌面工作台");
	await menu("工作区操作：桌面工作台", "pin");
	await choose(linuxRepo);
	await keepDraft("WSL 工作区验收");
	await gitPane();
	await by("workspace-panel-close").click();
	assert.equal(await page.locator(".workspace-group-name").first().textContent(), "桌面工作台");
	await app.close();
	app = undefined;
	await boot();
	await exact("工作区操作：桌面工作台").focus();
	await exact("工作区操作：桌面工作台").click();
	await by("sidebar-options").getByRole("menuitem", { name: "取消置顶" }).waitFor();
	await page.screenshot({ scale: "css", path: join(output, "工作区操作.png") });
	await page.keyboard.press("Escape");
	await menu("工作区操作：桌面工作台", "rename");
	await by("sidebar-cancel").click();
	const pinned = await page.evaluate(() => window.flower.state());
	assert(pinned.workspaces.some((w) => w.workspace === "桌面工作台" && w.pinned));
	assert(pinned.sessions.some((s) => s.title === "排期讨论" && s.pinned));
	await menu("会话操作：排期讨论", "delete");
	await by("sidebar-cancel").click();
	await exact("会话操作：排期讨论").waitFor();
	await menu("会话操作：排期讨论", "delete");
	await by("sidebar-apply").click();
	await exact("会话操作：排期讨论").waitFor({ state: "detached" });
	await menu("会话操作：桌面项目 · 新会话", "delete");
	await by("sidebar-apply").click();
	await exact("会话操作：桌面项目 · 新会话").waitFor({ state: "detached" });
	await menu("工作区操作：桌面工作台", "create");
	await page.waitForFunction(() => window.flower.state().then(({ draft }) => Boolean(draft)));
	assert.equal(await exact("会话操作：桌面工作台 · 新会话").count(), 0);
	await keepDraft("桌面工作台 · 新会话");
	await exact("会话操作：桌面工作台 · 新会话").waitFor();
	await menu("工作区操作：桌面工作台", "delete");
	assert((await by("sidebar-detail").textContent()).includes("1 条会话"));
	await by("sidebar-apply").click();
	await exact("工作区操作：桌面工作台").waitFor({ state: "detached" });
	assert((await readFile(join(workspace, "项目计划.md"), "utf8")).includes("周五"));
	await app.close();
	app = undefined;
	await boot();
	const state = await page.evaluate(() => window.flower.state());
	assert.equal(state.workspaces.length, 1);
	assert.equal(state.sessions.length, 1);
	assert.equal(state.sessions[0].id, state.selected);
	await assert.rejects(stat(assets), { code: "ENOENT" });
	assert.equal(await readFile(external, "utf8"), "原件保留。");
	for (const session of pinned.sessions.filter((s) => s.workspace === "桌面工作台"))
		await assert.rejects(stat(join(profile, "local-workbench", "sessions", `${session.id}.json`)), { code: "ENOENT" });
	await writeFile(
		join(output, "result.json"),
		JSON.stringify({
			width,
			windowsGit: true,
			wslGit: true,
			staged: true,
			working: true,
			untracked: true,
			retainedDirectory: true,
			persistentPins: true,
			emptyWorkspace: true,
		}),
	);
} finally {
	await app?.close();
	await fixture.close();
}
