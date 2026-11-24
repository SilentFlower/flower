import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	Menu,
	Notification,
	nativeTheme,
	safeStorage,
	screen,
	shell,
	utilityProcess,
} from "electron";
import {
	importAttachmentFile,
	importAttachmentImage,
	importAttachmentText,
	readStoredImage,
	readStoredPreview,
	removeStoredAttachment,
} from "./attachment-assets.mjs";
import { draftAttachments, fileReference, mergeAttachments } from "./attachment-drafts.mjs";
import { historyReference, sentImage } from "./attachment-history.mjs";
import { createAttention } from "./attention.mjs";
import { contextMenuItems, revealLabel } from "./context-menu.mjs";
import { listAvailableModels, openModelStream } from "./gateway.mjs";
import {
	describeEffortPreset,
	findService,
	loadModelLibrary,
	publicService,
	rememberModelEffortCatalog,
	runtimeSelection,
	selectModel,
	setModelEffort,
	updateService,
	writeModelLibrary,
} from "./model-library.mjs";
import { createRuntimeHost } from "./runtime-host.mjs";
import { readJson, writeJson } from "./storage.mjs";
import { containsBounds, expandedBounds, restoredBounds, roundingCorrection } from "./window-fit.mjs";
import { readWindowState, restorableBounds, savedBounds, writeWindowState } from "./window-state.mjs";
import {
	analysisFiles,
	approveFile,
	approveWorkspace,
	canAttachWorkspaceFile,
	isWorkspacePath,
	listWorkspaceEntries,
	previewWorkspaceFile,
	reportFiles,
	resolveArtifact,
	resolveMentionedPaths,
	workspaceEntryPath,
} from "./workspace.mjs";
import { gitChanges, gitDifference, trackedFiles } from "./workspace-git.mjs";

const page = new URL("./index.html", import.meta.url);
const uid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;

function replyLink(value) {
	if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\p{Cc}\\]/u.test(value)) {
		throw new Error("此回复链接无法打开。");
	}
	const url = URL.parse(value);
	if (!url?.hostname || url.username || url.password) throw new Error("此回复链接无法打开。");
	return url;
}
const writeModes = new Set(["read", "ask", "auto"]);
const storedWriteMode = (mode) => (mode === undefined ? "auto" : writeModes.has(mode) ? mode : "read");
const titlebarPalettes = {
	light: { backgroundColor: "#f2f2ed", symbolColor: "#22221f" },
	dark: { backgroundColor: "#151515", symbolColor: "#eeeeec" },
};

// 系统按钮绘制在网页上方，透明底色让标题栏和弹窗遮罩都能延伸到按钮下方。
function titlebarOverlay(palette) {
	return { height: 45, color: "#00000000", symbolColor: palette.symbolColor };
}
// 窗口外观和侧栏扩展只改变当前窗口，不依赖本机资料加载完成。
const immediateHandlers = new Set(["state", "titlebar-theme", "panel-expansion"]);

/** 启动使用独立本机资料目录的桌面工作台。
 * @returns 无返回值
 */
export function launchWorkbench() {
	if (!app.commandLine.hasSwitch("user-data-dir")) {
		const profile = join(app.getPath("appData"), "Flower Desktop Open");
		mkdirSync(profile, { recursive: true });
		app.setPath("userData", profile);
	}
	// Windows 通知按应用标识归属，标识不得含空格。
	if (process.platform === "win32") app.setAppUserModelId("Flower.Desktop.Open");
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}

	const directory = join(app.getPath("userData"), "local-workbench");
	// 窗口外框需在创建窗口前同步读取，workbench.json 在页面加载后才读取，因此单独保存。
	const windowStatePath = join(directory, "window-state.json");
	let windowSave;
	const workbenchPath = join(directory, "workbench.json");
	const settingsPath = join(directory, "model.json");
	let window;
	let host;
	let ready;
	let workbench = { workspaces: [], deletions: [], sessions: [], selected: "", draftWriteMode: "auto" };
	let workspaceSelection = new AbortController();
	let settings;
	let model;
	let reasoning;
	let library = { activeId: "", services: [] };
	let modelRevision = 0;
	let runtimeRevision = 0;
	let gatewayError = "";
	let workbenchError = "";
	let initialization;
	let initialized = false;
	let writes = Promise.resolve();
	let taskChanges = Promise.resolve();
	const activeRequests = new Map();
	const attention = createAttention();
	// 系统通知在被点击前需要保持引用，否则可能被回收而丢失点击回调。
	const notices = new Set();
	let closeConfirmed = false;
	const sessionsDirectory = join(directory, "sessions");
	let lastAttachmentDirectory;
	// 侧栏扩展前后的窗口外框。open 为 false 表示最大化期间已收起，退出最大化后再还原。
	let panelExpansion;
	const approvals = new Map();
	const modelCatalogs = new Map();
	const modelDiscovery = new WeakMap();

	function catalogFor(service) {
		const saved = modelCatalogs.get(service?.id);
		if (saved?.baseUrl === service?.baseUrl && saved?.encryptedKey === service?.encryptedKey) return saved?.levels;
	}

	function send(message) {
		if (window && !window.isDestroyed()) window.webContents.send("flower:update", message);
	}

	function state() {
		const waiting = [...approvals.values()].map(({ prompt }) => prompt);
		const waitingSessions = new Set(waiting.map(({ session }) => session));
		return {
			ready: initialized,
			version: app.getVersion(),
			model: model?.id ?? "",
			modelRevision,
			runtimeRevision,
			modelBusy: activeRequests.size > 0,
			writeMode: selectedWriteMode(),
			writeModeBusy: sessionBusy(workbench.selected),
			writeApproval: waiting.find(({ session }) => session === workbench.selected),
			modelSettings: publicService(settings, catalogFor(settings)),
			modelServices: library.services.map((service) => publicService(service, catalogFor(service))),
			gatewayError: workbenchError || gatewayError,
			workspaces: workbench.workspaces.map(({ workspace, title, pinned }) => ({
				workspaceId: workspace.id,
				workspace: title,
				path: workspace.root,
				pinned,
			})),
			sessions: workbench.sessions.map((owner) => ({
				id: owner.id,
				title: owner.title,
				workspaceId: owner.workspace.id,
				workspace:
					workbench.workspaces.find((item) => item.workspace.id === owner.workspace.id)?.title ?? owner.workspace.name,
				pinned: owner.pinned === true,
				path: owner.workspace.root,
				attachments: draftAttachments(owner),
				awaitingWrite: waitingSessions.has(owner.id),
				busy: sessionBusy(owner.id),
				indicator: attention.indicator(owner.id, waitingSessions.has(owner.id), sessionBusy(owner.id)),
			})),
			selected: workbench.selected,
		};
	}

	function announce() {
		send({ kind: "state", state: state() });
	}

	async function loadLocal() {
		try {
			const stored = await readJson(workbenchPath);
			const sessions = (stored?.sessions ?? []).filter(
				({ id, workspace, title }) =>
					uid.test(id) &&
					typeof workspace?.root === "string" &&
					typeof workspace?.id === "string" &&
					typeof title === "string",
			);
			// 旧格式只在会话上保存目录。单独登记后，空工作区仍然能创建新会话。
			const spaces = new Map();
			for (const item of stored?.workspaces ?? []) {
				if (
					typeof item.workspace?.id === "string" &&
					typeof item.workspace.root === "string" &&
					typeof item.title === "string"
				)
					spaces.set(item.workspace.id, item);
			}
			for (const { workspace } of sessions) {
				if (!spaces.has(workspace.id)) spaces.set(workspace.id, { workspace, title: workspace.name });
			}
			workbench = {
				workspaces: [...spaces.values()],
				deletions: (stored?.deletions ?? []).filter((id) => uid.test(id) && !sessions.some((entry) => entry.id === id)),
				sessions: sessions.map((entry) => ({ ...entry, writeMode: storedWriteMode(entry.writeMode) })),
				selected: sessions.some(({ id }) => id === stored?.selected) ? stored.selected : "",
				draftWriteMode: storedWriteMode(stored?.draftWriteMode),
			};
		} catch {
			workbenchError = "无法读取本机会话。请检查应用资料目录。";
		}
		try {
			library = await loadModelLibrary(settingsPath, safeStorage);
			refreshModel();
			if (settings?.keyUnavailable) gatewayError = "无法解密已保存的 API Key。请在模型设置中重新输入或清除。";
		} catch {
			gatewayError = "无法读取本机模型设置，请重新配置。";
		}
		if (workbench.deletions.length) await cleanDeleted().catch(() => {});
		initialized = true;
		announce();
	}

	async function record() {
		const snapshot = structuredClone(workbench);
		const write = writes.then(() => writeJson(workbenchPath, snapshot));
		writes = write.catch(() => {});
		await write;
		announce();
	}

	function findSession(id) {
		if (typeof id !== "string" || !uid.test(id)) throw new Error("请选择有效会话");
		const session = workbench.sessions.find((item) => item.id === id);
		if (!session) throw new Error("没有找到对应的本机会话。");
		return session;
	}

	function selectWorkspaceSession(id) {
		if (workbench.selected === id) return;
		workspaceSelection.abort(new Error("会话已切换，请重新读取工作区。"));
		workspaceSelection = new AbortController();
		workbench.selected = id;
	}

	async function readSelectedWorkspace(id, read) {
		const { workspace } = findSession(id);
		if (id !== workbench.selected) throw new Error("只能读取当前会话的工作区。");
		// 捕获本次选择的信号，切走再切回时也会丢弃旧结果。
		const { signal } = workspaceSelection;
		try {
			return await read(workspace, signal);
		} finally {
			signal.throwIfAborted();
		}
	}

	function requireWritableWorkbench() {
		if (workbenchError) throw new Error(workbenchError);
	}

	function serializeTaskChange(action) {
		// 提交与模型、权限变更同序，队列中的请求保留原有权限。
		const next = taskChanges.then(action);
		taskChanges = next.catch(() => {});
		return next;
	}

	function selectedWriteMode() {
		return workbench.sessions.find(({ id }) => id === workbench.selected)?.writeMode ?? workbench.draftWriteMode;
	}

	function sessionBusy(id) {
		return [...activeRequests.values()].some(({ session }) => session === id);
	}

	function isCurrentRun({ session, requestId, runId }) {
		const active = activeRequests.get(requestId);
		return active && active.session === session && active.runId === runId && active.running;
	}

	function dismissApprovals(matches = () => true) {
		for (const { prompt, finish } of approvals.values()) {
			if (matches(prompt)) finish("deny");
		}
	}

	function cancelRun(session, requestId, runId) {
		const active = activeRequests.get(requestId);
		if (active?.session === session && active.runId === runId) active.running = false;
		const cancellation = host.call("cancel-running", { session, runId });
		dismissApprovals((prompt) => prompt.session === session && prompt.runId === runId);
		return cancellation;
	}

	function authorizeWrite(frame, signal) {
		const { id, session, requestId, runId, workspaceId, input, directory: folder } = frame;
		if (
			signal.aborted ||
			!uid.test(id) ||
			!uid.test(runId) ||
			!isCurrentRun(frame) ||
			typeof input !== "string" ||
			input.length > 1024 ||
			typeof folder !== "string" ||
			!folder.startsWith("Flower-分析-") ||
			!uid.test(folder.slice("Flower-分析-".length))
		)
			return "deny";
		const owner = findSession(session);
		if (owner.workspace.id !== workspaceId) return "deny";
		const names = [analysisFiles, reportFiles].find(
			(items) =>
				Array.isArray(frame.files) &&
				items.length === frame.files.length &&
				items.every((name, index) => name === frame.files[index]),
		);
		if (!names) return "deny";
		if (owner.writeMode === "read") return "read";
		if (owner.writeMode === "auto") return "allow";
		if (approvals.has(id) || !window || window.isDestroyed()) return "deny";
		const prompt = {
			id,
			session,
			requestId,
			runId,
			input,
			workspace: owner.workspace.root,
			files: names.map((name) => `${folder}/${name}`),
		};
		return new Promise((resolve) => {
			const finish = (decision) => {
				if (!approvals.delete(id)) return;
				signal.removeEventListener("abort", abort);
				resolve(decision);
				announce();
			};
			const abort = () => finish("deny");
			approvals.set(id, { prompt, finish });
			signal.addEventListener("abort", abort, { once: true });
			announce();
			remind(session, "需要你批准写入");
		});
	}

	/**
	 * 窗口不在前台时提醒用户：闪烁任务栏并发送系统通知，点击通知回到对应会话。
	 * @param {string} session 会话 ID
	 * @param {string} body 通知正文
	 * @returns {void}
	 */
	function remind(session, body) {
		if (!window || window.isDestroyed() || window.isFocused()) return;
		window.flashFrame(true);
		if (!Notification.isSupported()) return;
		const title = workbench.sessions.find(({ id }) => id === session)?.title || "Flower Desktop";
		const notice = new Notification({ title, body });
		notices.add(notice);
		notice.once("close", () => notices.delete(notice));
		notice.once("click", () => {
			notices.delete(notice);
			if (!window || window.isDestroyed()) return;
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
			send({ kind: "focus-session", id: session });
		});
		notice.show();
	}

	/**
	 * 任务进入终态后标记未读并提醒。用户主动取消或拒绝授权的任务不提醒。
	 * @param {string} session 会话 ID
	 * @param {object} event 终态事件
	 * @returns {void}
	 */
	function noticeTerminal(session, event) {
		const viewing = session === workbench.selected && Boolean(window?.isFocused());
		const mark = attention.terminal(session, event.status, viewing);
		if (!mark) return;
		const reason = event.failure?.message?.split(/(?<=[。！？])/)[0];
		remind(session, mark === "done" ? "任务已完成" : `任务未完成${reason ? `：${reason}` : ""}`);
	}

	function prepare() {
		if (ready) return ready;
		const instance = createRuntimeHost({
			fork: utilityProcess.fork,
			directory,
			model,
			onEvent(event) {
				if (host !== instance) return;
				const { type, sessionId: session, requestId, runId } = event;
				const added = type === "queued" && !activeRequests.has(requestId);
				if (added || type === "started") activeRequests.set(requestId, { session, runId, running: type === "started" });
				if (type === "cancelling") {
					const active = activeRequests.get(requestId);
					if (active) active.running = false;
				}
				if (type === "terminal") activeRequests.delete(requestId);
				if (type === "terminal" || type === "cancelling") dismissApprovals((prompt) => prompt.requestId === requestId);
				const visible = event.type === "tool_result" ? { ...event, text: [] } : event;
				send({ kind: "event", event: visible });
				if (type === "terminal") noticeTerminal(session, event);
				if (added || type === "started" || type === "terminal") announce();
			},
			onReasoning(frame) {
				if (host !== instance || !workbench.sessions.some(({ id }) => id === frame.sessionId)) return;
				send({ kind: "reasoning", ...frame });
			},
			onExit() {
				if (host !== instance) return;
				host = undefined;
				ready = undefined;
				activeRequests.clear();
				runtimeRevision++;
				gatewayError = "工作进程已关闭，请重新发起任务。";
				announce();
			},
			gateway({ context, maxTokens, reasoningOff, signal }) {
				return openModelStream({
					settings,
					model,
					reasoning: reasoningOff ? undefined : reasoning,
					context,
					signal,
					maxTokens,
				});
			},
			authorizeWrite,
		});
		host = instance;
		ready = instance.ready
			.then(() => instance)
			.catch((error) => {
				if (host === instance) {
					instance.close();
					host = undefined;
					ready = undefined;
					activeRequests.clear();
				}
				throw error;
			});
		return ready;
	}

	function refreshModel() {
		settings = findService(library);
		({ model, reasoning } = runtimeSelection(settings, catalogFor(settings)));
	}

	function requireModelChange(revision) {
		if (activeRequests.size) throw new Error("请等待运行和排队任务结束后再更改模型设置。");
		if (revision !== modelRevision) throw new Error("模型设置已变化，请重新打开模型选择。");
	}

	async function syncRuntimeModel() {
		try {
			const runtime = await ready;
			if (runtime) await runtime.call("configure", { model });
		} catch {
			host?.close();
			host = undefined;
			ready = undefined;
		}
		announce();
	}

	async function applyLibrary(next) {
		const active = findService(next);
		const discovered = catalogFor(active);
		if (discovered) next = rememberModelEffortCatalog(next, active.id, discovered);
		await writeModelLibrary(settingsPath, next);
		library = next;
		for (const service of library.services) {
			if (!catalogFor(service)) modelCatalogs.delete(service.id);
		}
		refreshModel();
		modelRevision++;
		gatewayError = settings?.keyUnavailable ? "无法解密已保存的 API Key。请重新输入或清除。" : "";
		await syncRuntimeModel();
		return modelRevision;
	}

	function currentWindow(event) {
		const frame = event.senderFrame;
		return (
			window &&
			!window.isDestroyed() &&
			event.sender === window.webContents &&
			frame === window.webContents.mainFrame &&
			frame?.url === page.href
		);
	}

	function handle(name, action) {
		ipcMain.handle(`flower:${name}`, async (event, ...args) => {
			if (!currentWindow(event)) throw new Error("窗口来源无效");
			if (!immediateHandlers.has(name)) {
				if (!initialization) throw new Error("工作台正在初始化");
				await initialization;
				if (!currentWindow(event)) throw new Error("窗口来源无效");
			}
			return action(...args);
		});
	}

	async function getSessionRuntime(id) {
		const session = findSession(id);
		const runtime = await prepare();
		await runtime.call("register", { session: id, workspace: session.workspace });
		return runtime;
	}

	handle("state", state);
	handle("titlebar-theme", (mode) => {
		if (mode !== "light" && mode !== "dark") throw new Error("无效的窗口外观");
		if (process.platform === "win32") window.setTitleBarOverlay(titlebarOverlay(titlebarPalettes[mode]));
	});

	function panelResult(change) {
		const zoom = window.webContents.getZoomFactor();
		const extra = panelExpansion?.open ? panelExpansion.after.width - panelExpansion.before.width : 0;
		return { extra: extra / zoom, change: change / zoom };
	}

	function placeWindow(target) {
		const display = screen.getDisplayMatching(target).id;
		window.setBounds(target);
		// 分数缩放下 DIP 与物理像素互换会让外框外扩约 1 DIP，反复开关会逐次累加。
		// 仍在同一显示器时按回读差值补偿一次；差值过大视为系统钳制，保留系统结果。
		const correction = roundingCorrection(target, window.getBounds());
		if (correction && screen.getDisplayMatching(window.getBounds()).id === display) window.setBounds(correction);
		return window.getBounds();
	}

	function expandForPanel(width) {
		if (panelExpansion) {
			// 最大化期间重新打开侧栏时取消待还原，沿用原有扩展。
			panelExpansion.open = true;
			return panelResult(0);
		}
		if (window.isMaximized() || window.isFullScreen()) return panelResult(0);
		const before = window.getBounds();
		const area = screen.getDisplayMatching(before).workArea;
		const next = expandedBounds(before, area, width * window.webContents.getZoomFactor());
		if (next.width === before.width) return panelResult(0);
		const after = placeWindow(next);
		panelExpansion = { before, after, contained: containsBounds(area, before), open: true };
		return panelResult(after.width - before.width);
	}

	function restoreFromPanel() {
		if (!panelExpansion) return panelResult(0);
		if (window.isMaximized() || window.isFullScreen()) {
			panelExpansion.open = false;
			return panelResult(0);
		}
		const record = panelExpansion;
		panelExpansion = undefined;
		const now = window.getBounds();
		const [minimumWidth] = window.getMinimumSize();
		const restored = placeWindow(
			restoredBounds(record, now, minimumWidth, (bounds) => screen.getDisplayMatching(bounds).workArea),
		);
		return panelResult(restored.width - now.width);
	}

	/** 保存窗口位置、尺寸与最大化状态。全屏期间不更新。@returns {void} */
	function saveWindowState() {
		clearTimeout(windowSave);
		windowSave = undefined;
		if (!window || window.isDestroyed() || window.isFullScreen()) return;
		const [minimumWidth] = window.getMinimumSize();
		const bounds = savedBounds(window.getNormalBounds(), panelExpansion, minimumWidth, (target) => {
			return screen.getDisplayMatching(target).workArea;
		});
		try {
			mkdirSync(directory, { recursive: true });
			writeWindowState(windowStatePath, { ...bounds, maximized: window.isMaximized() });
		} catch {
			// 窗口状态只是便利功能，写入失败时下次使用默认尺寸。
		}
	}
	const scheduleWindowSave = () => {
		clearTimeout(windowSave);
		windowSave = setTimeout(saveWindowState, 500);
	};

	function restorePendingPanel() {
		if (panelExpansion?.open === false) restoreFromPanel();
	}

	handle("panel-expansion", (width) => {
		if (typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > 16000)
			throw new Error("无效的侧栏宽度");
		return width > 0 ? expandForPanel(width) : restoreFromPanel();
	});
	handle("save-model", (input) =>
		serializeTaskChange(() => {
			requireModelChange(input?.revision ?? modelRevision);
			return applyLibrary(updateService(library, input, safeStorage));
		}),
	);
	handle("list-models", async (id, revision) => {
		if (revision !== undefined && revision !== modelRevision) throw new Error("模型设置已变化，请重新打开设置。");
		const configured = findService(library, id);
		if (!configured) throw new Error("请先配置模型服务。");
		const started = library;
		const request = Symbol();
		modelDiscovery.set(configured, request);
		const levels = new Map();
		const ids = await listAvailableModels(configured, undefined, levels);
		return serializeTaskChange(async () => {
			if (started !== library) throw new Error("模型设置已变化，请重新打开模型选择。");
			// 正在执行的请求和队列共用当前运行配置，发现列表只能在空闲时更新能力。
			if (
				!activeRequests.size &&
				modelDiscovery.get(configured) === request &&
				(levels.size || modelCatalogs.has(configured.id) || configured.verifiedEffort)
			) {
				const next = rememberModelEffortCatalog(library, configured.id, levels);
				if (next !== library) {
					await writeModelLibrary(settingsPath, next);
					library = next;
				}
				if (levels.size) {
					modelCatalogs.set(configured.id, { baseUrl: configured.baseUrl, encryptedKey: configured.encryptedKey, levels });
				} else {
					modelCatalogs.delete(configured.id);
				}
				if (configured.id === library.activeId) {
					refreshModel();
					await syncRuntimeModel();
				}
			}
			return ids;
		});
	});
	handle("model-effort-preset", (id, value) => {
		const configured = id ? findService(library, id) : undefined;
		return describeEffortPreset(configured, value, catalogFor(configured));
	});
	handle("choose-model", (value, revision) =>
		serializeTaskChange(() => {
			requireModelChange(revision);
			if (value !== settings?.modelId) return applyLibrary(selectModel(library, value));
		}),
	);
	handle("choose-model-service", (id, revision) =>
		serializeTaskChange(() => {
			requireModelChange(revision);
			if (!findService(library, id)) throw new Error("模型服务已变化，请重新打开模型选择。");
			if (id !== library.activeId) return applyLibrary({ ...library, activeId: id });
		}),
	);
	handle("set-model-effort", (effort, revision) =>
		serializeTaskChange(() => {
			requireModelChange(revision);
			return applyLibrary(setModelEffort(library, effort, catalogFor(settings)));
		}),
	);
	handle("set-write-mode", (session, mode) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			if (session !== workbench.selected || !writeModes.has(mode)) throw new Error("无效的会话权限选择。");
			if (sessionBusy(session)) throw new Error("等待本会话的运行和排队任务结束后可更改权限。");
			const owner = session ? findSession(session) : workbench;
			const field = session ? "writeMode" : "draftWriteMode";
			const previous = owner[field];
			owner[field] = mode;
			try {
				await record();
			} catch (error) {
				owner[field] = previous;
				announce();
				throw error;
			}
		}),
	);
	handle("decide-write", (id, allowed) => {
		const entry = approvals.get(id);
		if (!entry) return false;
		if (!isCurrentRun(entry.prompt)) {
			entry.finish("deny");
			return false;
		}
		if (entry.prompt.session !== workbench.selected) return false;
		entry.finish(allowed === true ? "allow" : "deny");
		return true;
	});
	handle("choose-workspace", async () => {
		requireWritableWorkbench();
		const current = workbench.sessions.find(({ id }) => id === workbench.selected) ?? workbench.sessions[0];
		const selection = await dialog.showOpenDialog(window, {
			title: "选择 Flower 工作区",
			defaultPath: current?.workspace.root,
			properties: ["openDirectory"],
		});
		if (selection.canceled || !selection.filePaths[0]) return;
		let workspace;
		try {
			workspace = await approveWorkspace(selection.filePaths[0]);
		} catch (error) {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error("找不到这个目录。请确认目录仍然存在。");
			if (error.code === "EACCES" || error.code === "EPERM")
				throw new Error("没有访问这个目录的权限。请检查目录对当前用户的权限。");
			throw error;
		}
		return serializeTaskChange(async () => {
			const previous = structuredClone(workbench);
			if (!workbench.workspaces.some((item) => item.workspace.id === workspace.id))
				workbench.workspaces.unshift({ workspace, title: workspace.name });
			return createSession(workspace, workspace.name || "新会话", selectedWriteMode(), previous);
		});
	});

	async function persistChange(previous) {
		try {
			await record();
		} catch (error) {
			selectWorkspaceSession(previous.selected);
			workbench = previous;
			announce();
			if (error.code === "ENOSPC") throw new Error("应用资料所在磁盘空间不足。请释放空间后重试。");
			throw error;
		}
	}

	async function createSession(workspace, title, writeMode, previous = structuredClone(workbench)) {
		const id = randomUUID();
		workbench.sessions.unshift({ id, title, workspace, writeMode });
		selectWorkspaceSession(id);
		await persistChange(previous);
		return id;
	}

	handle("new-session", (current) =>
		serializeTaskChange(() => {
			requireWritableWorkbench();
			const previous = findSession(current);
			const title =
				workbench.workspaces.find((entry) => entry.workspace.id === previous.workspace.id)?.title ??
				previous.workspace.name;
			return createSession(previous.workspace, `${title} · 新会话`, previous.writeMode);
		}),
	);
	handle("select-session", (id) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			if (id !== "") findSession(id);
			const previous = structuredClone(workbench);
			selectWorkspaceSession(id);
			attention.clear(id);
			await persistChange(previous);
		}),
	);

	async function cleanDeleted() {
		// 先持久化移除意图。中途退出时，下次启动按同一组会话 ID 继续清理。
		const base = await lstat(sessionsDirectory).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (base && (!base.isDirectory() || base.isSymbolicLink())) throw new Error("本机会话目录位置已变化。");
		const assets = join(sessionsDirectory, "attachment-assets");
		const info = await lstat(assets).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("本机附件目录位置已变化。");
		for (const id of workbench.deletions) {
			await rm(join(sessionsDirectory, `${id}.json`), { force: true });
			if (info) await rm(join(assets, id), { recursive: true, force: true, maxRetries: 2 });
		}
		workbench.deletions = [];
		await record();
	}

	handle("manage-sidebar", (type, id, operation, value) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			const space = type === "workspace";
			if (!space && type !== "session") throw new Error("无效的侧栏项目。");
			const item = space ? workbench.workspaces.find((entry) => entry.workspace.id === id) : findSession(id);
			if (!item) throw new Error("工作区已移除。");
			const members = space ? workbench.sessions.filter((entry) => entry.workspace.id === id) : [item];
			if (operation === "create" && space)
				return createSession(item.workspace, `${item.title} · 新会话`, members[0]?.writeMode ?? workbench.draftWriteMode);
			const previous = structuredClone(workbench);
			if (operation === "pin" && typeof value === "boolean") item.pinned = value;
			else if (operation === "rename" && typeof value === "string" && value.trim() && value.trim().length <= 120)
				item.title = value.trim();
			else if (operation === "delete") {
				if (space && value !== members.length) throw new Error("工作区的会话数已变化，请重新确认。");
				if (members.some((entry) => sessionBusy(entry.id))) throw new Error("请先结束此处正在运行或排队的任务。");
				const deleted = new Set(members.map((entry) => entry.id));
				workbench.sessions = workbench.sessions.filter((entry) => !deleted.has(entry.id));
				if (space) workbench.workspaces = workbench.workspaces.filter((entry) => entry !== item);
				if (deleted.has(workbench.selected))
					selectWorkspaceSession(
						workbench.sessions.find((entry) => entry.workspace.id === item.workspace.id)?.id ??
							workbench.sessions[0]?.id ??
							"",
					);
				workbench.deletions.push(...deleted);
			} else throw new Error("无效的侧栏操作或名称。");
			await persistChange(previous);
			if (operation === "delete" && workbench.deletions.length)
				await cleanDeleted().catch(() => {
					throw new Error("已从侧栏移除。部分本机记录将在下次启动时清理。");
				});
		}),
	);
	handle("git-changes", (id) => readSelectedWorkspace(id, gitChanges));
	handle("git-difference", (id, path, group) =>
		readSelectedWorkspace(id, (workspace, signal) => gitDifference(workspace, path, group, signal)),
	);
	handle("list-workspace-entries", (id, directory, offset) =>
		readSelectedWorkspace(id, async (workspace, signal) => {
			const page = await listWorkspaceEntries(workspace, directory, offset, signal);
			return {
				...page,
				entries: page.entries.map((entry) => ({
					...entry,
					attachable: entry.kind === "file" && canAttachWorkspaceFile(entry.name),
				})),
			};
		}),
	);
	handle("show-path-menu", (id, path, preview) =>
		readSelectedWorkspace(id, async (workspace) => {
			const actual = await workspaceEntryPath(workspace, path);
			// 菜单点击与关闭回调的先后因平台而异，先到者决定结果，「预览」交还渲染层在右栏打开。
			return new Promise((resolve) => {
				const items = [
					...(preview === true ? [{ label: "预览", click: () => resolve("preview") }, { type: "separator" }] : []),
					{ label: revealLabel, click: () => shell.showItemInFolder(actual) },
					{ label: "复制路径", click: () => clipboard.writeText(actual) },
				];
				Menu.buildFromTemplate(items).popup({ window, callback: () => resolve("") });
			});
		}),
	);
	handle("resolve-reply-paths", (id, paths) =>
		readSelectedWorkspace(id, (workspace, signal) =>
			resolveMentionedPaths(workspace, paths, signal, () => trackedFiles(workspace, signal)),
		),
	);
	handle("preview-workspace-file", (id, path) =>
		readSelectedWorkspace(id, async (workspace, signal) => ({
			...(await previewWorkspaceFile(workspace, path, signal)),
			attachable: canAttachWorkspaceFile(path),
		})),
	);
	function draftOwner(id) {
		requireWritableWorkbench();
		if (workbench.selected !== id) throw new Error("会话已切换，请在当前会话添加附件。");
		return findSession(id);
	}
	async function writeDraft(owner, refs) {
		const old = owner.attachments;
		const legacy = owner.file;
		owner.attachments = refs;
		delete owner.file;
		try {
			await record();
		} catch (error) {
			owner.attachments = old;
			owner.file = legacy;
			throw error;
		}
	}
	// 历史请求仍然引用的副本要保留，草稿取消和部分导入失败则可以回收。
	async function discardUnused(owner, refs) {
		const draft = new Set(draftAttachments(owner).map(({ id }) => id));
		const candidates = refs.filter((ref) => ref.id.startsWith("asset:") && !draft.has(ref.id));
		if (!candidates.length) return;
		const snapshot = await readJson(join(sessionsDirectory, `${owner.id}.json`));
		const used = new Set(snapshot?.requests.flatMap((request) => (request.attachments ?? []).map(({ id }) => id)));
		for (const ref of candidates) if (!used.has(ref.id)) await removeStoredAttachment(sessionsDirectory, owner.id, ref);
	}
	function addPaths(id, paths, fromPanel = false) {
		return serializeTaskChange(async () => {
			const owner = draftOwner(id);
			if (!Array.isArray(paths) || paths.length > 8) throw new Error("每条消息最多添加 8 个附件。");
			const refs = [];
			try {
				for (const path of paths) {
					if (typeof path !== "string" || !path || path.length > 4096) throw new Error("文件路径无效。");
					if (!canAttachWorkspaceFile(path)) throw new Error(`暂不支持将「${basename(path)}」作为模型附件。`);
					if (fromPanel || isWorkspacePath(owner.workspace, path)) {
						const relative = await approveFile(owner.workspace, fromPanel ? resolve(owner.workspace.root, path) : path);
						refs.push(fileReference(relative));
					} else {
						refs.push(await importAttachmentFile(sessionsDirectory, id, path));
					}
				}
				draftOwner(id);
				await writeDraft(owner, mergeAttachments(owner, refs));
			} catch (error) {
				await discardUnused(owner, refs);
				throw error;
			}
		});
	}
	handle("choose-file", async (id) => {
		const session = draftOwner(id);
		const selection = await dialog.showOpenDialog(window, {
			title: "添加对话附件",
			defaultPath: lastAttachmentDirectory ?? session.workspace.root,
			properties: ["openFile", "multiSelections"],
		});
		if (!selection.canceled && selection.filePaths.length) {
			await addPaths(id, selection.filePaths);
			lastAttachmentDirectory = dirname(selection.filePaths[0]);
		}
	});
	handle("drop-files", (id, paths) => addPaths(id, paths));
	handle("reference-file", (id, path) => addPaths(id, [path], true));
	function addImage(id, readBytes) {
		return serializeTaskChange(async () => {
			const owner = draftOwner(id);
			const names = new Set(draftAttachments(owner).map(({ name }) => name));
			let number = 1;
			while (names.has(`截图 ${number}.png`)) number++;
			const ref = await importAttachmentImage(sessionsDirectory, id, readBytes(), `截图 ${number}.png`);
			try {
				draftOwner(id);
				await writeDraft(owner, mergeAttachments(owner, [ref]));
			} catch (error) {
				await discardUnused(owner, [ref]);
				throw error;
			}
		});
	}
	handle("paste-image", (id, bytes) => addImage(id, () => bytes));
	handle("paste-text", (id, text) =>
		serializeTaskChange(async () => {
			const owner = draftOwner(id);
			if (typeof text !== "string") throw new Error("粘贴的文本无效。");
			const drafted = draftAttachments(owner);
			if (drafted.length >= 8) throw new Error("每条消息最多添加 8 个附件。");
			// 以行数命名便于辨认；同名时编号，避免模型按名称引用时出现歧义。
			const lines = text.split(/\r\n|\r|\n/).length;
			const names = new Set(drafted.map(({ name }) => name));
			let name = `粘贴的文本（${lines} 行）.txt`;
			for (let number = 2; names.has(name); number++) name = `粘贴的文本 ${number}（${lines} 行）.txt`;
			const ref = await importAttachmentText(sessionsDirectory, id, text, name);
			try {
				draftOwner(id);
				await writeDraft(owner, mergeAttachments(owner, [ref]));
			} catch (error) {
				await discardUnused(owner, [ref]);
				throw error;
			}
		}),
	);
	handle("paste-clipboard-image", (id) =>
		addImage(id, () => {
			// 只在用户选择粘贴后读取系统图片，页面通过会话附件接口获取预览。
			const image = clipboard.readImage();
			if (image.isEmpty()) throw new Error("剪贴板中没有图片。");
			const bytes = image.toPNG();
			if (bytes.length <= 4 * 1024 * 1024) return bytes;
			const { width, height } = image.getSize();
			const scale = Math.min(1, 1800 / Math.max(width, height));
			return image
				.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
				.toPNG();
		}),
	);
	handle("remove-attachment", (id, key) =>
		serializeTaskChange(async () => {
			const owner = draftOwner(id);
			const refs = draftAttachments(owner);
			await writeDraft(
				owner,
				refs.filter((ref) => ref.id !== key),
			);
			await discardUnused(
				owner,
				refs.filter((ref) => ref.id === key),
			);
		}),
	);

	// 同屏的多张历史缩略图共享同一次快照读取，页面只拿到指定图片。
	const imageReads = new Map();
	function imageSnapshot(sessionId) {
		if (!imageReads.has(sessionId))
			imageReads.set(
				sessionId,
				readJson(join(sessionsDirectory, `${sessionId}.json`)).finally(() => imageReads.delete(sessionId)),
			);
		return imageReads.get(sessionId);
	}
	const attachmentPreview = (id, requestId, key, imageOnly) =>
		readSelectedWorkspace(id, async (workspace, signal) => {
			let ref;
			let record;
			let snapshot;
			if (requestId == null) {
				ref = draftAttachments(findSession(id)).find((item) => item.id === key);
			} else {
				if (!uid.test(requestId)) throw new Error("无效的消息。");
				snapshot = await imageSnapshot(id);
				({ ref, record } = historyReference(snapshot, requestId, key));
			}
			if (!ref) throw new Error("没有找到这个附件。");
			if (!imageOnly) {
				if (ref.id.startsWith("asset:")) return readStoredPreview(sessionsDirectory, id, ref, signal);
				if (ref.id.startsWith("file:")) return previewWorkspaceFile(workspace, ref.id.slice(5), signal);
			}
			if (!/\.(png|jpe?g|jpe|jfif|webp)$/i.test(ref.name)) throw new Error("没有找到这张图片。");
			if (ref.id.startsWith("asset:")) return readStoredImage(sessionsDirectory, id, ref, signal);
			const captured = record && sentImage(snapshot, record, ref);
			if (captured) return captured;
			if (ref.id.startsWith("file:")) {
				const preview = await previewWorkspaceFile(workspace, ref.id.slice(5), signal);
				if (preview.kind === "image") return { mime: preview.mime, bytes: preview.bytes };
			}
			throw new Error("这条历史消息中没有保存可预览的图片。");
		});
	handle("attachment-image", (id, request, key) => attachmentPreview(id, request, key, true));
	handle("attachment-preview", (id, request, key) => attachmentPreview(id, request, key, false));
	handle("history", (id) =>
		serializeTaskChange(async () => {
			const runtime = await getSessionRuntime(id);
			return runtime.call("history", { session: id });
		}),
	);
	handle("context-usage", (id) =>
		serializeTaskChange(async () => {
			const runtime = await getSessionRuntime(id);
			return runtime.call("context-usage", { session: id });
		}),
	);
	handle("copy-reply", async (id, requestId) => {
		if (typeof requestId !== "string" || !uid.test(requestId)) throw new Error("无效请求标识");
		const runtime = await getSessionRuntime(id);
		const history = await runtime.call("history", { session: id });
		const record = history.find((entry) => entry.requestId === requestId);
		if (!record?.text) throw new Error("回复原文暂不可用。");
		clipboard.writeText(record.text);
	});
	handle("open-reply-link", (value) => shell.openExternal(replyLink(value).href));
	/** 当前模型只支持文本时拒绝图片附件。@param {readonly {id: string, name: string}[]} refs 附件引用 @returns {void} */
	function requireImageSupport(refs) {
		if (
			!model.input.includes("image") &&
			refs.some((r) => r.id.startsWith("clip:") || /\.(png|jpe?g|jpe|jfif|webp)$/i.test(r.name))
		)
			throw new Error("当前模型只支持文本，请移除图片或切换到视觉模型。");
	}

	/**
	 * 读取当前会话中可重试的请求。只允许未完成且未进入模型上下文的请求。
	 * @param {string} id 会话 ID
	 * @param {string} requestId 请求 ID
	 * @returns {Promise<{runtime: object, record: object, refs: object[]}>} 运行时、历史行与原附件
	 */
	async function retryableRequest(id, requestId) {
		if (typeof requestId !== "string" || !uid.test(requestId)) throw new Error("无效请求标识");
		requireWritableWorkbench();
		if (workbench.selected !== id) throw new Error("会话已切换，请在当前会话操作。");
		findSession(id);
		const runtime = await getSessionRuntime(id);
		const record = (await runtime.call("history", { session: id })).find((entry) => entry.requestId === requestId);
		if (!record || !["failed", "cancelled", "interrupted", "denied"].includes(record.status) || !record.input)
			throw new Error("只能重试或编辑未完成的请求。");
		// 早期记录只有单个工作区文件字段，按同样的引用格式恢复。
		const refs = record.attachments?.length ? record.attachments : record.file ? [fileReference(record.file)] : [];
		return { runtime, record, refs };
	}

	handle("submit", (id, text) =>
		serializeTaskChange(async () => {
			if (typeof text !== "string" || !text.trim() || text.length > 16000) {
				throw new Error("请输入有效任务说明，最多 16000 字符");
			}
			if (!model) throw new Error("请先配置模型。");
			const runtime = await getSessionRuntime(id);
			const owner = draftOwner(id);
			const refs = draftAttachments(owner);
			if (!refs.length) return runtime.call("submit", { session: id, input: text });
			requireImageSupport(refs);
			await writeDraft(owner, []);
			try {
				const result = await runtime.call("submit", { session: id, input: text, attachments: refs });
				return result;
			} catch (error) {
				await writeDraft(owner, refs);
				throw error;
			}
		}),
	);
	handle("retry-request", (id, requestId) =>
		serializeTaskChange(async () => {
			const { runtime, record, refs } = await retryableRequest(id, requestId);
			if (!model) throw new Error("请先配置模型。");
			requireImageSupport(refs);
			// 以原输入和原附件新建一轮，原记录保留在历史中，当前草稿不受影响。
			return runtime.call("submit", { session: id, input: record.input, ...(refs.length && { attachments: refs }) });
		}),
	);
	handle("restore-request-draft", (id, requestId) =>
		serializeTaskChange(async () => {
			const { record, refs } = await retryableRequest(id, requestId);
			await writeDraft(draftOwner(id), refs);
			return { input: record.input };
		}),
	);
	handle("copy-text", (text) => {
		if (typeof text !== "string" || !text || text.length > 200_000) throw new Error("无法复制这段内容。");
		clipboard.writeText(text);
	});
	handle("cancel", async (id, requestId, runId) => {
		if (
			typeof requestId !== "string" ||
			!uid.test(requestId) ||
			(runId !== undefined && (typeof runId !== "string" || !uid.test(runId)))
		) {
			throw new Error("无效请求标识");
		}
		findSession(id);
		if (!host) throw new Error("工作进程已关闭");
		if (runId) return cancelRun(id, requestId, runId);
		const record = await host.call("cancel-queued", { session: id, requestId });
		return record.status === "running" && record.runId ? cancelRun(id, requestId, record.runId) : record;
	});
	handle("open-artifact", async (id, requestId, path) => {
		const runtime = await getSessionRuntime(id);
		const history = await runtime.call("history", { session: id });
		if (!history.find((entry) => entry.requestId === requestId)?.artifacts.includes(path))
			throw new Error("产物不属于当前会话");
		const file = await resolveArtifact(findSession(id).workspace, path);
		const error = await shell.openPath(file);
		if (error) throw new Error(`Windows 无法打开 ${basename(file)}`);
	});

	app.commandLine.appendSwitch("disable-background-networking");
	app.once("ready", () => {
		Menu.setApplicationMenu(null);
		const palette = titlebarPalettes[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
		const savedWindow = readWindowState(windowStatePath);
		const restored = restorableBounds(
			savedWindow,
			screen.getAllDisplays().map(({ workArea }) => workArea),
		);
		window = new BrowserWindow({
			title: "Flower Desktop",
			icon: fileURLToPath(new URL("./ui/flower-icon.png", import.meta.url)),
			// 保存的是外框；首次启动沿用按内容区计算的默认尺寸。
			...(restored ? { ...restored, useContentSize: false } : { width: 1282, height: 801, useContentSize: true }),
			minWidth: 640,
			minHeight: 560,
			backgroundColor: palette.backgroundColor,
			...(process.platform === "win32" && {
				titleBarStyle: "hidden",
				titleBarOverlay: titlebarOverlay(palette),
			}),
			webPreferences: {
				preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				spellcheck: false,
			},
		});
		window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		window.webContents.on("render-process-gone", () => dismissApprovals());
		window.on("closed", () => dismissApprovals());
		window.on("focus", () => {
			window.flashFrame(false);
			if (attention.clear(workbench.selected)) announce();
		});
		window.on("close", (event) => {
			// 运行、排队和待批准的任务都在 activeRequests 中，关闭会中断它们，先请用户确认。
			const pending = activeRequests.size;
			if (closeConfirmed || !pending) {
				saveWindowState();
				return;
			}
			event.preventDefault();
			void dialog
				.showMessageBox(window, {
					type: "warning",
					buttons: ["仍然关闭", "取消"],
					defaultId: 1,
					cancelId: 1,
					noLink: true,
					message: `还有 ${pending} 个任务未完成`,
					detail: "关闭后这些任务会被中断，下次打开时显示为已中断。",
				})
				.then(({ response }) => {
					if (response !== 0 || !window || window.isDestroyed()) return;
					closeConfirmed = true;
					window.close();
				});
		});
		if (restored && savedWindow.maximized === true) window.maximize();
		for (const type of ["resize", "move", "maximize", "unmaximize"]) window.on(type, scheduleWindowSave);
		window.on("unmaximize", restorePendingPanel);
		window.on("leave-full-screen", restorePendingPanel);
		window.webContents.on("will-navigate", (event) => event.preventDefault());
		window.webContents.on("context-menu", (_event, params) => {
			const items = contextMenuItems(params, window.webContents);
			if (items.length) Menu.buildFromTemplate(items).popup({ window });
		});
		window.webContents.on("dom-ready", () => {
			if (window.webContents.mainFrame?.url !== page.href) return;
			// 重新加载的页面从收起状态开始，先撤销上一页留下的侧栏扩展。
			if (panelExpansion) {
				panelExpansion.open = false;
				restorePendingPanel();
			}
			// 本机资料加载只依赖可信主文档，隐藏窗口也能完成初始化。
			initialization ??= loadLocal();
			announce();
		});
		window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		void window.loadFile(fileURLToPath(page));
	});
	app.on("second-instance", () => {
		if (window?.isMinimized()) window.restore();
		window?.focus();
	});
	app.on("window-all-closed", () => app.quit());
	app.on("before-quit", () => {
		host?.close();
	});
}
