import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { startMockModel } from "./mock-model.mjs";

const [exeArg, evidenceArg, toolingArg, bookArg] = process.argv.slice(2);
assert(
	process.platform === "win32" && bookArg,
	"用法：verify-write-permission-windows.mjs <EXE> <新证据目录> <Playwright> <工作簿>",
);
const evidence = resolve(evidenceArg);
const profile = join(evidence, "profile");
const workspace = join(evidence, "订单权限验收");
const store = join(profile, "local-workbench");
const file = join(workspace, "orders.xlsx");
const workbench = join(store, "workbench.json");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
await mkdir(workspace);
await copyFile(resolve(bookArg), file);
await writeFile(join(workspace, "notes.txt"), "行动项：核对库存清单。\n");
const sourceSha256 = createHash("sha256")
	.update(await readFile(file))
	.digest("hex");
await mkdir(store, { recursive: true });
let releaseBackgroundTool;
const backgroundTool = new Promise((resolve) => {
	releaseBackgroundTool = resolve;
});
const fixture = await startMockModel({
	beforePermissionTool: (prompt) => (prompt.includes("后台触发") ? backgroundTool : undefined),
});
const results = [];
let current;
let page;
await writeFile(join(store, "model.json"), JSON.stringify({ baseUrl: fixture.baseUrl, modelId: fixture.modelId }));

async function boot() {
	current = await electron.launch({
		executablePath: resolve(exeArg),
		chromiumSandbox: true,
		timeout: 30_000,
		args: [`--user-data-dir=${profile}`],
	});
	page = await current.firstWindow();
	await current.evaluate(
		({ app, dialog, utilityProcess }, expected) => {
			if (app.getPath("userData").toLowerCase() !== expected.profile.toLowerCase()) throw new Error("测试资料目录不匹配");
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [expected.workspace] });
			const fork = utilityProcess.fork.bind(utilityProcess);
			utilityProcess.fork = (...args) => {
				globalThis.permissionQAProcess = fork(...args);
				return globalThis.permissionQAProcess;
			};
		},
		{ profile, workspace },
	);
	await page.waitForFunction(() => !document.querySelector("#write-mode-open").disabled);
}

async function close() {
	await current?.close();
	current = undefined;
}

function state() {
	return page.evaluate(() => window.flower.state());
}

async function showModePicker() {
	await page.locator("#write-mode-open").click();
	const picker = page.locator("#write-mode-picker");
	await picker.waitFor();
	return picker;
}

async function setMode(mode) {
	const picker = await showModePicker();
	const glyph = await picker.locator(`[data-write-mode="${mode}"] .mode-glyph use`).getAttribute("href");
	assert.equal(await picker.locator(".mode-check:visible").count(), 1);
	await picker.locator(`[data-write-mode="${mode}"]`).press("Enter");
	await picker.waitFor({ state: "hidden" });
	assert.equal((await state()).writeMode, mode);
	await page.waitForFunction(
		(value) => document.querySelector("#write-mode-open use").getAttribute("href") === value,
		glyph,
	);
}

async function submit(label) {
	await page.locator("#prompt").fill(`权限验收${label}`);
	await page.locator("#send").click();
	return page.locator(".task").filter({ has: page.locator(".user-message-text", { hasText: `权限验收${label}` }) });
}

async function expectTerminal(task, status = "succeeded") {
	await task.and(page.locator(`[data-status="${status}"]`)).waitFor();
	await page.waitForFunction(() => window.flower.state().then((value) => !value.writeModeBusy));
}

async function pendingApproval() {
	await page.locator("#write-approval").waitFor();
	const { writeApproval } = await state();
	assert(writeApproval);
	assert.equal(writeApproval.workspace.toLowerCase(), workspace.toLowerCase());
	assert.equal(writeApproval.input, "orders.xlsx");
	assert.deepEqual(
		writeApproval.files.map((name) => name.split("/").at(-1)),
		["分析报告.md", "汇总.xlsx"],
	);
	return writeApproval;
}

async function verifyOutputs(expected) {
	const items = await readdir(workspace);
	const dirs = items.filter((name) => name.startsWith("Flower-分析-"));
	assert.equal(dirs.length, expected, JSON.stringify(items));
	assert(!items.some((name) => name.startsWith(".flower-产出-")));
	for (const dir of dirs)
		assert.deepEqual((await readdir(join(workspace, dir))).sort(), ["分析报告.md", "汇总.xlsx"].sort());
	assert.equal(
		createHash("sha256")
			.update(await readFile(file))
			.digest("hex"),
		sourceSha256,
	);
}

try {
	await boot();
	assert.equal((await state()).writeMode, "auto");
	assert.equal(fixture.observations.discovery.length, 0);
	assert.equal(fixture.observations.model.length, 0);
	const menu = await showModePicker();
	assert.equal(await menu.locator("[aria-pressed=true]").getAttribute("data-write-mode"), "auto");
	assert.equal(await menu.locator("[data-write-mode]").count(), 3);
	await page.screenshot({ path: join(evidence, "权限菜单-浅色.png") });
	await page.keyboard.press("Escape");
	await setMode("read");
	await page.locator("#composer-add").click();
	await page.locator("#composer-workspace").click();
	await page.waitForFunction(() => window.flower.state().then((value) => Boolean(value.selected)));
	const session = (await state()).selected;
	assert.equal((await state()).writeMode, "read");
	for (const [label, expected] of [
		["读取目录", "orders.xlsx"],
		["读取文本", "核对库存清单"],
		["只读汇总", "500"],
		["只读拒写", "当前会话为只读"],
	]) {
		const task = await submit(label);
		await expectTerminal(task);
		assert((await task.textContent()).includes(expected));
		assert(await page.locator("#write-approval").isHidden());
		await verifyOutputs(0);
	}
	results.push("冷启动零请求，未选工作区权限继承到会话，目录、文本和只读汇总可用，强制写入被拒且零产物");

	await setMode("ask");
	const rejected = await submit("明确拒绝");
	const rejectId = (await pendingApproval()).id;
	assert(await page.locator("#prompt").isEnabled());
	await page.screenshot({ path: join(evidence, "实际写入审批.png") });
	await page.locator("#write-deny").click();
	await expectTerminal(rejected);
	assert((await rejected.textContent()).includes("未经批准"));
	assert.equal(await page.evaluate((id) => window.flower.decideWrite(id, true), rejectId), false);
	await verifyOutputs(0);

	const doubled = await submit("双次写入");
	const first = await pendingApproval();
	await page.locator("#write-allow").click();
	await page.waitForFunction(
		(id) => window.flower.state().then(({ writeApproval }) => Boolean(writeApproval && writeApproval.id !== id)),
		first.id,
	);
	const second = await pendingApproval();
	assert.notEqual(second.files[0], first.files[0]);
	await verifyOutputs(1);
	await page.locator("#write-deny").click();
	await expectTerminal(doubled);
	await verifyOutputs(1);
	results.push("审批显示实际使用的工作区、输入和两个输出路径。首次同意只创建一对文件，第二次仍须审批");

	const cancelling = await submit("取消待审批");
	const cancellingApproval = await pendingApproval();
	const waiting = await page.evaluate((selected) => window.flower.submit(selected, "权限验收排队任务"), session);
	await assert.rejects(
		page.evaluate((selected) => window.flower.setWriteMode(selected, "auto"), session),
		/运行和排队/,
	);
	await page.evaluate(({ session, request }) => window.flower.cancel(session, request), {
		session,
		request: waiting.requestId,
	});
	await page.locator("#write-cancel-task").click();
	await expectTerminal(cancelling, "cancelled");
	assert.equal(await page.evaluate((id) => window.flower.decideWrite(id, true), cancellingApproval.id), false);
	await verifyOutputs(1);
	results.push("待审批运行和排队时禁止切换权限，取消任务移除审批，迟到同意失效");

	await page.locator("#new-session").click();
	await page.waitForFunction((previous) => window.flower.state().then((value) => value.selected !== previous), session);
	const other = (await state()).selected;
	assert.equal((await state()).writeMode, "ask");
	await setMode("auto");
	const automatic = await submit("自动生成");
	await expectTerminal(automatic);
	assert(await page.locator("#write-approval").isHidden());
	await verifyOutputs(2);
	const back = page.getByRole("button", { name: "后退", exact: true });
	const forward = page.getByRole("button", { name: "前进", exact: true });
	await back.press("Enter");
	await page.waitForFunction((id) => window.flower.state().then((value) => value.selected === id), session);
	assert.equal((await state()).writeMode, "ask");
	await forward.press("Enter");
	await page.waitForFunction((id) => window.flower.state().then((value) => value.selected === id), other);
	assert.equal((await state()).writeMode, "auto");
	await setMode("ask");
	const originalRow = page.locator("#sessions .session-row").last();
	const otherRow = page.locator("#sessions .session-row").first();
	await back.press("Enter");
	await page.waitForFunction((id) => window.flower.state().then((value) => value.selected === id), session);
	assert.equal((await state()).writeMode, "ask");
	results.push("会话权限独立，自动审批在当前工作区生成文件");

	await current.evaluate(() => {
		const { mock } = process.getBuiltinModule("node:test");
		mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	});
	const switching = await submit("待审批时切换会话");
	const originalApproval = await pendingApproval();
	await assert.rejects(
		page.evaluate((id) => window.flower.manageSidebar("session", id, "delete"), session),
		/正在运行或排队/,
	);
	const beforeRemoval = await state();
	await assert.rejects(
		page.evaluate(({ id, count }) => window.flower.manageSidebar("workspace", id, "delete", count), {
			id: beforeRemoval.sessions[0].workspaceId,
			count: beforeRemoval.sessions.length,
		}),
		/正在运行或排队/,
	);
	const waitedMs = await current.evaluate(() => {
		const { mock } = process.getBuiltinModule("node:test");
		const started = Date.now();
		mock.timers.tick(61_000);
		const elapsed = Date.now() - started;
		mock.timers.reset();
		return elapsed;
	});
	assert.equal(waitedMs, 61_000);
	assert.equal((await pendingApproval()).id, originalApproval.id);
	await forward.press("Enter");
	await page.locator("#write-approval").waitFor({ state: "hidden" });
	assert.equal((await state()).writeApproval, undefined);
	assert.equal(await page.locator("#write-workspace").textContent(), "");
	await originalRow.locator(".session-approval").waitFor();
	assert.match(await originalRow.getAttribute("aria-label"), /待批准/);
	assert.equal(await page.evaluate((id) => window.flower.decideWrite(id, true), originalApproval.id), false);
	await submit("后台触发");
	await back.press("Enter");
	assert.equal((await pendingApproval()).id, originalApproval.id);
	releaseBackgroundTool();
	await otherRow.locator(".session-approval").waitFor();
	assert.equal((await pendingApproval()).id, originalApproval.id);
	await page.screenshot({ path: join(evidence, "两会话待批准.png") });
	await forward.press("Enter");
	await page.waitForFunction(
		(id) => window.flower.state().then(({ selected, writeApproval }) => selected === id && writeApproval?.session === id),
		other,
	);
	const otherApproval = await pendingApproval();
	assert.notEqual(otherApproval.id, originalApproval.id);
	assert.equal(await page.evaluate((id) => window.flower.decideWrite(id, true), originalApproval.id), false);
	await back.press("Enter");
	await page.waitForFunction(
		(id) => window.flower.state().then(({ writeApproval }) => writeApproval?.id === id),
		originalApproval.id,
	);
	assert.equal(await page.evaluate((id) => window.flower.decideWrite(id, true), otherApproval.id), false);
	await page.locator("#write-allow").click();
	await expectTerminal(switching);
	assert.equal(await page.evaluate((id) => window.flower.decideWrite(id, true), originalApproval.id), false);
	await verifyOutputs(3);
	await otherRow.click();
	await page.locator("#write-approval").waitFor();
	assert.equal((await pendingApproval()).id, otherApproval.id);
	await page.locator("#write-deny").click();
	await expectTerminal(page.locator(".task").filter({ hasText: "权限验收后台触发" }));
	await verifyOutputs(3);
	await originalRow.click();
	await page.waitForFunction((id) => window.flower.state().then(({ selected }) => selected === id), session);
	results.push("虚拟时钟前进 61 秒后同一审批仍有效，两会话前后台触发均保留，审批决定只对本会话的当次调用生效");

	await submit("进程退出");
	const interrupted = await pendingApproval();
	await current.evaluate(() => globalThis.permissionQAProcess.kill());
	await page.locator("#write-approval").waitFor({ state: "hidden" });
	await page.locator('.task[data-status="interrupted"]').filter({ hasText: "权限验收进程退出" }).waitFor();
	assert.equal(await page.evaluate((id) => window.flower.decideWrite(id, true), interrupted.id), false);
	await verifyOutputs(3);

	await page.locator("#theme-open").click();
	await page.locator("#settings-appearance").click();
	await page.getByText("深色", { exact: true }).click();
	await page.locator(".theme-save").click();
	await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 615));
	await page.waitForFunction(() => innerWidth <= 660);
	await showModePicker();
	assert(
		await page.evaluate(() => {
			const view = document.getElementById("write-mode-picker").getBoundingClientRect();
			const mode = document.getElementById("write-mode-open").getBoundingClientRect();
			const model = document.getElementById("model-picker-open").getBoundingClientRect();
			return view.left >= 0 && view.right <= innerWidth && mode.right <= model.left;
		}),
	);
	await page.screenshot({ path: join(evidence, "权限菜单-深色窄窗.png") });
	await page.keyboard.press("Escape");

	await submit("应用关闭");
	const closing = await pendingApproval();
	await close();
	await verifyOutputs(3);
	const legacy = JSON.parse(await readFile(workbench, "utf8"));
	delete legacy.sessions.find(({ id }) => id === other).writeMode;
	await writeFile(workbench, JSON.stringify(legacy));
	await boot();
	assert.equal((await state()).writeMode, "ask");
	assert(await page.locator("#write-approval").isHidden());
	assert.equal(await page.evaluate((id) => window.flower.decideWrite(id, true), closing.id), false);
	assert.equal(await page.evaluate((id) => window.flower.decideWrite(id, true), originalApproval.id), false);
	await page
		.locator(".task")
		.filter({ hasText: "权限验收应用关闭" })
		.and(page.locator('[data-status="interrupted"]'))
		.waitFor();
	await page.evaluate((selected) => window.flower.selectSession(selected), other);
	assert.equal((await state()).writeMode, "auto");
	await verifyOutputs(3);
	results.push("工作进程退出和应用关闭都撤销待批写入。重启恢复会话权限及中断记录，旧会话缺字段时采用自动审批");
	const report = { exe: resolve(exeArg), profile, sourceSha256, outputs: 3, waitedMs, results };
	await writeFile(join(evidence, "result.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
} finally {
	releaseBackgroundTool();
	await close();
	await fixture.close();
}
