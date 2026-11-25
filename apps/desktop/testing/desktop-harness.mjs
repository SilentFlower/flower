import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

/**
 * 以假 Electron 启动真实 Main 与 preload，模型进程用 Node 子进程模拟 utilityProcess。
 * @param {string} root 测试目录，profile 与工作区都在其中
 * @param {{version?: string}} options 模拟应用安装版本
 * @returns {Promise<object>} preload 接口、界面收到的消息与重启、关闭操作
 */
export async function launchDesktop(root, { version = "test" } = {}) {
	const profile = join(root, "profile");
	const handlers = new Map();
	const updates = [];
	const children = new Set();
	const clipboardWrites = [];
	let clipboardItems = [];
	class FixtureClipboardItem {
		constructor(payload) {
			this.types = Object.keys(payload);
			this.payload = payload;
		}
		async getType(type) {
			return this.payload[type];
		}
	}
	const prompts = [];
	let sender;
	let selectedPath;
	let savePath;
	let dialogAnswer = 0;
	const bootstrap = join(root, "utility-shim.mjs");
	await writeFile(
		bootstrap,
		`
		const listeners = [];
		const pending = [];
		process.on("message", data => listeners.length ? listeners.forEach(listener => listener({ data })) : pending.push(data));
		Object.defineProperty(process, "parentPort", { value: {
			postMessage: (value) => process.send(value),
			on: (_kind, listener) => { listeners.push(listener); for (const data of pending.splice(0)) listener({ data }); },
		} });
		await import(process.argv[2]);
	`,
	);
	const app = Object.assign(new EventEmitter(), {
		commandLine: { hasSwitch: (name) => name === "user-data-dir", appendSwitch() {} },
		getPath: () => profile,
		getVersion: () => version,
		setAppUserModelId() {},
		requestSingleInstanceLock: () => true,
	});
	const electron = {
		app,
		BrowserWindow: class extends EventEmitter {
			webContents = Object.assign(new EventEmitter(), {
				send: (_channel, message) => updates.push(message),
				setWindowOpenHandler() {},
				getZoomFactor: () => 1,
				session: { setPermissionRequestHandler() {} },
			});
			isDestroyed = () => false;
			isFocused = () => true;
			isMaximized = () => false;
			isFullScreen = () => false;
			getMinimumSize = () => [640, 560];
			getBounds = () => ({ x: 0, y: 0, width: 1282, height: 801 });
			getNormalBounds = () => ({ x: 0, y: 0, width: 1282, height: 801 });
			loadFile(path) {
				sender = this.webContents;
				sender.mainFrame = { url: pathToFileURL(path).href };
				sender.emit("dom-ready");
			}
		},
		ipcMain: { handle: (name, action) => handlers.set(name, action) },
		ClipboardItem: FixtureClipboardItem,
		clipboard: {
			async writeText(text) {
				clipboardWrites.push({ text });
			},
			async read() {
				return clipboardItems;
			},
			async write(items) {
				if (!Array.isArray(items) || items.some((item) => !(item instanceof FixtureClipboardItem)))
					throw new TypeError("剪贴板需要 ClipboardItem 数组。");
				for (const item of items) {
					const mime = "image/png";
					const blob = await item.getType(mime);
					if (!(blob instanceof Blob) || blob.type !== mime) throw new TypeError("剪贴板需要 PNG Blob。");
					clipboardWrites.push({ png: Buffer.from(await blob.arrayBuffer()) });
				}
				clipboardItems = items;
			},
		},
		dialog: {
			showMessageBox: async (_window, options) => {
				prompts.push(options);
				return { response: dialogAnswer };
			},
			showOpenDialog: async () => ({ canceled: !selectedPath, filePaths: selectedPath ? [selectedPath] : [] }),
			showSaveDialog: async () => ({ canceled: !savePath, filePath: savePath }),
		},
		Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({ popup() {} }) },
		Notification: { isSupported: () => false },
		nativeImage: {
			createFromBuffer: (buffer) => ({ isEmpty: () => !buffer.length, toPNG: () => Buffer.from(buffer) }),
		},
		nativeTheme: { shouldUseDarkColors: false },
		safeStorage: {},
		screen: {
			getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
			getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
		},
		utilityProcess: {
			fork(entry) {
				const child = fork(bootstrap, [pathToFileURL(entry).href], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
				child.postMessage = (message) => child.send(message);
				children.add(child);
				child.once("exit", () => children.delete(child));
				return child;
			},
		},
		shell: {},
	};
	const key = randomUUID();
	const fixture = Symbol.for(`flower.desktop-harness.electron.${key}`);
	const moduleURL = `data:text/javascript,${encodeURIComponent(
		`export const {app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, Notification, nativeImage, nativeTheme, safeStorage, screen, shell, utilityProcess} = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(fixture))})];`,
	)}`;
	globalThis[fixture] = electron;
	const hooks = registerHooks({
		resolve: (specifier, context, next) =>
			specifier === "electron" ? { url: moduleURL, shortCircuit: true } : next(specifier, context),
	});
	const { launchWorkbench } = await import(`../workbench/main.mjs?harness=${key}`).finally(() => {
		hooks.deregister();
		delete globalThis[fixture];
	});
	let api;
	const preload = await readFile(new URL("../workbench/preload.cjs", import.meta.url), "utf8");
	runInNewContext(preload, {
		require: () => ({
			contextBridge: {
				exposeInMainWorld(_name, value) {
					api = value;
				},
			},
			ipcRenderer: {
				invoke: (channel, ...args) => handlers.get(channel)({ sender, senderFrame: sender.mainFrame }, ...args),
			},
		}),
	});
	async function stopChildren() {
		const exits = [...children].map((child) =>
			child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined,
		);
		app.emit("will-quit", { preventDefault() {} });
		for (const child of children) child.kill();
		await Promise.all(exits);
	}
	const desktop = {
		get api() {
			return api;
		},
		updates,
		clipboardWrites,
		seedClipboard(bytes) {
			clipboardItems = bytes ? [new FixtureClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })] : [];
		},
		prompts,
		confirm(response) {
			dialogAnswer = response;
		},
		choose(path) {
			selectedPath = path;
		},
		save(path) {
			savePath = path;
		},
		launch() {
			app.removeAllListeners();
			handlers.clear();
			launchWorkbench();
			app.emit("ready");
		},
		/** 等到界面收到满足条件的消息。 */
		async event(predicate, timeout = 15000) {
			const deadline = Date.now() + timeout;
			for (;;) {
				const found = updates.find((message) => message.kind === "event" && predicate(message.event));
				if (found) return found.event;
				if (Date.now() > deadline) throw new Error("等待运行事件超时");
				await delay(20);
			}
		},
		/** 等到 Main 状态满足条件。 */
		async state(predicate, timeout = 15000) {
			const deadline = Date.now() + timeout;
			for (;;) {
				const current = await api.state();
				if (predicate(current)) return current;
				if (Date.now() > deadline) throw new Error("等待工作台状态超时");
				await delay(20);
			}
		},
		async restart() {
			await stopChildren();
			updates.length = 0;
			desktop.launch();
		},
		close: stopChildren,
	};
	desktop.launch();
	return desktop;
}
