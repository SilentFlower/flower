import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { startMockModel } from "./mock-model.mjs";

const [exeArg, evidenceArg, toolingArg, bookArg] = process.argv.slice(2);
assert(
	process.platform === "win32" && bookArg,
	"用法：verify-sidebar-windows.mjs <EXE> <新证据目录> <Playwright> <工作簿>",
);
const exe = resolve(exeArg);
const evidence = resolve(evidenceArg);
const profile = join(evidence, "profile");
const stateFile = join(profile, "local-workbench", "workbench.json");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
const shared = join(evidence, "共同目录前缀".repeat(12));
assert(shared.length > 140);
const roots = await Promise.all(
	["项目甲", "项目乙"].map(async (parent) => {
		const path = join(shared, parent, "阶段", "资料");
		await mkdir(path, { recursive: true });
		return realpath(path);
	}),
);
const file = join(roots[0], "orders.xlsx");
await copyFile(resolve(bookArg), file);
await writeFile(join(roots[0], "notes.txt"), "隔离验收事项：核对库存。");
const fixture = await startMockModel();
const results = [];
let app;
let page;

async function boot() {
	app = await electron.launch({
		executablePath: exe,
		chromiumSandbox: true,
		timeout: 30_000,
		args: [`--user-data-dir=${profile}`],
	});
	page = await app.firstWindow();
	await app.evaluate(
		({ app, dialog }, expected) => {
			if (!app.isPackaged || app.getPath("userData").toLowerCase() !== expected.profile.toLowerCase())
				throw new Error("候选或隔离资料目录不匹配");
			globalThis.sidebarQA = { directories: 0, files: 0, folder: "" };
			dialog.showOpenDialog = async (_window, options) => {
				const qa = globalThis.sidebarQA;
				if (options.properties.includes("openDirectory")) {
					qa.directories++;
					return { canceled: !qa.folder, filePaths: qa.folder ? [qa.folder] : [] };
				}
				qa.files++;
				return { canceled: false, filePaths: [expected.file] };
			};
		},
		{ profile, file },
	);
	await page.waitForFunction(() => !document.querySelector("#new-session").disabled);
}

const state = () => page.evaluate(() => window.flower.state());
const view = () => page.getByRole("button", { name: "按工作区分组", exact: true });
const groups = () => page.locator("#sessions .workspace-group");
const rows = () => page.locator("#sessions .session-row");
const groupAt = (path) => groups().filter({ has: page.getByTitle(path, { exact: true }) });
const draft = () => page.locator("#prompt");
const nativePicks = () => app.evaluate(() => [globalThis.sidebarQA.directories, globalThis.sidebarQA.files]);

async function chooseWorkspace(directory, label) {
	await app.evaluate((_electron, path) => {
		globalThis.sidebarQA.folder = path;
	}, directory);
	const id = await page.evaluate(() => window.flower.chooseWorkspace());
	assert(id);
	assert.equal((await state()).draft.id, id);
	await keepDraft(id, label);
	return id;
}

async function openSession(id) {
	await page.evaluate((id) => window.flower.selectSession(id), id);
	assert.equal((await state()).selected, id);
}

async function setMode(mode) {
	const selected = (await state()).selected;
	await page.evaluate(({ selected, mode }) => window.flower.setWriteMode(selected, mode), { selected, mode });
	assert.equal((await state()).writeMode, mode);
}

async function submitted(text) {
	await draft().fill(text);
	await page.locator("#send").click();
	const request = page.locator(".task").filter({ hasText: text });
	await request.waitFor();
	return request;
}

async function keepDraft(id, title) {
	const task = await submitted(`权限验收读取目录：${title}`);
	await task.and(page.locator('[data-status="succeeded"]')).waitFor();
	await page.evaluate(({ id, title }) => window.flower.manageSidebar("session", id, "rename", title), { id, title });
}

async function assertSidebarFits() {
	const widths = await page
		.locator("#sidebar-scroll, #sessions")
		.evaluateAll((nodes) => nodes.map(({ id, scrollWidth, clientWidth }) => ({ id, scrollWidth, clientWidth })));
	assert(
		widths.every(({ scrollWidth, clientWidth }) => scrollWidth <= clientWidth),
		JSON.stringify(widths),
	);
	return widths;
}

try {
	await boot();
	assert.equal(await view().getAttribute("aria-pressed"), "false");
	assert.equal(await view().getAttribute("title"), "切换到工作区模式");
	assert.equal(await page.locator("#session-list-empty").textContent(), "暂无会话");
	assert(await page.locator("#session-list-empty").isVisible());
	await view().press("Space");
	assert.equal(await view().getAttribute("aria-pressed"), "true");
	assert.equal(await view().getAttribute("title"), "切换到会话模式");
	assert.equal(await page.locator("#session-list-empty").textContent(), "暂无工作区");
	assert.equal(await groups().count(), 0);
	assert.deepEqual(await nativePicks(), [0, 0]);
	assert.equal((await state()).selected, "");
	assert(await page.locator("#sidebar-back").isDisabled());
	assert(await page.locator("#sidebar-forward").isDisabled());
	await view().press("Enter");
	results.push("首启平铺，空视图可用键盘切换，零目录对话框、零会话与导航变化");

	await page.evaluate(({ baseUrl, modelId }) => window.flower.saveModel({ baseUrl, modelId }), {
		baseUrl: fixture.baseUrl,
		modelId: fixture.modelId,
	});
	const a = await chooseWorkspace(roots[0], "甲组验收");
	await setMode("ask");
	await page.locator("#new-session").click();
	await page.waitForFunction(() => window.flower.state().then(({ draft }) => Boolean(draft)));
	const a2 = (await state()).draft.id;
	assert.equal(await rows().count(), 1);
	await keepDraft(a2, "资料 · 新会话");
	await page.waitForFunction(() => document.querySelectorAll("#sessions .session-row").length === 2);
	const a3 = await chooseWorkspace(roots[0], "甲组复验");
	const b = await chooseWorkspace(roots[1], "乙组验收");
	await setMode("read");
	const sessions = (await state()).sessions;
	const idFor = (id) => sessions.find((entry) => entry.id === id).workspaceId;
	assert(idFor(a) && idFor(b));
	assert.equal(idFor(a), idFor(a2));
	assert.equal(idFor(a), idFor(a3));
	assert.notEqual(idFor(a), idFor(b));
	assert.equal(await rows().count(), 4);
	assert.equal(await groups().count(), 0);
	assert((await state()).draft === undefined);
	await page.screenshot({ path: join(evidence, "会话平铺.png") });
	await view().click();
	assert.equal(await groups().count(), 2);
	assert.deepEqual(await groups().locator(".workspace-group-name").allTextContents(), ["资料", "资料"]);
	assert.deepEqual(await groups().locator(".workspace-group-path").allTextContents(), [
		"…\\项目乙\\阶段",
		"…\\项目甲\\阶段",
	]);
	for (const root of roots) {
		const label = groupAt(root).locator(".workspace-group-toggle");
		assert(await label.locator(".workspace-group-path").isVisible());
		assert.equal(await label.getAttribute("title"), root);
		assert((await label.getAttribute("aria-label")).includes(root));
	}
	assert.equal(await groupAt(roots[0]).locator(".session-row").count(), 3);
	assert.equal(await groupAt(roots[1]).locator(".session-row").count(), 1);
	assert(await groupAt(roots[1]).locator('.session-row[aria-current="true"]').isVisible());
	await page.screenshot({ path: join(evidence, "工作区分组.png") });
	const widths = { wide: await assertSidebarFits() };
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(660, 615));
	await page.waitForFunction(() => innerWidth === 660);
	widths.narrow = await assertSidebarFits();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1282, 801));
	await page.waitForFunction(() => innerWidth === 1282);
	results.push("Host 真实目录身份区分同名目录，重新选择同一目录与新建会话均归入同组，两组路径可辨");
	results.push(`两组真实目录共享 ${shared.length} 个字符的前缀，可见尾段不同，原生悬停提示提供完整路径`);

	const aToggle = () => groupAt(roots[0]).locator(".workspace-group-toggle");
	await aToggle().press("Enter");
	assert.equal(await aToggle().getAttribute("aria-expanded"), "false");
	assert(await groupAt(roots[0]).locator(".workspace-group-entries").isHidden());
	assert.equal((await state()).selected, b);
	await page.keyboard.press("Control+k");
	const search = page.locator("#session-search");
	await search.fill("项目甲");
	assert.equal(await groups().count(), 1);
	assert.equal(await aToggle().getAttribute("aria-expanded"), "true");
	await view().click();
	assert.equal(await search.inputValue(), "项目甲");
	assert.equal(await rows().count(), 3);
	assert.equal(await groups().count(), 0);
	await view().click();
	assert.equal(await groups().count(), 1);
	await search.fill("新会话");
	assert.equal(await rows().count(), 1);
	await search.press("Enter");
	await page.locator('#sessions .session-row[aria-current="true"]').waitFor();
	assert.equal((await state()).selected, a2);
	await search.fill("找不到的测试内容");
	assert(await page.locator("#session-search-empty").isVisible());
	assert.equal(await groups().count(), 0);
	await search.press("Escape");
	assert.equal(await aToggle().getAttribute("aria-expanded"), "false");
	assert.equal((await state()).selected, a2);
	results.push("折叠、工作区路径搜索和标题搜索可组合，切换保留查询，退出搜索恢复折叠，Enter 打开实际结果");

	await openSession(a);
	assert.equal((await state()).writeMode, "ask");
	await page.locator("#composer-add").click();
	await page.locator("#file").click();
	await page.waitForFunction(() => document.querySelector("#attachment")?.textContent === "orders.xlsx");
	const waiting = await submitted("权限验收侧栏切换");
	await page.locator("#write-approval").waitFor();
	const queuedText = "权限验收读取文本排队";
	await draft().fill(queuedText);
	await page.locator("#send").click();
	const queued = page.locator("#queue .queue-item").filter({ hasText: queuedText });
	await queued.waitFor();
	await draft().fill("切换期间一直保留的草稿");
	const before = await state();
	assert(before.writeApproval?.id && before.modelBusy && before.writeModeBusy);
	assert.equal(await waiting.getAttribute("data-status"), "running");
	assert(await aToggle().getByText("待批准").isVisible());
	const nav = () =>
		page.locator("#sidebar-back, #sidebar-forward").evaluateAll((items) => items.map((item) => item.disabled));
	const navigation = await nav();
	const persisted = await readFile(stateFile, "utf8");
	for (const grouped of [false, true]) {
		await view().press("Enter");
		assert.equal(await view().getAttribute("aria-pressed"), String(grouped));
		assert.deepEqual(await state(), before);
		assert.equal(await draft().inputValue(), "切换期间一直保留的草稿");
		assert.equal(await waiting.getAttribute("data-status"), "running");
		assert(await queued.isVisible());
		assert(await page.locator("#write-approval").isVisible());
		assert.deepEqual(await nav(), navigation);
		assert.equal(await readFile(stateFile, "utf8"), persisted);
	}
	assert.deepEqual(await nativePicks(), [3, 1]);
	await page.locator("#write-deny").click();
	await page.locator('.task[data-status="succeeded"]').filter({ hasText: queuedText }).waitFor();
	assert(!(await readdir(roots[0])).some((entry) => entry.startsWith("Flower-分析-")));
	results.push("待审批运行及排队期间双向切换，草稿、权限、审批 ID、运行、队列、导航和工作台文件内容全程一致");

	await app.close();
	app = undefined;
	await boot();
	assert.equal(await view().getAttribute("aria-pressed"), "true");
	assert.equal(await groups().count(), 2);
	assert.equal((await state()).selected, a);
	assert.equal((await state()).writeMode, "ask");
	assert.deepEqual(await nativePicks(), [0, 0]);
	assert(await groupAt(roots[0]).locator('.session-row[aria-current="true"]').isVisible());
	await view().click();
	await app.close();
	app = undefined;
	await boot();
	assert.equal(await view().getAttribute("aria-pressed"), "false");
	assert.equal(await rows().count(), 4);
	assert.equal((await state()).selected, a);
	assert.deepEqual(await nativePicks(), [0, 0]);
	results.push("分组和平铺分别重启恢复，选中会话与权限保持，系统目录选择零调用");
	const report = { exe, profile, roots, widths, results };
	await writeFile(join(evidence, "result.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
} finally {
	await app?.close();
	await fixture.close();
}
