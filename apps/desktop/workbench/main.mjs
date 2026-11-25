import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	app,
	BrowserWindow,
	ClipboardItem,
	clipboard,
	dialog,
	ipcMain,
	Menu,
	Notification,
	nativeImage,
	nativeTheme,
	safeStorage,
	screen,
	shell,
	Tray,
	utilityProcess,
} from "electron";
import { createQuestionBroker } from "./ask-user.mjs";
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
import { createAutomation } from "./automation.mjs";
import { mergeBackground, recentBackground, summarizeBackground } from "./background-tasks.mjs";
import { contextMenuItems, replyMenuItems, revealLabel } from "./context-menu.mjs";
import { conversationHtml, conversationMarkdown, exportSelectedSegments, exportTurns } from "./conversation-export.mjs";
import { bundledUpdateChannel, createDesktopUpdater, electronReleaseFetch } from "./desktop-update.mjs";
import { bundledMacUpdateChannel, createMacDesktopUpdater } from "./desktop-update-macos.mjs";
import { acceptedFirst, finishFirstIntent, recoverFirstSessions, saveFirstIntent } from "./first-session.mjs";
import { listAvailableModels, openModelStream } from "./gateway.mjs";
import { createLocalExtensions, readLocalExtensionPackage } from "./local-extensions.mjs";
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
import { createNativePanelHost } from "./native-panels.mjs";
import { findPortableInstallation } from "./portable-update-install.mjs";
import { createRuntimeHost } from "./runtime-host.mjs";
import { createSessionQueue, storedQueue } from "./session-queue.mjs";
import { copySessionPrefix, planSessionRevision, revisionPaths } from "./session-revision.mjs";
import { interruptedTurns, searchableTurns, searchSnippets } from "./session-search.mjs";
import { conversationContext, firstMessageContext, generateTitle, placeholderTitle } from "./session-title.mjs";
import { readJson, writeJson } from "./storage.mjs";
import { listTurnChanges, turnArtifacts, undoTurnChanges } from "./turn-changes.mjs";
import { containsBounds, expandedBounds, restoredBounds, roundingCorrection } from "./window-fit.mjs";
import { readWindowState, restorableBounds, savedBounds, writeWindowState } from "./window-state.mjs";
import {
	analysisFiles,
	approveFile,
	approveWorkspace,
	artifactSummary,
	canAttachWorkspaceFile,
	checkRoot,
	isWorkspacePath,
	listWorkspaceEntries,
	previewWorkspaceFile,
	rankWorkspaceFiles,
	reportFiles,
	resolveArtifact,
	resolveMentionedPaths,
	workspaceEntryPath,
	workspaceFiles,
} from "./workspace.mjs";
import {
	commitGitChanges,
	gitChanges,
	gitCommitPreview,
	gitDifference,
	trackedFiles,
	updateGitStage,
} from "./workspace-git.mjs";

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
const immediateHandlers = new Set(["state", "titlebar-theme", "panel-expansion", "desktop-update-state"]);

/** 启动使用独立本机资料目录的桌面工作台。
 * @returns 无返回值
 */
export function launchWorkbench() {
	const macOS = process.platform === "darwin";
	const packagedWindows = process.platform === "win32" && app.isPackaged;
	const windowsAppId = "Flower.Desktop.Open";
	const updateChannel = macOS ? bundledMacUpdateChannel(process.arch) : bundledUpdateChannel();
	if (!app.commandLine.hasSwitch("user-data-dir")) {
		const profile = join(
			app.getPath("appData"),
			updateChannel?.id === "qa" ? "Flower Desktop Update QA" : "Flower Desktop Open",
		);
		mkdirSync(profile, { recursive: true });
		app.setPath("userData", profile);
	}
	// Windows 通知按应用标识归属，标识不得含空格。
	if (process.platform === "win32") app.setAppUserModelId(windowsAppId);
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
	let desktopUpdater;
	let startupUpdate;
	let periodicUpdate;
	let updateRestarting = false;
	let handingOffUpdate = false;
	let macRestartHandoff = false;
	let window;
	let host;
	let ready;
	let workbench = {
		workspaces: [],
		deletions: [],
		sessions: [],
		sideChats: [],
		selected: "",
		draftWriteMode: "auto",
		instructions: "",
	};
	let persistedSelection = "";
	const drafts = new Map();
	const draftAssetIntents = new Set();
	const firstSends = new Map();
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
	let automationTimer;
	let exiting = false;
	const automation = createAutomation({
		path: join(directory, "automation.json"),
		workspace: automationWorkspace,
		available: () => initialized && Boolean(model) && !exiting && !updateRestarting,
		launch: launchAutomation,
		abort: abortAutomation,
		recover: recoverAutomation,
		changed: () => send({ kind: "automation-changed" }),
	});
	const extensions = createLocalExtensions(directory);
	const nativePanels = createNativePanelHost({
		window: () => window,
		current: (session) => session === workbench.selected,
		associate: (session) => readSelectedWorkspace(session, (workspace) => workspace),
		send,
	});
	// 正在手动压缩的会话：视为忙碌，新消息排队，结束后派发。
	const compacting = new Set();
	const attention = createAttention();
	// 系统通知在被点击前需要保持引用，否则可能被回收而丢失点击回调。
	const notices = new Set();
	let tray;
	let quitRequested = false;
	let closeConfirmed = false;
	let askingToClose = false;
	const sessionsDirectory = join(directory, "sessions");
	let lastAttachmentDirectory;
	// 侧栏扩展前后的窗口外框。open 为 false 表示最大化期间已收起，退出最大化后再还原。
	let panelExpansion;
	const approvals = new Map();
	const questions = createQuestionBroker({
		selected: () => workbench.selected,
		isCurrent: isCurrentRun,
		changed: announce,
		notify: (session) => remind(session, "有问题待回答"),
	});
	// 已关闭但仍有运行收尾的侧边追问，终态写盘后再清理一次记录文件。
	const retiredSideChats = new Set();
	// 正文索引：会话 ID → 记录文件的修改时间、大小与可搜索轮次。搜索与启动时的中断识别共用，文件未变时复用。
	const bodyIndex = new Map();
	// 启动时识别出的上次被中断的会话；用户继续、重新发送或选择忽略后移除。
	const interrupted = new Set();
	let interruptedDismissed = false;
	const modelCatalogs = new Map();
	const modelDiscovery = new WeakMap();
	const queue = createSessionQueue({
		find: (id) => workbench.sessions.find((entry) => entry.id === id),
		list: () => workbench.sessions,
		persist: record,
		submit: submitRequest,
		steer: (id, runId, item) => {
			if (!host) throw new Error("工作进程已关闭");
			return host.call("steer", {
				session: id,
				runId,
				steerId: item.id,
				input: item.input,
				...(item.attachments?.length && { attachments: item.attachments }),
			});
		},
		running: (id) => [...activeRequests.values()].find((entry) => entry.session === id && entry.running && entry.runId),
		busy: sessionBusy,
		notify: (id, text) => send({ kind: "notice", session: id, tone: "error", text }),
		serialize: serializeTaskChange,
	});

	function catalogFor(service) {
		const saved = modelCatalogs.get(service?.id);
		if (saved?.baseUrl === service?.baseUrl && saved?.encryptedKey === service?.encryptedKey) return saved?.levels;
	}

	function send(message) {
		if (window && !window.isDestroyed()) window.webContents.send("flower:update", message);
	}
	function updateState() {
		const state = desktopUpdater?.state() ?? {
			phase: "unavailable",
			currentVersion: app.getVersion(),
			channel: updateChannel?.id ?? "stable",
			...(macOS && { installPolicy: "on-exit" }),
			scheduled: false,
			canRestart: false,
		};
		return tray ? { ...state, trayAvailable: true } : state;
	}
	function updateBusy() {
		return !initialized || pendingWork() > 0;
	}
	function pendingWork() {
		return (
			activeRequests.size +
			compacting.size +
			firstSends.size +
			workbench.sessions.reduce((count, session) => count + (session.queuePaused ? 0 : storedQueue(session).length), 0)
		);
	}
	function sessionView(owner) {
		return {
			id: owner.id,
			title: owner.title,
			workspaceId: owner.workspace.id,
			workspace:
				workbench.workspaces.find((item) => item.workspace.id === owner.workspace.id)?.title ?? owner.workspace.name,
			path: owner.workspace.root,
			attachments: draftAttachments(owner),
		};
	}

	function state() {
		const waiting = [...approvals.values()].map(({ prompt }) => prompt);
		const waitingSessions = new Set(waiting.map(({ session }) => session));
		const questionSessions = questions.sessions();
		const draft = drafts.get(workbench.selected);
		return {
			ready: initialized,
			version: app.getVersion(),
			desktopUpdate: updateState(),
			model: model?.id ?? "",
			modelRevision,
			runtimeRevision,
			modelBusy: activeRequests.size > 0,
			writeMode: selectedWriteMode(),
			writeModeBusy: sessionBusy(workbench.selected),
			writeApproval: waiting.find(({ session }) => session === workbench.selected),
			question: questions.current(),
			modelSettings: publicService(settings, catalogFor(settings)),
			modelServices: library.services.map((service) => publicService(service, catalogFor(service))),
			queue: workbench.selected && !draft ? queue.view(workbench.selected) : undefined,
			compacting: compacting.has(workbench.selected),
			instructions: workbench.instructions ?? "",
			interrupted: interruptedDismissed
				? []
				: workbench.sessions
						.filter(({ id }) => interrupted.has(id) && !sessionBusy(id))
						.map(({ id, title }) => ({ id, title })),
			sideChats: workbench.sideChats.map(({ id, parent, turns }) => ({ id, parent, turns, busy: sessionBusy(id) })),
			gatewayError: workbenchError || gatewayError,
			workspaces: workbench.workspaces.map(({ workspace, title, pinned }) => ({
				workspaceId: workspace.id,
				workspace: title,
				path: workspace.root,
				pinned,
			})),
			sessions: workbench.sessions.map((owner) => ({
				...sessionView(owner),
				pinned: owner.pinned === true,
				awaitingWrite: waitingSessions.has(owner.id),
				awaitingAnswer: questionSessions.has(owner.id),
				busy: sessionBusy(owner.id),
				indicator: attention.indicator(owner.id, waitingSessions.has(owner.id), sessionBusy(owner.id)),
			})),
			selected: workbench.selected,
			draft: draft && sessionView(draft),
			draftIds: [...drafts.keys()],
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
			// 每个主会话最多一个侧边追问；主会话已不存在的侧边追问记录一并清理。
			const sideChats = [];
			const orphans = [];
			for (const side of stored?.sideChats ?? []) {
				if (!uid.test(side?.id) || typeof side.workspace?.id !== "string" || typeof side.workspace.root !== "string")
					continue;
				const parent = sessions.find((entry) => entry.id === side.parent);
				if (parent?.workspace.id === side.workspace.id && !sideChats.some((entry) => entry.parent === side.parent))
					sideChats.push({ id: side.id, parent: side.parent, workspace: side.workspace, turns: Number(side.turns) || 0 });
				else orphans.push(side.id);
			}
			workbench = {
				workspaces: [...spaces.values()],
				sideChats,
				deletions: [
					...(stored?.deletions ?? []).filter((id) => uid.test(id) && !sessions.some((entry) => entry.id === id)),
					...orphans,
				],
				// 上次运行已结束，留下的排队消息等用户确认后再发送。
				sessions: sessions.map((entry) => {
					const items = storedQueue(entry);
					return {
						...entry,
						writeMode: storedWriteMode(entry.writeMode),
						queue: items.length ? items : undefined,
						queuePaused: items.length ? true : undefined,
					};
				}),
				selected: sessions.some(({ id }) => id === stored?.selected) ? stored.selected : "",
				draftWriteMode: storedWriteMode(stored?.draftWriteMode),
				instructions: typeof stored?.instructions === "string" ? stored.instructions.slice(0, 4000) : "",
			};
			persistedSelection = workbench.selected;
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
		if (!workbenchError) {
			const known = new Set([
				...workbench.sessions.map(({ id }) => id),
				...workbench.sideChats.map(({ id }) => id),
				...workbench.deletions,
			]);
			const recovered = await recoverFirstSessions(sessionsDirectory, known).catch(() => []);
			if (recovered.length) {
				for (const owner of recovered) addAcceptedSession(owner);
				if (!workbench.selected) workbench.selected = recovered[0].id;
				await record().then(
					() => Promise.all(recovered.map(({ id }) => finishFirstIntent(sessionsDirectory, id).catch(() => {}))),
					() => {},
				);
			}
		}
		initialized = true;
		void automation.load().catch(() => {});
		automationTimer = setInterval(() => void automation.tick().catch(() => {}), 10_000).unref();
		announce();
		// 工作台就绪后在后台扫描记录文件；处理器等待的初始化不包含这一步，不拖慢首次交互。
		void (async () => {
			for (const { id } of [...workbench.sessions]) if (interruptedTurns(await indexedTurns(id))) interrupted.add(id);
			if (interrupted.size) announce();
		})().catch(() => {});
	}

	/**
	 * 读取会话的可搜索轮次；记录文件的修改时间与大小未变时复用索引。
	 * @param {string} id 会话 ID
	 * @returns {Promise<ReturnType<typeof searchableTurns>>} 轮次，文件不存在或无法读取时为空
	 */
	async function indexedSession(id) {
		const file = join(sessionsDirectory, `${id}.json`);
		const info = await stat(file).catch(() => undefined);
		if (!info) {
			bodyIndex.delete(id);
			return { turns: [], tasks: [] };
		}
		const cached = bodyIndex.get(id);
		if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
		const snapshot = await readJson(file).catch(() => undefined);
		const entry = {
			mtimeMs: info.mtimeMs,
			size: info.size,
			turns: searchableTurns(snapshot),
			tasks: summarizeBackground(snapshot),
		};
		bodyIndex.set(id, entry);
		return entry;
	}

	async function indexedTurns(id) {
		return (await indexedSession(id)).turns;
	}

	async function backgroundRows() {
		const activeSessions = new Set([...activeRequests.values()].map(({ session }) => session));
		const owners = workbench.sessions.filter(
			(owner, index) => index < 60 || activeSessions.has(owner.id) || storedQueue(owner).length,
		);
		const awaiting = new Set([...approvals.values()].map(({ prompt }) => prompt.requestId));
		const questionSessions = questions.sessions();
		const rows = [];
		for (let offset = 0; offset < owners.length; offset += 8) {
			// 批量限制读盘并发，同时保留最近会话之外正在执行的请求。
			const batch = await Promise.all(
				owners.slice(offset, offset + 8).map(async (owner) => ({
					id: owner.id,
					tasks: (await indexedSession(owner.id)).tasks,
				})),
			);
			for (const { id, tasks } of batch) {
				const owner = workbench.sessions.find((entry) => entry.id === id);
				if (!owner) continue;
				const { workspace } = owner;
				const display = sessionView(owner);
				const active = new Set(
					[...activeRequests].filter(([, request]) => request.session === id).map(([request]) => request),
				);
				const merged = mergeBackground(tasks, storedQueue(owner), {
					workspaceId: workspace.id,
					active,
					approvals: awaiting,
					questions: questionSessions.has(id),
					paused: owner.queuePaused,
				});
				for (const task of merged)
					rows.push({
						...task,
						session: id,
						title: display.title,
						workspace: display.workspace,
						path: display.path,
						cancellable: active.has(task.id),
					});
			}
		}
		const saved = await automation.view().catch(() => ({ runs: [] }));
		const automatic = new Map(saved.runs.map((run) => [run.id, run]));
		const manual = rows.filter((row) => !automatic.has(row.session));
		for (const run of automatic.values()) {
			const owner = workbench.sessions.find(({ id }) => id === run.id);
			const space = workbench.workspaces.find(({ workspace }) => workspace.id === run.workspaceId);
			const result = rows.find((row) => row.session === run.id && (!run.request || row.id === run.request));
			manual.push({
				id: run.id,
				session: owner?.id,
				title: run.title,
				workspace: space?.title ?? "工作区已移除",
				path: space?.workspace.root,
				input: run.prompt.slice(0, 240),
				result: run.result || result?.result || "",
				progress: result?.progress,
				status:
					["running", "starting"].includes(run.status) && result
						? result.status
						: run.status === "queued" && !model
							? "waiting-model"
							: run.status,
				at: run.at,
				automation: true,
				cancellable: ["running", "starting", "queued"].includes(run.status),
			});
		}
		return recentBackground(manual);
	}

	async function record() {
		const snapshot = structuredClone(workbench);
		const temporary = drafts.has(snapshot.selected);
		const write = writes.then(async () => {
			if (temporary) {
				snapshot.selected = snapshot.sessions.some(({ id }) => id === persistedSelection) ? persistedSelection : "";
			}
			await writeJson(workbenchPath, snapshot);
			persistedSelection = snapshot.selected;
		});
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

	function automationWorkspace(workspaceId) {
		const found = workbench.workspaces.find(({ workspace }) => workspace.id === workspaceId);
		if (!found) throw new Error("这项自动化的工作区已移除，请重新选择。");
		return found;
	}

	function launchAutomation(run, signal) {
		return serializeTaskChange(async () => {
			requireWritableWorkbench();
			signal.throwIfAborted();
			const { workspace } = automationWorkspace(run.workspaceId);
			const verified = await approveWorkspace(workspace.root);
			signal.throwIfAborted();
			if (verified.id !== workspace.id) throw new Error("工作区位置已变化，请重新选择目录。");
			const previous = structuredClone(workbench);
			addAcceptedSession({ id: run.id, title: run.title, workspace, writeMode: run.writeMode, automation: true });
			await persistChange(previous);
			signal.throwIfAborted();
			const accepted = await submitRequest(run.id, { input: run.prompt, skill: run.skill });
			if (signal.aborted) await abortAutomation({ id: run.id, request: accepted.requestId });
			return accepted;
		});
	}

	async function abortAutomation(run) {
		const request = run.request ?? [...activeRequests].find(([, value]) => value.session === run.id)?.[0];
		const active = activeRequests.get(request);
		if (!host || !active || active.session !== run.id) return false;
		if (active.runId) return cancelRun(run.id, request, active.runId);
		return host.call("cancel-queued", { session: run.id, requestId: request });
	}

	async function recoverAutomation(run) {
		const owner = workbench.sessions.find(({ id }) => id === run.id);
		if (!owner || owner.workspace.id !== run.workspaceId) return undefined;
		const { tasks } = await indexedSession(run.id);
		const record = tasks.find(
			(task) => task.workspaceId === run.workspaceId && (!run.request || task.id === run.request),
		);
		return record && { status: record.status, result: record.result, request: record.id };
	}

	function selectWorkspaceSession(id) {
		if (workbench.selected === id) return;
		// 行内编辑只发生在当前会话，切走后不再暂缓其队列。
		if (workbench.selected) queue.release(workbench.selected);
		nativePanels.close();
		workspaceSelection.abort(new Error("会话已切换，请重新读取工作区。"));
		workspaceSelection = new AbortController();
		workbench.selected = id;
	}

	async function readSelectedWorkspace(id, read) {
		if (id !== workbench.selected) throw new Error("只能读取当前会话的工作区。");
		const { workspace } = drafts.get(id) ?? findSession(id);
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
		if (updateRestarting) throw new Error("应用正在为更新重启。");
	}

	function serializeTaskChange(action) {
		// 提交与模型、权限变更同序，队列中的请求保留原有权限。
		const next = taskChanges.then(action);
		taskChanges = next.catch(() => {});
		return next;
	}

	function selectedWriteMode() {
		return (
			drafts.get(workbench.selected)?.writeMode ??
			workbench.sessions.find(({ id }) => id === workbench.selected)?.writeMode ??
			workbench.draftWriteMode
		);
	}

	function sessionBusy(id) {
		return compacting.has(id) || [...activeRequests.values()].some(({ session }) => session === id);
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
		const matches = (prompt) => prompt.session === session && prompt.runId === runId;
		dismissApprovals(matches);
		questions.dismiss(matches);
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

	/** 从托盘、通知或重复启动回到同一个工作台窗口。 */
	function showWorkbench() {
		if (!window || window.isDestroyed()) return;
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
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
			showWorkbench();
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
			instructions: workbench.instructions,
			onEvent(event) {
				if (host !== instance) return;
				const { type, sessionId: session, requestId, runId } = event;
				if (type === "queued" && drafts.has(session)) {
					const first = firstSends.get(session);
					if (first) promoteDraft(first.owner, first.input);
				}
				const added = type === "queued" && !activeRequests.has(requestId);
				if (added || type === "started") activeRequests.set(requestId, { session, runId, running: type === "started" });
				if (type === "cancelling") {
					const active = activeRequests.get(requestId);
					if (active) active.running = false;
				}
				if (type === "terminal") activeRequests.delete(requestId);
				if (type === "terminal" && retiredSideChats.delete(session)) {
					workbench.deletions.push(session);
					void cleanDeleted().catch(() => {});
				}
				if (type === "terminal" || type === "cancelling") {
					const matches = (prompt) => prompt.requestId === requestId;
					dismissApprovals(matches);
					questions.dismiss(matches);
				}
				// 插话送达时附上原文，界面无须等待历史重读即可显示；终态后派发下一条排队消息。
				const steered = queue.receive(event);
				const visible = event.type === "tool_result" ? { ...event, text: [] } : steered ? { ...event, ...steered } : event;
				send({ kind: "event", event: visible });
				// 侧边追问在右栏中进行，不单独提醒。
				if (type === "terminal" && workbench.sessions.some(({ id }) => id === session)) noticeTerminal(session, event);
				if (type === "terminal" && workbench.sessions.some(({ id, automation }) => id === session && automation)) {
					bodyIndex.delete(session);
					void indexedSession(session)
						.then(({ tasks }) =>
							automation.finish(
								session,
								event.status,
								tasks.find(({ id }) => id === requestId)?.result || event.failure?.message,
								requestId,
							),
						)
						.catch(() => {});
				}
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
				for (const { session } of activeRequests.values())
					void automation.finish(session, "interrupted", "工作进程已关闭。").catch(() => {});
				activeRequests.clear();
				questions.dismiss();
				queue.pauseAll();
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
			requestQuestion: (frame, signal) => (window && !window.isDestroyed() ? questions.request(frame, signal) : undefined),
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
		if (activeRequests.size || compacting.size) throw new Error("请等待运行和排队任务结束后再更改模型设置。");
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
	handle("save-instructions", (text) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			if (typeof text !== "string" || text.length > 4000) throw new Error("全局指令最多 4000 字。");
			const previous = structuredClone(workbench);
			workbench.instructions = text.trim();
			await persistChange(previous);
			// 工作进程尚未启动时，初始化帧会带上新的指令。
			const runtime = await ready?.catch(() => undefined);
			if (runtime) await runtime.call("instructions", { text: workbench.instructions });
		}),
	);
	handle("set-write-mode", (session, mode) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			if (session !== workbench.selected || !writeModes.has(mode)) throw new Error("无效的会话权限选择。");
			if (sessionBusy(session)) throw new Error("等待本会话的运行和排队任务结束后可更改权限。");
			const draft = drafts.get(session);
			if (draft) {
				draft.writeMode = mode;
				announce();
				return;
			}
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
	handle("answer-question", (id, selection) => questions.answer(id, selection));
	handle("choose-workspace", async () => {
		requireWritableWorkbench();
		const { signal } = workspaceSelection;
		const draft = drafts.get(workbench.selected);
		const current = draft ?? workbench.sessions.find(({ id }) => id === workbench.selected) ?? workbench.sessions[0];
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
		return serializeTaskChange(() => {
			signal.throwIfAborted();
			if (drafts.get(workbench.selected)?.workspace.id === workspace.id) return workbench.selected;
			return enterDraft(workspace, selectedWriteMode());
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

	function enterDraft(workspace, writeMode) {
		const id = randomUUID();
		drafts.set(id, { id, title: "新会话", workspace, writeMode });
		selectWorkspaceSession(id);
		announce();
		return id;
	}

	function addAcceptedSession(owner) {
		if (!workbench.workspaces.some((item) => item.workspace.id === owner.workspace.id)) {
			const { workspace } = owner;
			workbench.workspaces.unshift({ workspace, title: workspace.name });
		}
		workbench.sessions.unshift(owner);
	}

	function promoteDraft(owner, input) {
		if (!drafts.delete(owner.id)) return;
		draftAssetIntents.delete(owner.id);
		owner.title = placeholderTitle(input) || owner.title;
		delete owner.attachments;
		addAcceptedSession(owner);
	}

	handle("new-session", (current) =>
		serializeTaskChange(() => {
			requireWritableWorkbench();
			if (current !== workbench.selected) throw new Error("会话已切换，请重新新建。");
			if (!current) return;
			const previous = drafts.get(current) ?? findSession(current);
			return enterDraft(previous.workspace, previous.writeMode);
		}),
	);
	handle("select-session", (id) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			if (drafts.has(id)) {
				selectWorkspaceSession(id);
				announce();
				return;
			}
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
		const changes = join(sessionsDirectory, "turn-changes");
		const ledger = await lstat(changes).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (ledger && (!ledger.isDirectory() || ledger.isSymbolicLink())) throw new Error("本机文件变更目录位置已变化。");
		for (const id of workbench.deletions) {
			await rm(join(sessionsDirectory, `${id}.json`), { force: true });
			if (info) await rm(join(assets, id), { recursive: true, force: true, maxRetries: 2 });
			if (ledger) await rm(join(changes, id), { recursive: true, force: true, maxRetries: 2 });
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
			if (operation === "create" && space) {
				return enterDraft(item.workspace, members[0]?.writeMode ?? workbench.draftWriteMode);
			}
			const previous = structuredClone(workbench);
			const removedDrafts = [];
			if (operation === "pin" && typeof value === "boolean") item.pinned = value;
			else if (operation === "rename" && typeof value === "string" && value.trim() && value.trim().length <= 120) {
				item.title = value.trim();
				// 手动起的名不再被首条消息的自动命名覆盖。
				delete item.titlePending;
			} else if (operation === "delete") {
				if (space && value !== members.length) throw new Error("工作区的会话数已变化，请重新确认。");
				if (members.some((entry) => sessionBusy(entry.id))) throw new Error("请先结束此处正在运行或排队的任务。");
				const deleted = new Set(members.map((entry) => entry.id));
				workbench.sessions = workbench.sessions.filter((entry) => !deleted.has(entry.id));
				for (const side of workbench.sideChats.filter((entry) => deleted.has(entry.parent))) dropSideChat(side);
				for (const key of deleted) {
					bodyIndex.delete(key);
					interrupted.delete(key);
				}
				if (space) {
					workbench.workspaces = workbench.workspaces.filter((entry) => entry !== item);
					for (const draft of drafts.values()) if (draft.workspace.id === id) removedDrafts.push(draft.id);
				}
				if (deleted.has(workbench.selected) || removedDrafts.includes(workbench.selected))
					selectWorkspaceSession(
						workbench.sessions.find((entry) => entry.workspace.id === item.workspace.id)?.id ??
							workbench.sessions[0]?.id ??
							"",
					);
				workbench.deletions.push(...deleted);
			} else throw new Error("无效的侧栏操作或名称。");
			await persistChange(previous);
			if (removedDrafts.length) {
				for (const key of removedDrafts) {
					drafts.delete(key);
					draftAssetIntents.delete(key);
					await finishFirstIntent(sessionsDirectory, key, true).catch(() => {});
				}
				announce();
			}
			if (operation === "delete" && workbench.deletions.length)
				await cleanDeleted().catch(() => {
					throw new Error("已从侧栏移除。部分本机记录将在下次启动时清理。");
				});
		}),
	);
	/** 当前主会话的侧边追问。@param {string} parent 主会话 ID @returns {object} 侧边追问记录 */
	function sideChatOf(parent) {
		findSession(parent);
		if (parent !== workbench.selected) throw new Error("会话已切换，请在当前会话操作。");
		const side = workbench.sideChats.find((entry) => entry.parent === parent);
		if (!side) throw new Error("侧边追问已关闭。");
		return side;
	}
	/** 侧边追问以只读权限登记到运行时。@param {object} side 侧边追问记录 @returns {Promise<object>} 运行时 */
	async function getSideRuntime(side) {
		const runtime = await prepare();
		await runtime.call("register", { session: side.id, workspace: side.workspace, readOnly: true });
		return runtime;
	}
	/**
	 * 从列表移除侧边追问并登记删除；仍在运行时先停止，终态写盘后再清理一次。
	 * @param {object} side 侧边追问记录
	 * @returns {void}
	 */
	function dropSideChat(side) {
		workbench.sideChats = workbench.sideChats.filter((entry) => entry !== side);
		workbench.deletions.push(side.id);
		for (const [requestId, active] of activeRequests) {
			if (active.session !== side.id) continue;
			retiredSideChats.add(side.id);
			if (active.runId) void cancelRun(side.id, requestId, active.runId).catch(() => {});
			else void host?.call("cancel-queued", { session: side.id, requestId }).catch(() => {});
		}
	}
	handle("open-side-chat", (parent) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			const owner = findSession(parent);
			if (parent !== workbench.selected) throw new Error("会话已切换，请在当前会话操作。");
			// 主会话的消息只在请求成功时整体替换，记录文件中就是已完成的上下文，运行中的一轮不会带入。
			const snapshot = await readJson(join(sessionsDirectory, `${parent}.json`));
			const turns = snapshot?.requests.filter(({ status }) => status === "succeeded").length ?? 0;
			if (!turns) throw new Error("请先等待主会话完成一次回答。");
			const previous = structuredClone(workbench);
			const old = workbench.sideChats.find((entry) => entry.parent === parent);
			if (old) dropSideChat(old);
			const side = { id: randomUUID(), parent, workspace: owner.workspace, turns };
			await writeJson(join(sessionsDirectory, `${side.id}.json`), {
				version: 1,
				workspaceId: snapshot.workspaceId ?? snapshot.requests[0]?.workspaceId,
				lastSequence: 0,
				requests: [],
				messages: snapshot.messages ?? [],
				...(snapshot.contextCheckpoint && { contextCheckpoint: snapshot.contextCheckpoint }),
				artifacts: [],
				operations: [],
				desktopMessages: {},
			});
			workbench.sideChats.push(side);
			try {
				await persistChange(previous);
			} catch (error) {
				await rm(join(sessionsDirectory, `${side.id}.json`), { force: true }).catch(() => {});
				throw error;
			}
			if (old) await cleanDeleted().catch(() => {});
			return { id: side.id, parent, turns };
		}),
	);
	handle("side-chat-history", (parent) =>
		serializeTaskChange(async () => {
			const side = sideChatOf(parent);
			const runtime = await getSideRuntime(side);
			return runtime.call("history", { session: side.id });
		}),
	);
	/**
	 * 向侧边追问提交一条文字消息；侧边追问不排队，回答期间拒绝新消息。
	 * @param {object} side 侧边追问记录
	 * @param {string} text 消息原文
	 * @returns {Promise<object>} 请求记录
	 */
	async function submitSideChat(side, text, skill) {
		if (typeof text !== "string" || !text.trim() || text.length > 16000)
			throw new Error("请输入有效任务说明，最多 16000 字符");
		if (!model) throw new Error("请先配置模型。");
		if (sessionBusy(side.id)) throw new Error("侧边追问正在回答，请稍候或先停止。");
		const runtime = await getSideRuntime(side);
		return runtime.call("submit", { session: side.id, input: text, ...(skill && { skill }) });
	}
	handle("submit-side-chat", (parent, text) => serializeTaskChange(() => submitSideChat(sideChatOf(parent), text)));
	handle("queue-to-side-chat", (parent, itemId) =>
		serializeTaskChange(async () => {
			const owner = queueOwner(parent, itemId);
			const side = sideChatOf(parent);
			if (sessionBusy(side.id)) throw new Error("侧边追问正在回答，请稍候或先停止。");
			const item = await queue.take(parent, itemId);
			let record;
			try {
				record = await submitSideChat(side, item.input, item.skill);
			} catch (error) {
				await queue.restore(parent, item);
				throw error;
			}
			// 侧边追问只收文字，附件留在主会话的附件目录，不再被引用时回收。
			await discardUnused(owner, item.attachments ?? []);
			return { record, dropped: item.attachments?.length ?? 0 };
		}),
	);
	handle("cancel-side-chat", (parent, requestId, runId) => {
		const side = sideChatOf(parent);
		if (typeof requestId !== "string" || !uid.test(requestId) || (runId !== undefined && !uid.test(String(runId))))
			throw new Error("无效请求标识");
		if (!host) throw new Error("工作进程已关闭");
		if (runId) return cancelRun(side.id, requestId, runId);
		return host.call("cancel-queued", { session: side.id, requestId });
	});
	handle("close-side-chat", (parent) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			const side = sideChatOf(parent);
			const previous = structuredClone(workbench);
			dropSideChat(side);
			await persistChange(previous);
			await cleanDeleted().catch(() => {});
		}),
	);
	handle("git-changes", (id) => readSelectedWorkspace(id, gitChanges));
	handle("git-difference", (id, path, group) =>
		readSelectedWorkspace(id, (workspace, signal) => gitDifference(workspace, path, group, signal)),
	);
	handle("git-stage", (id, path, action) =>
		serializeTaskChange(() => {
			requireWritableWorkbench();
			return readSelectedWorkspace(id, (workspace, signal) => updateGitStage(workspace, path, action, signal));
		}),
	);
	handle("git-commit", async (id, message) => {
		requireWritableWorkbench();
		if (typeof message !== "string" || !message.trim() || message.length > 1000)
			throw new Error("请输入有效的提交说明。");
		const { signal } = workspaceSelection;
		const preview = await readSelectedWorkspace(id, gitCommitPreview);
		const paths = preview.paths.slice(0, 8);
		const { response } = await dialog.showMessageBox(window, {
			type: "question",
			buttons: ["提交", "取消"],
			defaultId: 1,
			cancelId: 1,
			noLink: true,
			message: `将 ${preview.total} 项暂存变更提交到 ${preview.branch}`,
			detail: [
				...paths,
				...(paths.length < preview.total ? [`还有 ${preview.total - paths.length} 项`] : []),
				"",
				message.trim(),
			].join("\n"),
		});
		if (response !== 0) return undefined;
		return serializeTaskChange(() => {
			requireWritableWorkbench();
			signal.throwIfAborted();
			return readSelectedWorkspace(id, (workspace, current) =>
				commitGitChanges(workspace, message.trim(), preview, current),
			);
		});
	});
	for (const [channel, method] of [
		["terminal-open", "terminalOpen"],
		["terminal-input", "terminalInput"],
		["terminal-resize", "terminalResize"],
		["terminal-close", "terminalClose"],
		["browser-navigate", "browserNavigate"],
		["browser-action", "browserAction"],
		["browser-bounds", "browserBounds"],
	])
		handle(channel, (...args) => nativePanels[method](...args));
	handle("background-tasks", backgroundRows);
	handle("cancel-background-task", (session, requestId) => {
		requireWritableWorkbench();
		findSession(session);
		if (typeof requestId !== "string" || !uid.test(requestId)) throw new Error("无效任务。");
		const active = activeRequests.get(requestId);
		if (!host || active?.session !== session) throw new Error("任务已经结束，请刷新。");
		if (active.runId) return cancelRun(session, requestId, active.runId);
		return host.call("cancel-queued", { session, requestId });
	});
	handle("automation-state", () => automation.view());
	handle("automation-skills", async (workspaceId) => {
		const draft = drafts.get(workbench.selected);
		const { workspace } = draft?.workspace.id === workspaceId ? draft : automationWorkspace(workspaceId);
		await checkRoot(workspace);
		return (await extensions.list(workspace.id))
			.filter(({ kind, enabled }) => kind === "skill" && enabled)
			.map(({ id, name }) => ({ id, name }));
	});
	handle("save-automation", (id, input) => {
		requireWritableWorkbench();
		return serializeTaskChange(async () => {
			const draft = drafts.get(workbench.selected);
			if (
				draft?.workspace.id === input?.workspaceId &&
				!workbench.workspaces.some(({ workspace }) => workspace.id === input.workspaceId)
			) {
				const workspace = await approveWorkspace(draft.workspace.root);
				if (workspace.id !== draft.workspace.id) throw new Error("工作区位置已变化，请重新选择目录。");
				const previous = structuredClone(workbench);
				workbench.workspaces.unshift({ workspace, title: workspace.name });
				await persistChange(previous);
			}
			if (input?.skill) await extensions.selectedSkill(automationWorkspace(input.workspaceId).workspace, input.skill);
			return automation.savePlan(id, input);
		});
	});
	handle("enable-automation", (id, enabled) => {
		requireWritableWorkbench();
		return automation.enable(id, enabled);
	});
	handle("remove-automation", (id) => {
		requireWritableWorkbench();
		return automation.remove(id);
	});
	handle("run-automation", (id) => {
		requireWritableWorkbench();
		return automation.runNow(id);
	});
	handle("cancel-automation", (id) => automation.cancel(id));
	handle("list-local-extensions", (id) =>
		readSelectedWorkspace(id, async (workspace) => {
			await checkRoot(workspace);
			return extensions.list(workspace.id);
		}),
	);
	handle("install-local-extension", (id, kind) =>
		readSelectedWorkspace(id, async (workspace, signal) => {
			requireWritableWorkbench();
			if (kind !== undefined && kind !== "skill" && kind !== "extension") throw new Error("未知的本地包类型。");
			const fileType =
				kind === "skill"
					? { name: "Markdown 技能", extensions: ["md"] }
					: kind === "extension"
						? { name: "JSON 扩展", extensions: ["json"] }
						: { name: "技能和本地扩展包", extensions: ["md", "json"] };
			await checkRoot(workspace);
			const { canceled, filePaths } = await dialog.showOpenDialog(window, {
				title: `选择${fileType.name}`,
				properties: ["openFile"],
				filters: [fileType],
			});
			if (canceled || !filePaths[0]) return undefined;
			signal.throwIfAborted();
			const manifest = await readLocalExtensionPackage(filePaths[0]);
			const actualKind = manifest.kind === "skill" ? "skill" : "extension";
			if (kind && actualKind !== kind) throw new Error(`请选择${fileType.name}文件。`);
			const { response } = await dialog.showMessageBox(window, {
				type: "question",
				buttons: ["安装", "取消"],
				defaultId: 1,
				cancelId: 1,
				noLink: true,
				message: `安装「${manifest.name}」`,
				detail: [
					manifest.description,
					manifest.kind === "skill"
						? `将技能说明供「${workspace.name}」中的模型任务读取。`
						: `在「${workspace.name}」${manifest.action === "count-lines" ? "统计" : "提取"}含「${manifest.contains}」的文本行。`,
				]
					.filter(Boolean)
					.join("\n\n"),
			});
			if (response !== 0) return undefined;
			return serializeTaskChange(async () => {
				requireWritableWorkbench();
				signal.throwIfAborted();
				await checkRoot(workspace);
				return extensions.install(workspace.id, manifest);
			});
		}),
	);
	handle("enable-local-extension", (id, extension, enabled) =>
		readSelectedWorkspace(id, (workspace, signal) =>
			serializeTaskChange(async () => {
				requireWritableWorkbench();
				signal.throwIfAborted();
				await checkRoot(workspace);
				return extensions.setEnabled(workspace.id, extension, enabled);
			}),
		),
	);
	handle("uninstall-local-extension", (id, extension) =>
		readSelectedWorkspace(id, (workspace, signal) =>
			serializeTaskChange(async () => {
				requireWritableWorkbench();
				signal.throwIfAborted();
				await checkRoot(workspace);
				return extensions.uninstall(workspace.id, extension);
			}),
		),
	);
	handle("run-local-extension", (id, extension, path) =>
		readSelectedWorkspace(id, (workspace, signal) => extensions.run(workspace, extension, path, signal)),
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
					{
						label: "复制路径",
						click: async () => {
							try {
								await clipboard.writeText(actual);
							} catch {
								send({ kind: "notice", session: id, tone: "error", text: "无法将路径复制到剪贴板。" });
							}
						},
					},
				];
				Menu.buildFromTemplate(items).popup({ window, callback: () => resolve("") });
			});
		}),
	);
	// 选择经消息交还渲染层，不依赖菜单点击与关闭回调的先后。
	handle("show-reply-menu", () => {
		Menu.buildFromTemplate(replyMenuItems((choice) => send({ kind: "reply-menu", choice }))).popup({ window });
	});
	handle("resolve-reply-paths", (id, paths) =>
		readSelectedWorkspace(id, (workspace, signal) =>
			resolveMentionedPaths(workspace, paths, signal, () => trackedFiles(workspace, signal)),
		),
	);
	// @ 补全逐字查询，同一工作区的文件清单缓存 30 秒，避免每次按键都遍历或调用 Git。
	const fileLists = new Map();
	handle("workspace-files", (id, query) =>
		readSelectedWorkspace(id, async (workspace, signal) => {
			if (typeof query !== "string" || query.length > 200) throw new Error("查询无效");
			let cached = fileLists.get(workspace.id);
			if (!cached || Date.now() - cached.at > 30_000) {
				cached = { at: Date.now(), files: await workspaceFiles(workspace, signal, () => trackedFiles(workspace, signal)) };
				fileLists.set(workspace.id, cached);
			}
			return rankWorkspaceFiles(cached.files, query);
		}),
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
		return drafts.get(id) ?? findSession(id);
	}
	async function writeDraft(owner, refs) {
		const old = owner.attachments;
		const legacy = owner.file;
		owner.attachments = refs;
		delete owner.file;
		if (drafts.has(owner.id)) {
			announce();
			return;
		}
		try {
			await record();
		} catch (error) {
			owner.attachments = old;
			owner.file = legacy;
			throw error;
		}
	}
	async function trackDraftAssets(owner) {
		if (!drafts.has(owner.id) || draftAssetIntents.has(owner.id)) return;
		await saveFirstIntent(sessionsDirectory, owner);
		draftAssetIntents.add(owner.id);
	}
	// 历史请求、插话与排队消息仍然引用的副本要保留，草稿取消和部分导入失败则可以回收。
	async function discardUnused(owner, refs) {
		const kept = new Set(
			[...draftAttachments(owner), ...storedQueue(owner).flatMap((item) => item.attachments ?? [])].map(({ id }) => id),
		);
		const candidates = refs.filter((ref) => ref.id.startsWith("asset:") && !kept.has(ref.id));
		if (!candidates.length) return;
		const snapshot = await readJson(join(sessionsDirectory, `${owner.id}.json`));
		const used = new Set(
			snapshot?.requests.flatMap((request) =>
				[...(request.attachments ?? []), ...(request.steers ?? []).flatMap((steer) => steer.attachments ?? [])].map(
					({ id }) => id,
				),
			),
		);
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
						await trackDraftAssets(owner);
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
			const bytes = await readBytes();
			await trackDraftAssets(owner);
			const ref = await importAttachmentImage(sessionsDirectory, id, bytes, `截图 ${number}.png`);
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
			await trackDraftAssets(owner);
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
		addImage(id, async () => {
			// 只在用户选择粘贴后读取系统图片，页面通过会话附件接口获取预览。
			const items = await clipboard.read();
			const png = items.find(({ types }) => types.includes("image/png"));
			const jpeg = !png && items.find(({ types }) => types.includes("image/jpeg"));
			const blob = png ? await png.getType("image/png") : await jpeg?.getType("image/jpeg");
			if (!blob?.size) throw new Error("剪贴板中没有图片。");
			const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
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
				ref = draftAttachments(drafts.get(id) ?? findSession(id)).find((item) => item.id === key);
			} else {
				if (!uid.test(requestId)) throw new Error("无效的消息。");
				findSession(id);
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
	// 压缩要等摘要模型返回，不占用会话变更的串行队列；期间会话视为忙碌。
	handle("compact-context", async (id) => {
		requireWritableWorkbench();
		findSession(id);
		if (id !== workbench.selected) throw new Error("会话已切换，请在当前会话操作。");
		if (!model) throw new Error("请先配置模型。");
		if (sessionBusy(id)) throw new Error("会话正在运行，结束后再压缩。");
		compacting.add(id);
		announce();
		try {
			const runtime = await getSessionRuntime(id);
			return await runtime.call("compact", { session: id }, 600_000);
		} finally {
			compacting.delete(id);
			announce();
			queue.schedule(id);
		}
	});
	handle("cancel-compact", (id) => {
		findSession(id);
		if (compacting.has(id)) return host?.call("cancel-compact", { session: id });
	});
	handle("copy-reply", async (id, requestId) => {
		if (typeof requestId !== "string" || !uid.test(requestId)) throw new Error("无效请求标识");
		const runtime = await getSessionRuntime(id);
		const history = await runtime.call("history", { session: id });
		const record = history.find((entry) => entry.requestId === requestId);
		if (!record?.text) throw new Error("回复原文暂不可用。");
		return clipboard.writeText(record.text);
	});
	handle("open-reply-link", (value) => shell.openExternal(replyLink(value).href));

	async function selectedSnapshot(id) {
		const owner = findSession(id);
		if (workbench.selected !== id) throw new Error("会话已切换，请在当前会话操作。");
		const { signal } = workspaceSelection;
		const snapshot = await readJson(join(sessionsDirectory, `${id}.json`));
		signal.throwIfAborted();
		if (
			snapshot &&
			((snapshot.workspaceId ?? snapshot.requests[0]?.workspaceId) !== owner.workspace.id ||
				snapshot.requests.some(({ workspaceId }) => workspaceId !== owner.workspace.id))
		)
			throw new Error("会话与工作区归属不一致。");
		return { owner, snapshot, signal };
	}

	async function ownedTurn(id, requestId) {
		if (!uid.test(requestId)) throw new Error("无效的消息。");
		const view = await selectedSnapshot(id);
		const record = view.snapshot?.requests.find((row) => row.requestId === requestId);
		if (!record || record.workspaceId !== view.owner.workspace.id) throw new Error("消息不属于当前工作区。");
		return { ...view, record };
	}

	function workspaceHasRunning(workspace) {
		return [...workbench.sessions, ...workbench.sideChats].some(
			({ id, workspace: space }) => space.id === workspace && sessionBusy(id),
		);
	}

	handle("turn-changes", async (id, requestId) => {
		const { owner, record, signal } = await ownedTurn(id, requestId);
		const files = await listTurnChanges(sessionsDirectory, owner.workspace, id, requestId, turnArtifacts(record));
		signal.throwIfAborted();
		return { files, canUndo: owner.writeMode !== "read" && !workspaceHasRunning(owner.workspace.id) };
	});
	handle("undo-turn-changes", (id, requestId) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			const { owner, record, signal } = await ownedTurn(id, requestId);
			if (owner.writeMode === "read") throw new Error("只读会话不能撤销工作区文件。");
			if (workspaceHasRunning(owner.workspace.id)) throw new Error("请等待此工作区中的任务结束。");
			const artifacts = turnArtifacts(record);
			const files = await listTurnChanges(sessionsDirectory, owner.workspace, id, requestId, artifacts);
			const ready = files.filter(({ status }) => status === "ready").map(({ path }) => path);
			if (!ready.length) return { files, undone: 0 };
			const { response } = await dialog.showMessageBox(window, {
				type: "warning",
				buttons: ["取消", "撤销变更"],
				defaultId: 0,
				cancelId: 0,
				message: "撤销本轮文件变更？",
				detail: `工作区：${owner.workspace.root}\n${ready.slice(0, 10).join("\n")}${ready.length > 10 ? `\n另有 ${ready.length - 10} 个文件` : ""}\n已修改的文件会保留。可撤销的文件将移至此工作区的恢复目录。`,
			});
			if (response !== 1) return;
			signal.throwIfAborted();
			return undoTurnChanges(sessionsDirectory, owner.workspace, id, requestId, artifacts, ready);
		}),
	);

	async function revisionPlan(id, requestId, mode) {
		const view = await selectedSnapshot(id);
		if (sessionBusy(id) || storedQueue(view.owner).length) throw new Error("请先完成当前会话的运行和排队任务。");
		return { ...view, plan: planSessionRevision(view.snapshot, requestId, mode) };
	}

	handle("session-revision-preview", async (id, requestId, mode) => {
		const { owner, plan, snapshot, signal } = await revisionPlan(id, requestId, mode);
		const files = [];
		for (const record of plan.excluded) {
			const affected = await listTurnChanges(
				sessionsDirectory,
				owner.workspace,
				id,
				record.requestId,
				turnArtifacts(record),
			);
			files.push(...affected);
			signal.throwIfAborted();
		}
		return {
			input: plan.input,
			retained: plan.count,
			excluded: plan.excluded.length,
			title: owner.title,
			revision: snapshot.lastSequence,
			files: files.slice(0, 60),
			fileCount: files.length,
			canUndo:
				mode === "rewind" &&
				owner.writeMode !== "read" &&
				!workspaceHasRunning(owner.workspace.id) &&
				files.some(({ status }) => status === "ready"),
		};
	});
	handle("apply-session-revision", (id, requestId, mode, revision, input, undoPaths) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			const { owner, plan, snapshot, signal } = await revisionPlan(id, requestId, mode);
			if (snapshot.lastSequence !== revision) throw new Error("会话内容已变化，请重新预览。");
			if (mode === "edit" && (typeof input !== "string" || !input.trim() || input.length > 16000 || !model))
				throw new Error("请配置模型并输入有效任务说明，最多 16000 字符。");
			if (
				!Array.isArray(undoPaths) ||
				undoPaths.length > 60 ||
				undoPaths.some((path) => typeof path !== "string" || path.length > 1024)
			)
				throw new Error("撤销文件范围无效，请重新预览。");
			if (undoPaths.length && (mode !== "rewind" || owner.writeMode === "read" || workspaceHasRunning(owner.workspace.id)))
				throw new Error("当前权限或工作区状态不允许撤销文件。");
			const nextId = randomUUID();
			const [recordPath, assetsPath] = revisionPaths(sessionsDirectory, nextId);
			const firstEdit = mode === "edit" && !plan.count && !plan.end;
			const scratch = firstEdit && { id: nextId, title: "新会话", workspace: owner.workspace, writeMode: owner.writeMode };
			let copies;
			try {
				if (scratch) await saveFirstIntent(sessionsDirectory, scratch);
				copies = await copySessionPrefix(sessionsDirectory, id, nextId, snapshot, plan, mode);
				if (mode === "edit") requireImageSupport(copies.attachments);
				signal.throwIfAborted();
				if (scratch) {
					scratch.attachments = copies.attachments;
					drafts.set(nextId, scratch);
					draftAssetIntents.add(nextId);
					selectWorkspaceSession(nextId);
					announce();
					firstSends.set(nextId, { owner: scratch, input });
					try {
						await submitFirst(scratch, input, copies.attachments);
						return { id: nextId };
					} catch {
						return { id: nextId, draft: input };
					} finally {
						firstSends.delete(nextId);
					}
				}
				await writeJson(recordPath, copies.snapshot);
				const previous = structuredClone(workbench);
				const title = owner.title;
				if (mode === "rewind") owner.title = `${Array.from(title).slice(0, 48).join("")} · 回退前`;
				const suffix = mode === "edit" ? " · 编辑重发" : " · 分叉";
				workbench.sessions.unshift({
					id: nextId,
					workspace: owner.workspace,
					writeMode: owner.writeMode,
					title: mode === "rewind" ? title : `${Array.from(title).slice(0, 48).join("")}${suffix}`,
				});
				selectWorkspaceSession(nextId);
				await persistChange(previous);
			} catch (error) {
				await Promise.allSettled([rm(recordPath, { force: true }), rm(assetsPath, { recursive: true, force: true })]);
				if (scratch) await finishFirstIntent(sessionsDirectory, nextId).catch(() => {});
				throw error;
			}
			if (mode === "edit") {
				try {
					await submitRequest(nextId, { input, attachments: copies.attachments });
				} catch {
					const accepted = await readJson(recordPath).catch(() => undefined);
					if (accepted?.requests.slice(copies.snapshot.requests.length).some((row) => row.input === input.trim()))
						return { id: nextId };
					await writeDraft(findSession(nextId), copies.attachments);
					return { id: nextId, draft: input };
				}
			}
			let undone = 0;
			let unresolved = 0;
			if (undoPaths.length) {
				for (const record of [...plan.excluded].reverse()) {
					try {
						const outcome = await undoTurnChanges(
							sessionsDirectory,
							owner.workspace,
							id,
							record.requestId,
							turnArtifacts(record),
							undoPaths,
						);
						undone += outcome.undone;
						unresolved += outcome.files.filter(
							({ path, status }) => undoPaths.includes(path) && status !== "undone" && status !== "missing",
						).length;
					} catch {
						unresolved++;
					}
				}
			}
			return { id: nextId, undone, unresolved };
		}),
	);

	handle("copy-session-markdown", async (id) => {
		const { owner, snapshot } = await selectedSnapshot(id);
		return clipboard.writeText(conversationMarkdown(owner.title, exportTurns(snapshot)));
	});
	handle("export-session-html", async (id) => {
		const { owner, snapshot, signal } = await selectedSnapshot(id);
		const html = conversationHtml(owner.title, exportTurns(snapshot));
		const safe = owner.title
			.replace(/[<>:"/\\|?*\p{Cc}]/gu, " ")
			.trim()
			.slice(0, 56);
		const { canceled, filePath } = await dialog.showSaveDialog(window, {
			title: "导出会话 HTML",
			defaultPath: `Flower - ${safe || "会话"}.html`,
			filters: [{ name: "HTML 文档", extensions: ["html"] }],
		});
		if (canceled || !filePath) return false;
		signal.throwIfAborted();
		await writeFile(filePath, html, { encoding: "utf8", flag: "wx" }).catch((error) => {
			if (error.code === "EEXIST") throw new Error("目标文件已存在，请选择另一个文件名。");
			throw error;
		});
		return true;
	});
	handle("session-image-content", async (id, selection) => {
		if (
			!Array.isArray(selection) ||
			!selection.length ||
			selection.length > 30 ||
			selection.some(
				(entry) =>
					typeof entry?.requestId !== "string" ||
					!uid.test(entry.requestId) ||
					!["user", "reply", "steer"].includes(entry.kind) ||
					!Number.isSafeInteger(entry.index) ||
					entry.index < 0,
			)
		)
			throw new Error("请选择 1 到 30 条已结束的消息。");
		const { snapshot } = await selectedSnapshot(id);
		return { title: "对话摘选", segments: exportSelectedSegments(snapshot, selection) };
	});
	handle("copy-session-image", (id, bytes) => {
		findSession(id);
		if (workbench.selected !== id) throw new Error("会话已切换，请重新选择消息。");
		if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33 || bytes.byteLength > 20 * 1024 * 1024)
			throw new Error("消息图片过大。请选择较少的消息。");
		const png = Buffer.from(bytes);
		if (
			!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
			png.toString("ascii", 12, 16) !== "IHDR" ||
			png.readUInt32BE(16) !== 960 ||
			png.readUInt32BE(20) > 12000
		)
			throw new Error("无法复制这张消息图片。");
		const image = nativeImage.createFromBuffer(png);
		if (image.isEmpty()) throw new Error("无法复制这张消息图片。");
		return clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]);
	});

	handle("desktop-update-state", updateState);
	handle("check-desktop-update", () => {
		void desktopUpdater?.check();
		return updateState();
	});
	handle("schedule-desktop-update", (enabled) =>
		serializeTaskChange(() => desktopUpdater?.schedule(enabled) ?? updateState()),
	);
	handle("restart-desktop-update", () =>
		serializeTaskChange(() => {
			if (!desktopUpdater) return updateState();
			const result = desktopUpdater.restart();
			updateRestarting = true;
			if (macOS) {
				// 等待已有资料写入结束，再让 Electron 原生更新器关闭窗口和重新启动。
				setImmediate(() => {
					void writes.then(() => desktopUpdater.onQuit());
				});
			} else setImmediate(() => app.quit());
			return result;
		}),
	);
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
		return unfinishedRequest(id, requestId);
	}

	/**
	 * 读取会话中可重新发送的未完成请求及其原附件。
	 * @param {string} id 会话 ID
	 * @param {string} [requestId] 请求 ID，缺省时取最后一条
	 * @returns {Promise<{runtime: object, record: object, refs: object[]}>} 运行时、历史行与原附件
	 */
	async function unfinishedRequest(id, requestId) {
		const runtime = await getSessionRuntime(id);
		const rows = await runtime.call("history", { session: id });
		const record = requestId ? rows.find((entry) => entry.requestId === requestId) : rows.at(-1);
		if (!record || !["failed", "cancelled", "interrupted", "denied"].includes(record.status) || !record.input)
			throw new Error("只能重试或编辑未完成的请求。");
		// 早期记录只有单个工作区文件字段，按同样的引用格式恢复。
		const refs = record.attachments?.length ? record.attachments : record.file ? [fileReference(record.file)] : [];
		return { runtime, record, refs };
	}

	/** 以当前模型设置打开标题请求：关闭推理并限定输出，不占用会话运行。@param {object} context 模型上下文 @param {AbortSignal} signal 超时信号 @returns {AsyncIterable<object>} 模型事件 */
	const openTitleStream = (context, signal) =>
		openModelStream({ settings, model, reasoning: undefined, context, signal, maxTokens: 256 });

	/**
	 * 首条消息的自动命名：立即写入临时标题，再在后台用当前模型生成；只在标题仍是临时标题时覆盖，失败静默保留。
	 * @param {object} owner 待命名的会话
	 * @param {string} text 首条消息原文
	 * @returns {Promise<void>}
	 */
	async function startAutoTitle(owner, text) {
		const placeholder = placeholderTitle(text);
		const previous = structuredClone(workbench);
		delete owner.titlePending;
		if (placeholder) owner.title = placeholder;
		try {
			await persistChange(previous);
		} catch {
			// 标题保存失败不影响已提交的消息。
			return;
		}
		suggestFirstTitle(owner, text, placeholder);
	}

	function suggestFirstTitle(owner, text, placeholder) {
		if (!placeholder) return;
		void generateTitle(openTitleStream, firstMessageContext(text), AbortSignal.timeout(15000))
			.then((title) =>
				serializeTaskChange(async () => {
					const current = workbench.sessions.find((entry) => entry.id === owner.id);
					// 生成期间用户改过名或删除了会话时丢弃结果。
					if (!current || current.title !== placeholder || title === placeholder) return;
					const before = structuredClone(workbench);
					current.title = title;
					await persistChange(before);
				}),
			)
			.catch(() => {});
	}

	/**
	 * 把一条消息直接提交给运行时。
	 * @param {string} id 会话 ID
	 * @param {{input: string, attachments?: object[], skill?: string}} item 消息原文、附件与可选技能
	 * @returns {Promise<object>} 运行时请求记录
	 */
	async function submitRequest(id, { input, attachments = [], skill }) {
		requireWritableWorkbench();
		if (!model) throw new Error("请先配置模型。");
		requireImageSupport(attachments);
		const runtime = await getSessionRuntime(id);
		return runtime.call("submit", {
			session: id,
			input,
			...(attachments.length && { attachments }),
			...(skill && { skill }),
		});
	}

	async function submitFirst(owner, input, attachments, skill) {
		const { id, workspace } = owner;
		const current = await approveWorkspace(workspace.root).catch(() => undefined);
		if (current?.id !== workspace.id) throw new Error("工作区位置已变化，请重新选择目录。");
		await saveFirstIntent(sessionsDirectory, owner);
		const runtime = await prepare();
		await runtime.call("register", { session: id, workspace });
		let first;
		try {
			first = await runtime.call("submit", { session: id, input, attachments, first: true, ...(skill && { skill }) });
		} catch (error) {
			// IPC 可能在原子落盘后中断。以本机快照为准，避免把已接收的任务再次发送。
			first = await acceptedFirst(sessionsDirectory, owner);
			if (!first) throw error;
			if (!host && ["queued", "running", "cancelling"].includes(first.status)) {
				first.status = "interrupted";
				interrupted.add(id);
			}
		}
		promoteDraft(owner, first.input);
		try {
			await record();
			await finishFirstIntent(sessionsDirectory, id).catch(() => {});
		} catch {
			// 运行时请求已经接受。保留意图比移除会话安全，启动时可补齐侧栏记录。
			announce();
			send({ kind: "notice", session: id, tone: "error", text: "消息已发送。会话列表暂未保存，重开时可恢复。" });
		}
		suggestFirstTitle(owner, first.input, placeholderTitle(first.input));
		return first;
	}

	handle("submit", (id, text, firstOnly = false, skill) => {
		const draft = drafts.get(id);
		if (firstSends.has(id) || (firstOnly === true && !draft)) throw new Error("草稿首条消息已经在发送或已发送。");
		if (draft) firstSends.set(id, { owner: draft, input: text });
		return serializeTaskChange(async () => {
			if (typeof text !== "string" || !text.trim() || text.length > 16000) {
				throw new Error("请输入有效任务说明，最多 16000 字符");
			}
			if (!model) throw new Error("请先配置模型。");
			const owner = draftOwner(id);
			if (skill !== undefined) await extensions.selectedSkill(owner.workspace, skill, workspaceSelection.signal);
			const refs = draftAttachments(owner);
			requireImageSupport(refs);
			if (draft) return submitFirst(owner, text, refs, skill);
			// 附件随消息离开草稿；提交或入队失败时放回。
			if (refs.length) await writeDraft(owner, []);
			let record;
			try {
				interrupted.delete(id);
				record = await queue.accept(owner, text, refs, skill);
			} catch (error) {
				if (refs.length) await writeDraft(owner, refs);
				throw error;
			}
			if (owner.titlePending) await startAutoTitle(owner, text);
			return record;
		}).finally(() => firstSends.delete(id));
	});
	handle("rename-session-ai", (id) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			findSession(id);
			if (!model) throw new Error("请先配置模型。");
			const turns = searchableTurns(await readJson(join(sessionsDirectory, `${id}.json`))).filter(
				({ input, text }) => input.trim() || text.trim(),
			);
			if (!turns.length) throw new Error("会话中还没有可用于命名的内容。");
			return turns;
		}).then(async (turns) => {
			// 生成在串行区外进行，等待模型期间不阻塞其他会话操作。
			const signal = AbortSignal.timeout(30000);
			let title;
			try {
				title = await generateTitle(openTitleStream, conversationContext(turns), signal);
			} catch (error) {
				throw new Error(signal.aborted ? "生成标题超时，请稍后重试。" : `暂时无法生成标题：${error.message}`);
			}
			return serializeTaskChange(async () => {
				requireWritableWorkbench();
				const owner = findSession(id);
				const previous = structuredClone(workbench);
				owner.title = title;
				delete owner.titlePending;
				await persistChange(previous);
				return title;
			});
		}),
	);
	handle("retry-request", (id, requestId) =>
		serializeTaskChange(async () => {
			const { record, refs } = await retryableRequest(id, requestId);
			if (!model) throw new Error("请先配置模型。");
			requireImageSupport(refs);
			// 以原输入和原附件新建一轮，原记录保留在历史中，当前草稿不受影响；会话忙时排队。
			interrupted.delete(id);
			return queue.accept(findSession(id), record.input, refs, record.skill);
		}),
	);
	handle("search-sessions", async (query) => {
		if (typeof query !== "string" || query.length > 180) throw new Error("搜索内容无效");
		const needle = query.trim();
		// 单字命中过多，只按名称匹配；正文从两个字起搜。
		if ([...needle].length < 2) return [];
		const results = [];
		for (const { id } of workbench.sessions) {
			const snippets = searchSnippets(await indexedTurns(id), needle);
			if (snippets.length) results.push({ id, snippets });
			if (results.length >= 50) break;
		}
		return results;
	});
	handle("resume-interrupted", (ids) =>
		serializeTaskChange(async () => {
			requireWritableWorkbench();
			if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !interrupted.has(id)))
				throw new Error("中断任务已变化，请重新查看。");
			if (!model) throw new Error("请先配置模型。");
			const failed = [];
			for (const id of ids) {
				try {
					const owner = findSession(id);
					const { record, refs } = await unfinishedRequest(id);
					requireImageSupport(refs);
					// 继续的任务排在重启后保留的排队消息之前。
					if (storedQueue(owner).length) {
						await queue.restore(id, {
							id: randomUUID(),
							input: record.input,
							...(refs.length && { attachments: refs }),
							...(record.skill && { skill: record.skill }),
							createdAt: Date.now(),
						});
						await queue.resume(id);
					} else await queue.accept(owner, record.input, refs, record.skill);
					interrupted.delete(id);
				} catch {
					failed.push(workbench.sessions.find((entry) => entry.id === id)?.title ?? id);
				}
			}
			announce();
			if (failed.length) throw new Error(`以下任务未能继续：${failed.join("、")}`);
		}),
	);
	handle("dismiss-interrupted", () => {
		interruptedDismissed = true;
		announce();
	});
	/** 校验排队消息标识并取当前会话。@param {string} id 会话 ID @param {string} itemId 排队消息 ID @returns {object} 会话记录 */
	function queueOwner(id, itemId) {
		if (typeof itemId !== "string" || !uid.test(itemId)) throw new Error("无效的排队消息。");
		return draftOwner(id);
	}
	handle("edit-queue-item", (id, itemId, input, keep) =>
		serializeTaskChange(async () => {
			const owner = queueOwner(id, itemId);
			await discardUnused(owner, await queue.edit(id, itemId, input, keep));
		}),
	);
	handle("remove-queue-item", (id, itemId) =>
		serializeTaskChange(async () => {
			const owner = queueOwner(id, itemId);
			const removed = await queue.take(id, itemId);
			await discardUnused(owner, removed.attachments ?? []);
		}),
	);
	handle("hold-queue-item", (id, itemId) => {
		if (itemId === undefined || itemId === null) {
			draftOwner(id);
			return queue.hold(id);
		}
		queueOwner(id, itemId);
		return queue.hold(id, itemId);
	});
	handle("reorder-queue", (id, ids) =>
		serializeTaskChange(() => {
			draftOwner(id);
			return queue.reorder(id, ids);
		}),
	);
	handle("resume-queue", (id) =>
		serializeTaskChange(() => {
			draftOwner(id);
			return queue.resume(id);
		}),
	);
	// 插话可能要读取附件，不占用会话变更的串行队列。
	handle("steer-queue-item", (id, itemId) => {
		queueOwner(id, itemId);
		return queue.steer(id, itemId);
	});
	handle("restore-request-draft", (id, requestId) =>
		serializeTaskChange(async () => {
			const { record, refs } = await retryableRequest(id, requestId);
			await writeDraft(draftOwner(id), refs);
			return { input: record.input };
		}),
	);
	handle("copy-text", (text) => {
		if (typeof text !== "string" || !text || text.length > 200_000) throw new Error("无法复制这段内容。");
		return clipboard.writeText(text);
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
		// 用户主动停止后队列暂停，避免下一条消息立即开始。
		queue.pause(id);
		if (runId) return cancelRun(id, requestId, runId);
		const record = await host.call("cancel-queued", { session: id, requestId });
		return record.status === "running" && record.runId ? cancelRun(id, requestId, record.runId) : record;
	});
	// 只读元信息：限当前会话工作区内符合产物格式的路径，不启动外部程序，按修改时间与大小缓存。
	const artifactInfos = new Map();
	handle("artifact-info", (id, path) =>
		readSelectedWorkspace(id, async (workspace, signal) => {
			const file = await resolveArtifact(workspace, path);
			const info = await stat(file);
			const key = JSON.stringify([workspace.id, path]);
			const cached = artifactInfos.get(key);
			if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.summary;
			const summary = await artifactSummary(workspace, path, signal);
			artifactInfos.set(key, { mtimeMs: info.mtimeMs, size: info.size, summary });
			return summary;
		}),
	);
	handle("open-artifact", async (id, requestId, path) => {
		const runtime = await getSessionRuntime(id);
		const history = await runtime.call("history", { session: id });
		if (!history.find((entry) => entry.requestId === requestId)?.artifacts.includes(path))
			throw new Error("产物不属于当前会话");
		const file = await resolveArtifact(findSession(id).workspace, path);
		const error = await shell.openPath(file);
		if (error) throw new Error(`系统无法打开 ${basename(file)}`);
	});

	app.commandLine.appendSwitch("disable-background-networking");
	app.once("ready", async () => {
		Menu.setApplicationMenu(
			macOS ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null,
		);
		const palette = titlebarPalettes[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
		const savedWindow = readWindowState(windowStatePath);
		const restored = restorableBounds(
			savedWindow,
			screen.getAllDisplays().map(({ workArea }) => workArea),
		);
		const icon = packagedWindows
			? join(process.resourcesPath, "flower.ico")
			: fileURLToPath(new URL("./ui/flower-icon.png", import.meta.url));
		const installation =
			packagedWindows && updateChannel
				? await findPortableInstallation(process.execPath, app.getVersion(), updateChannel.id)
				: undefined;
		if (exiting) return;
		window = new BrowserWindow({
			title: "Flower Desktop",
			icon,
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
		window.webContents.on("render-process-gone", () => {
			nativePanels.close();
			dismissApprovals();
			const pending = questions.sessions();
			for (const [requestId, { session, runId, running }] of activeRequests) {
				if (host && running && pending.has(session)) void cancelRun(session, requestId, runId).catch(() => {});
			}
			questions.dismiss();
		});
		window.on("closed", () => {
			nativePanels.close();
			dismissApprovals();
		});
		window.on("focus", () => {
			window.flashFrame(false);
			if (attention.clear(workbench.selected)) announce();
		});
		if (packagedWindows) {
			const launcher = installation ? join(installation.root, "Flower Desktop.exe") : process.execPath;
			window.setAppDetails({
				appId: windowsAppId,
				appIconPath: launcher,
				appIconIndex: 0,
				// 固定到任务栏后仍通过顶层启动器打开当前版本。
				...(!app.commandLine.hasSwitch("user-data-dir") && {
					relaunchCommand: `"${launcher}"`,
					relaunchDisplayName: "Flower Desktop",
				}),
			});
			try {
				tray = new Tray(icon);
				tray.setToolTip("Flower Desktop");
				tray.setContextMenu(
					Menu.buildFromTemplate([
						{ label: "打开 Flower Desktop", click: showWorkbench },
						{ type: "separator" },
						{ label: "退出 Flower", click: () => app.quit() },
					]),
				);
				tray.on("click", showWorkbench);
			} catch (error) {
				// 没有可用的恢复入口时，保留正常关窗和退出流程。
				tray?.destroy();
				tray = undefined;
				console.warn("Flower 系统托盘初始化失败", error);
			}
			window.on("session-end", () => {
				quitRequested = closeConfirmed = true;
				saveWindowState();
			});
		}
		window.on("close", (event) => {
			if (tray && !quitRequested && !updateRestarting) {
				event.preventDefault();
				saveWindowState();
				window.hide();
				return;
			}
			// 已提交和接下来会自动派发的任务都要通过关闭确认。
			const pending = pendingWork();
			if (closeConfirmed || !pending) {
				saveWindowState();
				return;
			}
			event.preventDefault();
			if (askingToClose) return;
			askingToClose = true;
			if (tray && !window.isVisible()) showWorkbench();
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
				.catch(() => ({ response: 1 }))
				.then(({ response }) => {
					askingToClose = false;
					if (response !== 0 || !window || window.isDestroyed()) {
						quitRequested = false;
						updateRestarting = false;
						desktopUpdater?.cancelRestart();
						return;
					}
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
			// 页面重新加载后不再有进行中的行内编辑。
			queue.release();
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
		if (updateChannel && app.isPackaged && process.platform === "win32" && process.arch === "x64") {
			desktopUpdater = createDesktopUpdater({
				config: updateChannel,
				version: app.getVersion(),
				executable: process.execPath,
				userData: app.getPath("userData"),
				directory,
				available: true,
				findInstallation: () => installation,
				notify: announce,
				busy: updateBusy,
				storage: safeStorage,
				fetcher:
					updateChannel.id === "stable"
						? async (url, options) => {
								const { net } = await import("electron");
								return electronReleaseFetch((request) => net.request(request))(url, options);
							}
						: undefined,
			});
		} else if (macOS && app.isPackaged && updateChannel) {
			const { autoUpdater } = await import("electron");
			if (exiting) return;
			desktopUpdater = createMacDesktopUpdater({
				native: autoUpdater,
				config: updateChannel,
				version: app.getVersion(),
				notify: announce,
				busy: updateBusy,
				beforeRestart: () => {
					macRestartHandoff = true;
				},
				restartFailed: () => {
					macRestartHandoff = updateRestarting = false;
					if (!window || window.isDestroyed()) app.quit();
				},
			});
			announce();
		}
		if (desktopUpdater) {
			const check = () => void desktopUpdater.check();
			startupUpdate = setTimeout(check, 1500).unref();
			periodicUpdate = setInterval(check, 4 * 60 * 60 * 1000).unref();
		}
	});
	app.on("second-instance", showWorkbench);
	app.on("before-quit", () => {
		quitRequested = true;
	});
	app.on("window-all-closed", () => {
		// 原生更新器关闭最后一个窗口后仍需安排重新启动。
		if (!macRestartHandoff) app.quit();
	});
	app.on("will-quit", (event) => {
		exiting = true;
		tray?.destroy();
		tray = undefined;
		clearInterval(automationTimer);
		automation.close();
		clearTimeout(startupUpdate);
		clearInterval(periodicUpdate);
		host?.close();
		questions.dismiss();
		if (handingOffUpdate) {
			event.preventDefault();
			return;
		}
		if (!desktopUpdater?.wantsInstall()) {
			desktopUpdater?.stop();
			return;
		}
		// 只有关闭确认通过、全部窗口关闭后才允许启动更新器。
		event.preventDefault();
		handingOffUpdate = true;
		void writes
			.catch(() => {})
			.then(() => desktopUpdater.onQuit())
			.catch(() => {})
			.finally(() => app.exit(0));
	});
}
