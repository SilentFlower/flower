import assert from "node:assert/strict";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright-core";

const [rootArg, directoryArg, source] = process.argv.slice(2);
assert(process.platform === "win32" && source, "参数为旧版受管理安装目录、新版更新目录和构建时的回环清单地址");
const origin = new URL(source);
assert(
	origin.protocol === "http:" &&
		origin.hostname === "127.0.0.1" &&
		origin.port &&
		origin.pathname === "/flower-desktop-update.json",
);
const root = resolve(rootArg);
const directory = resolve(directoryArg);
const feedBytes = await readFile(join(directory, "flower-desktop-update.json"));
const feed = JSON.parse(feedBytes);
const current = async () => (await readFile(join(root, "current.txt"), "utf8")).trim();
const before = await current();
assert.equal(feed.channel, "qa");
assert.notEqual(before, feed.version);
assert.equal(feed.download, `Flower-Desktop-${feed.version}-win32-x64.zip`);
const archive = join(directory, feed.download);
assert.equal((await stat(archive)).size, feed.size);
const requests = [];
const server = createServer((req, res) => {
	requests.push(req.url);
	if (req.method !== "GET") return res.writeHead(405).end();
	if (req.url === origin.pathname) return res.writeHead(200, { "content-type": "application/json" }).end(feedBytes);
	if (req.url !== `/${feed.download}`) return res.writeHead(404).end();
	res.writeHead(200, { "content-type": "application/zip", "content-length": feed.size });
	const stream = createReadStream(archive);
	stream.on("error", () => res.destroy());
	res.on("close", () => stream.destroy());
	stream.pipe(res);
});
const profile = await mkdtemp(join(tmpdir(), "flower-win-upgrade-"));
let app;
async function boot(version) {
	app = await electron.launch({
		executablePath: join(root, "versions", version, "Flower Desktop.exe"),
		args: [`--user-data-dir=${profile}`],
		chromiumSandbox: true,
		timeout: 45000,
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(20000);
	await page.waitForFunction(async (v) => {
		const s = await window.flower?.state();
		return s?.ready && s.version === v;
	}, version);
	return page;
}

try {
	server.listen(Number(origin.port), origin.hostname);
	await once(server, "listening");
	let page = await boot(before);
	await page.locator("#theme-open").click();
	await page.locator("#settings-instructions").click();
	const note = "Windows 跨版本升级的资料回读";
	await page.locator("#instructions-text").fill(note);
	await page.locator("#instructions-form [type=submit]").click();
	await page.waitForFunction(async (text) => (await window.flower.state()).instructions === text, note);
	await page.locator("#settings-update").click();
	await page.locator("#desktop-update-schedule").waitFor({ timeout: 180000 });
	await page.locator("#desktop-update-schedule").click();
	await page.waitForFunction(async () => (await window.flower.state()).desktopUpdate.scheduled);
	assert.equal(await current(), before);
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
	assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
	assert.equal(await current(), before);
	const closed = app.waitForEvent("close", { timeout: 65000 });
	await app.evaluate(({ app }) => {
		setImmediate(() => app.quit());
	});
	await closed;
	app = undefined;
	const deadline = Date.now() + 60000;
	while ((await current()) !== feed.version && Date.now() < deadline) await delay(200);
	assert.equal(await current(), feed.version);
	page = await boot(feed.version);
	assert.equal(await page.evaluate(async () => (await window.flower.state()).instructions), note);
	assert(requests.includes(origin.pathname) && requests.includes(`/${feed.download}`));
	console.log(`Windows 原生升级 ${before} → ${feed.version} 已安装，资料回读成功`);
} finally {
	try {
		await app?.close();
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
	}
}
