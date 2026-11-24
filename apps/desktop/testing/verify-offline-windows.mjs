import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";

const [exeArg, evidenceArg, toolingArg] = process.argv.slice(2);
assert(
	process.platform === "win32" && toolingArg,
	"用法：verify-offline-windows.mjs <正式 EXE> <新证据目录> <Playwright>",
);
const exe = resolve(exeArg);
const evidence = resolve(evidenceArg);
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { chromium } = require("playwright");
const { ws: WebSocket } = require("playwright-core/lib/utilsBundle");
await mkdir(evidence);
const profile = join(evidence, "profile");
const controller = new AbortController();
const deadline = setTimeout(30000, undefined, { signal: controller.signal }).catch(() => {});
const child = spawn(
	exe,
	["--inspect-brk=0", "--remote-debugging-port=0", "--enable-logging=stderr", `--user-data-dir=${profile}`],
	{ cwd: dirname(exe), stdio: ["ignore", "ignore", "pipe"] },
);
const exited = once(child, "exit");
const lines = createInterface({ input: child.stderr });
const endpoint = deferred();
const chromiumEndpoint = deferred();
lines.on("line", (line) => {
	const nodeUrl = line.match(/^Debugger listening on (ws:\/\/\S+)/)?.[1];
	if (nodeUrl) endpoint.resolve(nodeUrl);
	const browserUrl = line.match(/^DevTools listening on (ws:\/\/\S+)/)?.[1];
	if (browserUrl) chromiumEndpoint.resolve(browserUrl);
});
let inspector;
let browser;
let id = 0;
const stage = "离线加载正式窗口";
const pending = new Map();

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function send(method, params = {}) {
	const request = deferred();
	const requestId = ++id;
	pending.set(requestId, request);
	inspector.send(JSON.stringify({ id: requestId, method, params }));
	return request.promise;
}

function beforeLoad() {
	const { app, BrowserWindow, session } = require("electron");
	const loadFile = BrowserWindow.prototype.loadFile;
	BrowserWindow.prototype.loadFile = function (...args) {
		this.hide();
		return loadFile.apply(this, args);
	};
	const probe = { app, BrowserWindow, session, hostRequests: 0, browserRequests: 0 };
	globalThis.offlineQA = probe;
	app.once("ready", () => {
		session.defaultSession.enableNetworkEmulation({ offline: true });
		session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
			const external = /^https?:/.test(details.url);
			if (external) probe.browserRequests++;
			callback({ cancel: external });
		});
		globalThis.fetch = async () => {
			probe.hostRequests++;
			throw new Error("离线测试拒绝网络请求");
		};
	});
}
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", {
		expression,
		includeCommandLineAPI: true,
		returnByValue: true,
		awaitPromise: true,
	});
	assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
	return result.result.value;
}

async function verify() {
	inspector = new WebSocket(await endpoint.promise);
	const paused = deferred();
	inspector.on("message", (bytes) => {
		const message = JSON.parse(bytes);
		if (message.method === "Debugger.paused") paused.resolve(message.params.callFrames[0].callFrameId);
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.error) request.reject(new Error(message.error.message));
		else request.resolve(message.result);
	});
	await once(inspector, "open");
	await send("Debugger.enable");
	await send("Runtime.runIfWaitingForDebugger");
	const installed = await send("Debugger.evaluateOnCallFrame", {
		callFrameId: await paused.promise,
		expression: `(${beforeLoad.toString()})()`,
		includeCommandLineAPI: true,
		returnByValue: true,
	});
	assert(!installed.exceptionDetails, JSON.stringify(installed.exceptionDetails));
	await send("Debugger.resume");

	browser = await chromium.connectOverCDP(await chromiumEndpoint.promise, { noDefaults: true });
	const [context] = browser.contexts();
	const page = context.pages()[0] ?? (await context.waitForEvent("page"));
	await page.waitForURL("**/workbench/index.html", { waitUntil: "domcontentloaded" });
	const main = "globalThis.offlineQA";
	assert.equal((await evaluate(`${main}.app.getPath("userData")`)).toLowerCase(), profile.toLowerCase());
	assert.equal(await evaluate(`${main}.BrowserWindow.getAllWindows()[0].isVisible()`), false);
	assert.equal(await page.evaluate(() => document.visibilityState), "hidden");
	await page.waitForFunction(() => !document.querySelector("#workspace").disabled, undefined, {
		polling: 100,
		timeout: 5000,
	});
	const state = await page.evaluate(async () => ({
		...(await window.flower.state()),
		visibility: document.visibilityState,
	}));
	assert.equal(state.visibility, "hidden");
	assert.equal(state.ready, true);
	assert.equal(state.model, "");
	assert.deepEqual(state.sessions, []);
	assert.equal(await evaluate(`${main}.hostRequests`), 0);
	assert.equal(await page.evaluate(() => Boolean(document.querySelector("#workbench"))), true);
	const appearance = await page.evaluate(() => ({
		entry: document.getElementById("theme-open")?.title,
		enabled: document.getElementById("theme-open")?.disabled === false,
		version: document.getElementById("desktop-version")?.textContent,
		mode: window.flowerTheme?.saved.mode,
		accent: window.flowerTheme?.saved.accent,
	}));
	assert.deepEqual(appearance, {
		entry: "应用设置",
		enabled: true,
		version: `版本 ${state.version}`,
		mode: "system",
		accent: "#6c54b4",
	});
	assert.equal(await evaluate(`${main}.browserRequests`), 0);
	const browserFailure = await evaluate(`${main}.session.defaultSession.fetch("http://127.0.0.1:1/offline-test")
		.then(() => "", (error) => error.message)`);
	assert.match(browserFailure, /ERR_(INTERNET_DISCONNECTED|BLOCKED_BY_CLIENT)/);
	const result = {
		exe,
		profile,
		hidden: true,
		browserFailure,
		hostRequests: 0,
		browserRequests: 0,
		ready: true,
		appearance,
	};
	await writeFile(join(evidence, "result.json"), JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result));
}

try {
	await Promise.race([
		verify(),
		deadline.then(() => {
			throw new Error(`Windows 隐藏启动验证超时，阶段为${stage}`);
		}),
		exited.then(([code]) => {
			throw new Error(`验证期间桌面进程退出：${code}`);
		}),
	]);
} finally {
	controller.abort();
	if (inspector?.readyState === WebSocket.OPEN) inspector.close();
	await browser?.close().catch(() => {});
	child.kill();
	await exited;
	lines.close();
}
