import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [binary, output, tooling] = process.argv.slice(2);
assert(
	process.platform === "win32" && tooling,
	"用法：verify-native-panels-windows.mjs <EXE> <新证据目录> <Playwright>",
);
const evidence = resolve(output);
const profile = join(evidence, "profile");
const workspace = join(evidence, "终端工作区");
await mkdir(evidence);
await mkdir(workspace);
const { _electron: electron } = createRequire(join(resolve(tooling), "package.json"))("playwright");
const http = [];
const server = createServer((request, response) => {
	http.push({ path: request.url, cookie: request.headers.cookie ?? "" });
	if (request.url === "/redirect") {
		response.writeHead(302, { Location: "/two" }).end();
		return;
	}
	const first = request.url === "/one";
	response.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		...(first && { "Set-Cookie": "terminal-panel-probe=first; HttpOnly; Path=/" }),
	});
	response.end(
		first
			? '<!doctype html><title>终端联调网页甲</title><h1>第一张网页</h1><a href="/redirect" id="next">下一页</a>'
			: "<!doctype html><title>终端联调网页乙</title><h1>第二张网页</h1>",
	);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

let app;
async function until(check, description, timeout = 16000) {
	const end = Date.now() + timeout;
	do {
		try {
			const value = await check();
			if (value) return value;
		} catch {
			// 原生 iframe 和临时浏览器可能正在切换，等待目标状态。
		}
		await delay(120);
	} while (Date.now() < end);
	throw new Error(`等待超时：${description}`);
}

try {
	app = await electron.launch({
		executablePath: resolve(binary),
		args: [`--user-data-dir=${profile}`],
		chromiumSandbox: true,
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(12000);
	const by = (id) => page.locator(`#${id}`);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			/native-terminal|inline style|frame-src|Content Security Policy/i.test(message.text())
		)
			errors.push(message.text());
	});
	await app.evaluate(
		({ app, dialog }, fixture) => {
			if (app.getPath("userData").toLowerCase() !== fixture.profile.toLowerCase()) throw new Error("资料目录不符");
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.workspace] });
		},
		{ profile, workspace },
	);
	await by("workspace").waitFor();

	async function panel(mode) {
		if (!(await by("workspace-panel").isVisible())) await by("workspace-panel-toggle").click();
		await by("panel-more-tools").click();
		await page.locator(`#panel-tool-menu [data-panel-mode="${mode}"]`).click();
	}
	async function browserInfo() {
		return app.evaluate(async ({ BrowserWindow }, prefix) => {
			const window = BrowserWindow.getAllWindows()[0];
			const view = window.contentView.children.find((item) => item.webContents?.getURL().startsWith(prefix));
			if (!view) return undefined;
			const { webContents } = view;
			const guest = await webContents.executeJavaScript(
				"({title:document.title, body:document.querySelector('h1')?.textContent, preload:typeof flower, node:typeof process})",
			);
			return { ...guest, id: webContents.id, url: webContents.getURL(), bounds: view.getBounds() };
		}, origin);
	}
	async function navigate(pathname) {
		await by("native-browser-address").fill(origin + pathname);
		await by("native-browser-address").press("Enter");
		return until(async () => {
			const state = await browserInfo();
			return state?.url.endsWith(pathname) && state.body ? state : undefined;
		}, pathname);
	}

	await panel("browser");
	const first = await navigate("/one");
	assert.equal(first.preload, "undefined");
	assert.equal(first.node, "undefined");
	assert.equal(first.body, "第一张网页");
	assert(first.bounds.width > 150 && first.bounds.height > 200);
	await app.evaluate(async ({ webContents }, id) => {
		await webContents.fromId(id).executeJavaScript("document.querySelector('#next').click();void 0", true);
	}, first.id);
	await until(async () => (await browserInfo())?.body === "第二张网页", "网页内链接与回环重定向");
	await by("native-browser-back").click();
	await until(async () => (await browserInfo())?.body === "第一张网页", "浏览器后退");
	await by("native-browser-forward").click();
	await until(async () => (await browserInfo())?.body === "第二张网页", "浏览器前进");
	const previousVisits = http.filter(({ path }) => path === "/two").length;
	await by("native-browser-reload").click();
	await until(() => http.filter(({ path }) => path === "/two").length > previousVisits, "浏览器刷新");
	await by("native-browser-address").fill("file:///D:/Flower-Forbidden-Local-File.txt");
	await by("native-browser-address").press("Enter");
	await until(async () => (await by("native-browser-status").textContent()).includes("HTTP 或 HTTPS"), "禁止文件导航");
	await page.screenshot({ path: join(evidence, "browser-toolbar.png") });
	const siteImage = await app.evaluate(async ({ webContents }, id) => {
		const image = await webContents.fromId(id).capturePage();
		return Array.from(image.toPNG());
	}, first.id);
	await writeFile(join(evidence, "browser-native.png"), Buffer.from(siteImage));
	await by("workspace-panel-close").click();
	await by("workspace").click();
	await until(async () => Boolean((await page.evaluate(() => window.flower.state())).draft), "已选工作区");
	await panel("browser");
	const second = await navigate("/two");
	assert.notEqual(second.id, first.id);
	assert.equal(http.filter(({ path }) => path === "/two").at(-1).cookie, "");
	assert(http.some(({ path, cookie }) => path === "/two" && cookie.includes("terminal-panel-probe=first")));
	await writeFile(join(evidence, "browser-result.json"), JSON.stringify({ first, second, http }, null, 2));

	await panel("terminal");
	await by("native-terminal-interrupt").waitFor();
	try {
		await page.locator("#native-terminal-interrupt:not(:disabled)").waitFor({ timeout: 15000 });
	} catch (error) {
		throw new Error(`终端打开失败：${await by("native-terminal-status").textContent()}`, { cause: error });
	}
	const terminal = page.frameLocator("#native-terminal-frame");
	const input = terminal.locator(".xterm-helper-textarea");
	const lines = () => terminal.locator(".xterm-rows").innerText();
	async function type(text) {
		await input.focus();
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
	}
	await type("Write-Output (Get-Location).Path");
	await until(async () => (await lines()).replace(/[\r\n]/g, "").includes(workspace), "终端起始目录");
	await type("Write-Output ('FLOWER-'+'READY')");
	await until(async () => (await lines()).includes("FLOWER-READY"), "同一终端执行第二条命令");
	await by("sidebar-tools").click();
	await by("sidebar-automation").click();
	assert(await by("automation-settings").isVisible());
	assert(await by("native-terminal-frame").isHidden());
	await by("settings-close-dialog").click();
	assert(await by("native-terminal-frame").isVisible());
	await until(async () => (await lines()).includes("FLOWER-READY"), "返回管理页前的终端内容");
	await type("Write-Output ('FLOWER-'+'WAIT'); Start-Sleep 45; Write-Output ('SLEEP-'+'COMPLETED')");
	await until(async () => (await lines()).includes("FLOWER-WAIT"), "运行中的命令");
	await by("native-terminal-interrupt").click();
	await type("Write-Output ('FLOWER-'+'AFTER')");
	await until(async () => (await lines()).includes("FLOWER-AFTER"), "Ctrl+C 中断后执行下一条命令", 10000);
	assert(!(await lines()).includes("SLEEP-COMPLETED"));
	await page.screenshot({ path: join(evidence, "terminal.png") });
	const owner = (await page.evaluate(() => window.flower.state())).selected;
	await by("workspace-panel-close").click();
	await until(
		() =>
			by("native-terminal-frame")
				.count()
				.then((count) => count === 0),
		"收起清理终端",
	);
	assert(owner);
	assert.deepEqual(errors, []);
	await writeFile(
		join(evidence, "result.json"),
		JSON.stringify(
			{
				first,
				second,
				http,
				cwd: workspace,
				nativeCommand: "FLOWER-READY",
				interrupted: "FLOWER-AFTER",
				errors,
			},
			null,
			2,
		),
	);
} finally {
	await app?.close();
	await new Promise((done) => server.close(done));
}
