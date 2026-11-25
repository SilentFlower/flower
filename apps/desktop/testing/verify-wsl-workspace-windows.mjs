import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { startMockModel } from "./mock-model.mjs";

const [binary, evidence, tooling, unc] = process.argv.slice(2);
assert(process.platform === "win32" && unc, "用法：<EXE> <新验证目录> <Playwright> <WSL测试目录UNC>");
const require = createRequire(join(resolve(tooling), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
const profile = join(evidence, "profile");
const launch = () =>
	electron.launch({ executablePath: binary, args: [`--user-data-dir=${profile}`], chromiumSandbox: true });
const fixture = await startMockModel({ attachmentReply: () => ({ text: "工作区已验证。" }) });
let app = await launch();
try {
	const page = await app.firstWindow();
	await page.locator("#workspace:not(:disabled)").waitFor();
	// 用 WSL 共享路径模拟原生目录选择结果，第二次打开时取消以检查起始目录。
	await app.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async (_win, options) => {
			globalThis.pickerRoot = options.defaultPath;
			const filePaths = globalThis.pickerPath ? [globalThis.pickerPath] : [];
			globalThis.pickerPath = undefined;
			return { canceled: !filePaths.length, filePaths };
		};
		globalThis.pickerPath = path;
	}, unc);
	await page.locator("#workspace").click();
	await page.waitForFunction(() => window.flower.state().then(({ draft }) => Boolean(draft)));
	const state = await page.evaluate(() => window.flower.state());
	const selected = state.selected;
	assert.equal(state.sessions.length, 0);
	assert.equal(state.draft.path.toLowerCase(), unc.toLowerCase());
	const report = await page.evaluate((id) => window.flower.previewWorkspaceFile(id, "项目说明.md"), selected);
	assert.equal(report.text, "# WSL 工作区\n");
	await page.locator("#workspace").click();
	await page.waitForFunction(() => document.getElementById("workspace-label").textContent.length > 0);
	assert.equal((await app.evaluate(() => globalThis.pickerRoot)).toLowerCase(), unc.toLowerCase());
	await page.evaluate(
		(baseUrl) => window.flower.saveModel({ serviceId: "", baseUrl, modelId: "local-test", apiKey: "" }),
		fixture.baseUrl,
	);
	await page.locator("#prompt").fill("继续使用 WSL 工作区");
	await page.locator("#send").click();
	await page.locator('.task[data-status="succeeded"]').waitFor();
	assert.equal((await page.evaluate(() => window.flower.state())).selected, selected);
	assert.equal((await page.evaluate((id) => window.flower.history(id), selected)).length, 1);
	await app.close();
	app = await launch();
	const restored = await app.firstWindow();
	await restored.locator("#workspace:not(:disabled)").waitFor();
	assert.equal((await restored.evaluate(() => window.flower.state())).selected, selected);
	await restored.locator("#workspace-panel-toggle").click();
	await restored.getByRole("button", { name: "预览文件：项目说明.md" }).click();
	await restored.locator("#panel-content h1").getByText("WSL 工作区").waitFor();
	await restored.screenshot({ path: join(evidence, "WSL工作区.png"), scale: "css" });
	await writeFile(
		join(evidence, "result.json"),
		JSON.stringify({
			wslShare: true,
			pickerRoot: true,
			restored: true,
		}),
	);
} finally {
	await app.close();
	await fixture.close();
}
