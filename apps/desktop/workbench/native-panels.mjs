import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checkRoot } from "./workspace.mjs";

const terminalOutputLimit = 256 * 1024;
const windowChange = "工作区已切换，请重新打开工具。";

function terminalSize(cols, rows) {
	if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 300 || rows < 1 || rows > 200)
		throw new Error("终端尺寸无效。");
	return { cols, rows };
}

async function openPty(workspace, size) {
	const cwd = await checkRoot(workspace);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !/^(?:ELECTRON_|NODE_OPTIONS$|NODE_PATH$|FLOWER_)/i.test(key)),
	);
	let spawn;
	try {
		({ spawn } = await import("node-pty"));
	} catch {
		throw new Error("当前应用缺少原生终端组件。请使用完整的 Flower Desktop 安装包。");
	}
	if (process.platform !== "win32") {
		return spawn("/bin/sh", ["-i"], { ...size, name: "xterm-256color", cwd, env });
	}
	const system = join(process.env.SystemRoot || "C:\\Windows", "System32");
	const wsl = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(.*)$/i.exec(cwd);
	if (wsl) {
		const linuxPath = wsl[2].replaceAll("\\", "/") || "/";
		return spawn(join(system, "wsl.exe"), ["--distribution", wsl[1], "--cd", linuxPath], {
			...size,
			name: "xterm-256color",
			cwd: system,
			env,
			useConpty: true,
			useConptyDll: true,
		});
	}
	return spawn(join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile"], {
		...size,
		name: "xterm-256color",
		cwd,
		env,
		useConpty: true,
		useConptyDll: true,
	});
}

function webAddress(value, explicit = false) {
	if (typeof value !== "string" || value.length > 4096 || /[\\\p{Cc}]/u.test(value)) return undefined;
	const text = value.trim();
	if (!text.length) return undefined;
	const withScheme = explicit || /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
	const url = URL.parse(withScheme);
	if (url?.hostname && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
}

function layoutBounds(host, value) {
	if (value === null) return null;
	const { x, y, width, height } = value ?? {};
	if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) throw new Error("浏览器面板尺寸无效。");
	const zoom = host.webContents.getZoomFactor();
	const [availableWidth, availableHeight] = host.getContentSize();
	const left = Math.max(0, Math.round(x * zoom));
	const top = Math.max(0, Math.round(y * zoom));
	const right = Math.min(availableWidth, Math.round((x + width) * zoom));
	const bottom = Math.min(availableHeight, Math.round((y + height) * zoom));
	return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** 管理本窗口独立的终端和网页视图，受选中会话和工作区生命周期约束。
 * @param {object} options 主窗口、当前选择、工作区复核、事件通道与测试替身
 * @returns {object} 原生面板动作与关闭入口
 */
export function createNativePanelHost({
	window: getWindow,
	current,
	associate,
	send,
	spawnTerminal = openPty,
	electron = () => import("electron"),
}) {
	let epoch = 0;
	let openingTerminal = 0;
	let terminal;
	let browser;
	let browserOpening;
	let network;
	let browserCleaning = Promise.resolve();
	let bounds;

	function requireCurrent(id) {
		if (typeof id !== "string" || !current(id)) throw new Error(windowChange);
	}

	function finishTerminal(exited = false) {
		openingTerminal++;
		if (!terminal) return;
		const old = terminal;
		terminal = undefined;
		clearTimeout(old.timer);
		for (const subscription of old.subscriptions) subscription.dispose();
		if (!exited) {
			try {
				old.pty.kill();
			} catch {
				// 进程可能刚退出。面板已解除绑定。
			}
		}
	}

	function terminalEvent(record, payload) {
		if (terminal === record && current(record.session))
			send({ kind: "native-panel", panel: "terminal", session: record.session, id: record.id, ...payload });
	}

	function flushTerminal(record) {
		clearTimeout(record.timer);
		record.timer = undefined;
		const { data, overflow } = record;
		record.data = "";
		record.overflow = false;
		if (data || overflow) {
			const output = overflow ? `${data}\x1b[0m\r\n[输出过快，已省略一部分]\r\n` : data;
			terminalEvent(record, { type: "output", data: output });
		}
	}

	async function terminalOwner(session, id) {
		requireCurrent(session);
		const record = terminal;
		if (record?.session !== session || record.id !== id) return undefined;
		const workspace = await associate(session);
		requireCurrent(session);
		if (record === terminal && record.workspaceId === workspace.id) return record;
	}

	function desktopWindow() {
		const win = getWindow();
		if (!win || win.isDestroyed()) throw new Error("工作台窗口已关闭。");
		return win;
	}

	function browserState(record) {
		if (browser !== record || !current(record.session) || record.contents.isDestroyed()) return;
		const contents = record.contents;
		send({
			kind: "native-panel",
			panel: "browser",
			type: "state",
			session: record.session,
			url: webAddress(contents.getURL(), true) ?? record.requested,
			loading: contents.isLoadingMainFrame(),
			canGoBack: contents.navigationHistory.canGoBack(),
			canGoForward: contents.navigationHistory.canGoForward(),
			error: record.error,
		});
	}

	function applyBrowserBounds(record) {
		const rect = bounds?.session === record.session ? bounds.rect : null;
		if (rect) record.view.setBounds(rect);
		record.view.setVisible(Boolean(rect));
		if (!rect && record.win.isFocused() && record.contents.isFocused()) record.win.webContents.focus();
	}

	function initializeNetwork(session) {
		const network = session.fromPartition(`flower-panel-${randomUUID()}`, { cache: false });
		network.setPermissionCheckHandler(() => false);
		network.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		network.setDisplayMediaRequestHandler((_request, callback) => callback({}));
		network.on("will-download", (event) => event.preventDefault());
		network.webRequest.onBeforeRequest((details, done) => {
			const internal = /^(?:about:blank|about:srcdoc)$/.test(details.url);
			const embedded = /^(?:data|blob):/i.test(details.url);
			const navigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
			done({
				cancel:
					!webAddress(details.url, true) &&
					!(details.resourceType !== "mainFrame" && (internal || (embedded && !navigation))),
			});
		});
		return network;
	}

	async function cleanNetwork() {
		await network.closeAllConnections();
		await Promise.all([network.clearStorageData(), network.clearAuthCache(), network.clearCache()]);
	}

	function destroyBrowser() {
		browserOpening = undefined;
		if (!browser) return;
		const old = browser;
		browser = undefined;
		old.view.setVisible(false);
		if (!old.win.isDestroyed()) old.win.contentView.removeChildView(old.view);
		const destroyed = old.contents.isDestroyed()
			? Promise.resolve()
			: new Promise((resolve) => old.contents.once("destroyed", resolve));
		if (!old.contents.isDestroyed()) old.contents.close({ waitForBeforeUnload: false });
		// 先确认网页进程已解除绑定，再清除网络和授权状态。后续会话只能在清理完成后复用分区。
		browserCleaning = destroyed.then(() => cleanNetwork());
		void browserCleaning.catch(() => {});
	}

	async function browserFor(id) {
		requireCurrent(id);
		if (browser?.session === id && !browser.contents.isDestroyed()) return browser;
		if (browserOpening?.session === id) return browserOpening.task;
		destroyBrowser();
		const stamp = epoch;
		const task = (async () => {
			const { session, WebContentsView } = await electron();
			try {
				await browserCleaning;
			} catch {
				// 未完全清理的分区不可交给另一个会话。重试清理失败时保持关闭。
				requireCurrent(id);
				if (stamp !== epoch) throw new Error(windowChange);
				browserCleaning = cleanNetwork();
				try {
					await browserCleaning;
				} catch {
					throw new Error("无法清理上一个网页会话，请稍后重试。");
				}
			}
			requireCurrent(id);
			if (stamp !== epoch) throw new Error(windowChange);
			const win = desktopWindow();
			// 一个窗口只保留一个独立内存分区，切换会话时回收 WebContents 并清空分区状态。
			network ??= initializeNetwork(session);
			const view = new WebContentsView({
				webPreferences: {
					session: network,
					sandbox: true,
					contextIsolation: true,
					nodeIntegration: false,
					webviewTag: false,
					navigateOnDragDrop: false,
					devTools: false,
					autoplayPolicy: "user-gesture-required",
					disableDialogs: true,
					disableHtmlFullscreenWindowResize: true,
					focusOnNavigation: false,
				},
			});
			const contents = view.webContents;
			const record = { session: id, win, view, contents, error: "", requested: "", navigation: 0 };
			browser = record;
			view.setVisible(false);
			win.contentView.addChildView(view);
			applyBrowserBounds(record);
			const guard = (event) => {
				if (webAddress(event.url, true) || (!event.isMainFrame && /^(?:about:blank|about:srcdoc)$/.test(event.url))) return;
				event.preventDefault();
				if (event.isMainFrame) {
					record.error = "浏览器只打开 HTTP 或 HTTPS 地址。";
					browserState(record);
				}
			};
			contents.on("will-frame-navigate", guard);
			contents.on("will-redirect", guard);
			contents.on("will-attach-webview", (event) => event.preventDefault());
			contents.on("content-bounds-updated", (event) => event.preventDefault());
			contents.on("will-prevent-unload", (event) => event.preventDefault());
			contents.setWindowOpenHandler(() => ({ action: "deny" }));
			for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page"])
				contents.on(event, () => browserState(record));
			contents.on("did-start-navigation", (event) => {
				if (event.isMainFrame && !event.isSameDocument) {
					record.requested = webAddress(event.url, true) ?? record.requested;
					record.error = "";
				}
			});
			contents.on("did-fail-load", (_event, error, _detail, _url, isMainFrame) => {
				if (isMainFrame && error !== -3) {
					record.error ||= "网页未能加载，请检查网址和连接。";
					browserState(record);
				}
			});
			contents.on("render-process-gone", () => {
				record.error = "网页进程已结束，可刷新重试。";
				browserState(record);
			});
			return record;
		})();
		browserOpening = { session: id, task };
		try {
			return await task;
		} finally {
			if (browserOpening?.task === task) browserOpening = undefined;
		}
	}

	return {
		async terminalOpen(session, cols, rows) {
			requireCurrent(session);
			const size = terminalSize(cols, rows);
			if (!session) throw new Error("请先选定终端工作区。");
			finishTerminal();
			const stamp = openingTerminal;
			const workspace = await associate(session);
			requireCurrent(session);
			if (stamp !== openingTerminal) throw new Error(windowChange);
			const pty = await spawnTerminal(workspace, size);
			if (stamp !== openingTerminal || !current(session)) {
				pty.kill();
				throw new Error(windowChange);
			}
			const record = {
				id: randomUUID(),
				session,
				workspaceId: workspace.id,
				pty,
				data: "",
				overflow: false,
				timer: undefined,
				subscriptions: [],
			};
			terminal = record;
			record.subscriptions = [
				pty.onData((data) => {
					if (terminal !== record) return;
					const available = terminalOutputLimit - record.data.length;
					record.data += data.slice(0, available);
					record.overflow ||= data.length > available;
					record.timer ??= setTimeout(() => flushTerminal(record), 25).unref();
				}),
				pty.onExit(({ exitCode }) => {
					flushTerminal(record);
					terminalEvent(record, { type: "exit", exitCode });
					if (terminal === record) finishTerminal(true);
				}),
			];
			return { id: record.id };
		},
		async terminalInput(session, id, data) {
			if (typeof data !== "string" || !data || data.length > 65536) throw new Error("终端输入无效。");
			const record = await terminalOwner(session, id);
			if (!record) throw new Error("终端已关闭。");
			record.pty.write(data);
		},
		async terminalResize(session, id, cols, rows) {
			const size = terminalSize(cols, rows);
			const record = await terminalOwner(session, id);
			record?.pty.resize(size.cols, size.rows);
		},
		async terminalClose(session, id) {
			if (id === undefined) {
				requireCurrent(session);
				if (!session) return;
				const stamp = openingTerminal;
				await associate(session);
				if (stamp === openingTerminal && current(session)) finishTerminal();
				return;
			}
			const record = await terminalOwner(session, id);
			if (record) finishTerminal();
		},
		async browserNavigate(session, raw) {
			const url = webAddress(raw);
			if (!url) throw new Error("请输入 HTTP 或 HTTPS 网页地址。");
			const record = await browserFor(session);
			requireCurrent(session);
			if (record !== browser) throw new Error(windowChange);
			record.requested = url;
			record.error = "";
			const turn = ++record.navigation;
			try {
				await record.contents.loadURL(url);
			} catch {
				if (turn === record.navigation && browser === record) record.error ||= "网页未能加载，请检查网址和连接。";
			}
			browserState(record);
		},
		browserAction(session, action) {
			requireCurrent(session);
			if (!["back", "forward", "reload"].includes(action)) throw new Error("浏览器动作无效。");
			if (browser?.session !== session || browser.contents.isDestroyed()) return;
			const { contents } = browser;
			browser.error = "";
			if (action === "reload") contents.reload();
			if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
			if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
		},
		browserBounds(session, value) {
			requireCurrent(session);
			const rect = layoutBounds(desktopWindow(), value);
			bounds = { session, rect };
			if (browser?.session === session) applyBrowserBounds(browser);
		},
		close() {
			epoch++;
			bounds = undefined;
			finishTerminal();
			destroyBrowser();
		},
	};
}
