import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

const [entry, output, playwright] = process.argv.slice(2).map((part) => resolve(part));
const { _electron } = createRequire(join(playwright, "package.json"))("playwright");
const profile = join(output, "profile");
const store = join(profile, "local-workbench");
const workspace = join(output, "自动化验收资料");
const fixture = await startMockModel({ attachmentReply: () => ({ text: "合成定时任务已完成。费用口径通过。" }) });
let app;

async function open() {
	app = await _electron.launch({
		executablePath: entry,
		args: [`--user-data-dir=${profile}`, "--force-device-scale-factor=1"],
		chromiumSandbox: true,
		timeout: 45000,
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(15000);
	await page.locator("#workspace:not(:disabled)").waitFor();
	await app.evaluate(({ dialog }, directory) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
		dialog.showMessageBox = async () => ({ response: 1 });
	}, workspace);
	return page;
}

async function waitFor(check, budget = 100000) {
	const deadline = Date.now() + budget;
	for (;;) {
		const result = await check();
		if (result) return result;
		assert(Date.now() < deadline, "等待定时任务到期或回读超时。");
		await delay(200);
	}
}

try {
	await mkdir(store, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await writeFile(join(store, "model.json"), JSON.stringify({ modelId: fixture.modelId, baseUrl: fixture.baseUrl }));
	const page = await open();
	await page.locator("#workspace").click();
	await page.locator("#sidebar-tools").click();
	await page.locator("#sidebar-automation").click();
	await page.locator("#automation-new").click();
	const due = new Date(Date.now() + 65000);
	const time = [due.getHours(), due.getMinutes()].map((part) => String(part).padStart(2, "0")).join(":");
	await page.locator("#automation-name").fill("核对本周费用");
	await page.locator("#automation-prompt").fill("请检查这份合成工作区。");
	await page.locator("#automation-time").fill(time);
	await page.getByRole("button", { name: "保存计划", exact: true }).click();
	await page.locator("#automation-plans").getByText("核对本周费用").waitFor();
	await page.screenshot({ path: join(output, "自动化计划.png") });
	const run = await waitFor(async () => {
		const state = await page.evaluate(() => window.flower.automationState());
		return state.runs.find(({ trigger, status }) => trigger === "scheduled" && status === "succeeded");
	});
	const row = page.locator(`[data-run="${run.id}"]`);
	await row.getByRole("button", { name: "查看任务" }).click();
	await page.locator("#background-tasks").getByText("合成定时任务已完成。费用口径通过。").waitFor();
	await page.screenshot({ path: join(output, "后台执行结果.png") });
	await page.locator("#background-tasks").getByRole("button", { name: "核对本周费用" }).click();
	await waitFor(() => page.evaluate(async (id) => (await window.flower.state()).selected === id, run.id));
	await page.locator("#timeline").getByText("合成定时任务已完成。费用口径通过。").waitFor();
	await app.close();
	const reopened = await open();
	const proof = await reopened.evaluate(
		async (id) => ({
			schedule: await window.flower.automationState(),
			history: await window.flower.history(id),
			tasks: await window.flower.backgroundTasks(),
		}),
		run.id,
	);
	assert.equal(proof.schedule.runs.filter(({ trigger }) => trigger === "scheduled").length, 1);
	assert.equal(proof.history[0].text, "合成定时任务已完成。费用口径通过。");
	assert(proof.tasks.some(({ id, status }) => id === run.id && status === "succeeded"));
	const saved = JSON.parse(await readFile(join(store, "automation.json"), "utf8"));
	assert.equal(saved.runs[0].id, run.id);
	await writeFile(
		join(output, "result.json"),
		JSON.stringify(
			{ schedule: time, status: run.status, request: run.request, run: run.id, history: proof.history[0].text },
			null,
			2,
		),
	);
} finally {
	await app?.close().catch(() => {});
	await fixture.close();
}
