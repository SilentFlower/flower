import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createNativePanelHost } from "../workbench/native-panels.mjs";

function ptyFixture() {
	const events = new EventEmitter();
	const input = [];
	const dimensions = [];
	let killed = false;
	function observe(name, callback) {
		events.on(name, callback);
		return { dispose: () => events.off(name, callback) };
	}
	return {
		events,
		input,
		dimensions,
		onData: (callback) => observe("output", callback),
		onExit: (callback) => observe("exit", callback),
		write: (data) => input.push(data),
		resize: (cols, rows) => dimensions.push({ cols, rows }),
		kill: () => {
			killed = true;
		},
		get killed() {
			return killed;
		},
	};
}

test("终端绑定当前工作区、转发多轮输入和 Ctrl+C，换会话时撤销进程", async () => {
	let owner = "会话甲";
	const outbound = [];
	const pty = ptyFixture();
	const workspace = { id: "目录甲", root: "D:\\甲" };
	const host = createNativePanelHost({
		current: (id) => id === owner,
		associate: async () => workspace,
		send: (message) => outbound.push(message),
		spawnTerminal: async (provided, dimensions) => {
			assert.equal(provided, workspace);
			assert.deepEqual(dimensions, { cols: 80, rows: 24 });
			return pty;
		},
	});
	const { id } = await host.terminalOpen(owner, 80, 24);
	await host.terminalInput(owner, id, "pwd\r");
	await host.terminalInput(owner, id, "再次输入\r");
	await host.terminalInput(owner, id, "\x03");
	await host.terminalResize(owner, id, 92, 32);
	assert.deepEqual(pty.input, ["pwd\r", "再次输入\r", "\x03"]);
	assert.deepEqual(pty.dimensions, [{ cols: 92, rows: 32 }]);
	await assert.rejects(host.terminalInput("会话乙", id, "pwd\r"), /工作区已切换/);
	await assert.rejects(host.terminalInput(owner, "错误进程", "pwd\r"), /终端已关闭/);
	await assert.rejects(host.terminalResize(owner, id, 1000, 1000), /尺寸无效/);
	pty.events.emit("output", "第一段");
	pty.events.emit("output", "第二段");
	await delay(50);
	assert.deepEqual(outbound, [
		{ kind: "native-panel", panel: "terminal", type: "output", session: owner, id, data: "第一段第二段" },
	]);
	owner = "会话乙";
	host.close();
	assert.equal(pty.killed, true);
	await assert.rejects(host.terminalInput(owner, id, "echo 旧进程\r"), /终端已关闭/);
	pty.events.emit("output", "过期事件");
	await delay(35);
	assert.equal(outbound.length, 1);
});

test("打开进行中的终端可取消，迟到的原生进程立即回收", async () => {
	const pty = ptyFixture();
	const started = Promise.withResolvers();
	const available = Promise.withResolvers();
	const host = createNativePanelHost({
		current: (id) => id === "当前",
		associate: async () => ({ id: "工作区" }),
		send() {},
		spawnTerminal: () => {
			started.resolve();
			return available.promise;
		},
	});
	const opening = host.terminalOpen("当前", 80, 24);
	await started.promise;
	await host.terminalClose("当前", undefined);
	available.resolve(pty);
	await assert.rejects(opening, /工作区已切换/);
	assert.equal(pty.killed, true);
});

function browserFixture() {
	const views = [];
	const sessions = [];
	const parent = {
		contentView: {
			addChildView: (view) => views.push(view),
			removeChildView: (view) => views.splice(views.indexOf(view), 1),
		},
		webContents: { getZoomFactor: () => 1.25 },
		getContentSize: () => [800, 600],
		isDestroyed: () => false,
		isFocused: () => false,
	};
	const electron = {
		session: {
			fromPartition(partition, options) {
				const network = Object.assign(new EventEmitter(), {
					partition,
					options,
					setPermissionCheckHandler: (callback) => {
						network.check = callback;
					},
					setPermissionRequestHandler: (callback) => {
						network.request = callback;
					},
					setDisplayMediaRequestHandler: (callback) => {
						network.media = callback;
					},
					webRequest: {
						onBeforeRequest: (callback) => {
							network.urlCheck = callback;
						},
					},
					closeAllConnections: async () => {},
					clearAuthCache: async () => {},
					clearCache: async () => {},
					clearStorageData: async () => {
						network.cleared = true;
					},
				});
				sessions.push(network);
				return network;
			},
		},
		WebContentsView: class extends EventEmitter {
			constructor(options) {
				super();
				this.options = options;
				const history = [];
				let index = -1;
				const contents = new EventEmitter();
				const current = () => history[index] ?? "";
				const navigated = () => contents.emit("did-navigate", {}, current(), 200);
				this.webContents = Object.assign(contents, {
					isDestroyed: () => Boolean(contents.closed),
					close: () => {
						contents.closed = true;
						contents.emit("destroyed");
					},
					setWindowOpenHandler: (handler) => {
						contents.popup = handler;
					},
					navigationHistory: {
						canGoBack: () => index > 0,
						canGoForward: () => index < history.length - 1,
						goBack: () => {
							index--;
							navigated();
						},
						goForward: () => {
							index++;
							navigated();
						},
					},
					getURL: current,
					isLoadingMainFrame: () => false,
					loadURL: async (url) => {
						history.splice(++index, Infinity, url);
						navigated();
					},
					reload: navigated,
				});
			}
			setBounds(rectangle) {
				this.bounds = rectangle;
			}
			setVisible(visible) {
				this.visible = visible;
			}
		},
	};
	return { electron, parent, sessions, views };
}

test("浏览器从未选择工作区的首页可运行，前后导航与权限均关联原生隔离视图", async () => {
	const mock = browserFixture();
	const events = [];
	let current = "";
	const host = createNativePanelHost({
		window: () => mock.parent,
		current: (id) => current === id,
		associate: async () => assert.fail("网页无需读取工作区"),
		send: (event) => events.push(event),
		electron: async () => mock.electron,
	});
	host.browserBounds("", { x: 400, y: 80, width: 260, height: 500 });
	await host.browserNavigate("", "http://127.0.0.1:9001/one");
	await host.browserNavigate("", "http://127.0.0.1:9001/two");
	assert.equal(mock.views.length, 1);
	const [view] = mock.views;
	assert.deepEqual(view.bounds, { x: 500, y: 100, width: 300, height: 500 });
	assert.equal(view.visible, true);
	assert.equal(view.options.webPreferences.sandbox, true);
	assert.equal(view.options.webPreferences.contextIsolation, true);
	assert.equal(view.options.webPreferences.nodeIntegration, false);
	assert.equal(view.options.webPreferences.preload, undefined);
	assert.deepEqual(view.webContents.popup(), { action: "deny" });
	assert.equal(events.at(-1).canGoBack, true);
	host.browserAction("", "back");
	assert.match(events.at(-1).url, /one$/);
	assert.equal(events.at(-1).canGoForward, true);
	host.browserAction("", "forward");
	host.browserAction("", "reload");
	assert.match(events.at(-1).url, /two$/);
	await assert.rejects(host.browserNavigate("", "file:///C:/Windows/win.ini"), /HTTP 或 HTTPS/);
	await assert.rejects(host.browserNavigate("", "http://用戶:秘密@localhost/"), /HTTP 或 HTTPS/);
	let blocked = 0;
	view.webContents.emit("will-redirect", {
		url: "file:///C:/Windows/win.ini",
		isMainFrame: true,
		preventDefault() {
			blocked++;
		},
	});
	const [session] = mock.sessions;
	assert.equal(session.check(), false);
	session.request(undefined, "clipboard-read", (approved) => assert.equal(approved, false));
	session.media({}, (streams) => assert.deepEqual(streams, {}));
	session.emit("will-download", { preventDefault: () => blocked++ });
	session.urlCheck({ url: "file:///C:/test.txt", resourceType: "image" }, ({ cancel }) => assert.equal(cancel, true));
	session.urlCheck({ url: "data:image/png,x", resourceType: "image" }, ({ cancel }) => assert.equal(cancel, false));
	assert.equal(blocked, 2);
	host.browserBounds("", null);
	assert.equal(view.visible, false);
	current = "会话乙";
	host.close();
	assert.equal(view.webContents.closed, true);
	await assert.rejects(host.browserNavigate("", "https://example.test"), /工作区已切换/);
	await host.browserNavigate(current, "https://example.test");
	assert.equal(session.cleared, true);
	assert.equal(mock.sessions.length, 1);
	assert.equal(mock.views[0].options.webPreferences.session, session);
	host.close();
});
