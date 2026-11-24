import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, utilityProcess } from "electron";
import { demoCatalog } from "./catalog.mjs";

const protocol = 1;
const url = new URL("./index.html", import.meta.url);
const catalog = demoCatalog();
const samples = new Set(catalog.samples.map(({ id }) => id));
const tasks = new Set(catalog.tasks.map(({ id }) => id));
const state = { core: "starting" };
const metrics = { mainPid: process.pid, electron: process.versions.electron };
globalThis.flowerPreviewDiagnostics = metrics;

let window;
let worker;
let active;
const pending = new Map();

function tell(message) {
	if (window && !window.isDestroyed()) window.webContents.send("preview:update", message);
}

function setCore(core) {
	state.core = core;
	tell({ kind: "core", core });
}

function call(type, payload) {
	if (!worker) throw new Error("核心尚未启动");
	const id = randomUUID();
	const child = worker;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error("核心响应超时"));
			child.kill();
		}, 15000);
		pending.set(id, { resolve, reject, timeout });
		try {
			child.postMessage({ protocol, id, type, ...payload });
		} catch {
			clearTimeout(timeout);
			pending.delete(id);
			reject(new Error("无法联系核心"));
		}
	});
}

function receive(frame) {
	if (!frame || frame.protocol !== protocol) return;
	if (frame.kind === "response") {
		const waiter = pending.get(frame.id);
		if (!waiter) return;
		pending.delete(frame.id);
		clearTimeout(waiter.timeout);
		if (frame.error) waiter.reject(new Error(frame.error));
		else waiter.resolve(frame.value);
		return;
	}
	if (frame.kind !== "event" || !active || frame.event.sessionId !== active.sample) return;
	const event = frame.event;
	active.requestId = event.requestId;
	if (event.runId) active.runId = event.runId;
	if (event.type === "terminal") active = undefined;
	tell({ kind: "event", event });
}

function workerClosed() {
	worker = undefined;
	active = undefined;
	for (const { reject, timeout } of pending.values()) {
		clearTimeout(timeout);
		reject(new Error("核心进程已退出"));
	}
	pending.clear();
	setCore("failed");
}

async function startCore() {
	if (worker || metrics.childStartedMs !== undefined) return;
	metrics.childStartedMs = performance.now();
	try {
		// 子进程只继承启动所需的系统环境。测试模型使用隔离环境。
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => /^(systemroot|windir|temp|tmp)$/i.test(key)),
		);
		worker = utilityProcess.fork(fileURLToPath(new URL("./worker.mjs", import.meta.url)), [], {
			serviceName: "Flower Preview Runtime",
			env,
			stdio: "ignore",
		});
		worker.on("message", receive);
		worker.once("exit", workerClosed);
		const identity = await call("init", { directory: join(app.getPath("userData"), "preview-sessions") });
		if (identity?.pid !== worker?.pid || !identity.fingerprint) throw new Error("核心身份不匹配");
		metrics.identity = identity;
		metrics.coreReadyMs = performance.now();
		setCore("ready");
	} catch {
		setCore("failed");
		worker?.kill();
	}
}

function fromWindow(event) {
	return (
		window &&
		event.sender === window.webContents &&
		event.senderFrame === window.webContents.mainFrame &&
		event.senderFrame.url === url.href
	);
}

function handle(name, action) {
	ipcMain.handle(`preview:${name}`, async (event, ...args) => {
		if (!fromWindow(event)) throw new Error("窗口来源无效");
		return action(...args);
	});
}

function requireSample(sample) {
	if (state.core !== "ready") throw new Error("核心尚未就绪");
	if (!samples.has(sample)) throw new Error("请选择内置样例文件");
}

handle("bootstrap", () => ({ catalog, core: state.core }));
handle("history", (sample) => {
	requireSample(sample);
	return call("history", { sample });
});
handle("submit", async (sample, task) => {
	requireSample(sample);
	if (!tasks.has(task) || active) throw new Error("请在当前任务结束后选择有效任务");
	const submission = { sample };
	active = submission;
	try {
		await call("submit", { sample, task });
	} catch (error) {
		if (active === submission) active = undefined;
		throw error;
	}
});
handle("cancel", () => {
	if (!active?.requestId) throw new Error("任务尚未开始或已经结束");
	return call("cancel", active).then(() => undefined);
});
ipcMain.on("preview:paint", (event) => {
	if (!fromWindow(event) || metrics.windowInteractiveMs !== undefined) return;
	metrics.windowInteractiveMs = performance.now();
	setImmediate(() => void startCore());
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.commandLine.appendSwitch("disable-background-networking");
	app.once("ready", () => {
		Menu.setApplicationMenu(null);
		window = new BrowserWindow({
			width: 1080,
			height: 760,
			minWidth: 750,
			minHeight: 630,
			title: "Flower Desktop Preview",
			backgroundColor: "#f1f4f5",
			webPreferences: {
				preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				spellcheck: false,
			},
		});
		window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		window.webContents.on("will-navigate", (event) => event.preventDefault());
		window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		void window.loadFile(fileURLToPath(url));
	});
	app.on("second-instance", () => {
		if (window?.isMinimized()) window.restore();
		window?.focus();
	});
	app.on("window-all-closed", () => app.quit());
	app.on("before-quit", () => worker?.kill());
}
