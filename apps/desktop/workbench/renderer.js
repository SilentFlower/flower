const ui = window.flower;
const { agentUI, flowerUI } = window;
const by = (id) => document.getElementById(id);
const toolLabels = {
	list_workspace: "查看目录",
	read_text_file: "读取文件",
	inspect_excel: "检查工作簿",
	analyze_excel: "汇总工作簿",
	write_report: "写入核对报告",
};
const activeStatuses = new Set(["queued", "running", "cancelling"]);
let state;
let session;
let model;
let eventRevision = 0;
let contextRevision = 0;
let streamFrame = 0;
const drafts = new Map();
const timelines = new Map();
let recentSession;
const visits = [];
let visitIndex = -1;
let moving;
const picker = by("model-picker");
const modePicker = by("write-mode-picker");
const modeOptions = [...modePicker.querySelectorAll("[data-write-mode]")];
const writePanel = by("write-approval");
const workbench = by("workbench");
const sidebarPreference = "flower.desktop.sidebar.collapsed";
const sidebarViewPreference = "flower.desktop.sidebar.view";
const sidebarView = by("sidebar-view");
let groupedByWorkspace = false;
const searchBox = by("session-search-box");
const searchInput = by("session-search");
const searchButton = by("session-search-toggle");
const filterButton = by("session-filter-open");
const filterPanel = by("session-filter");
// 空字符串表示“全部”，与选择框的默认选项对应
const sessionFilter = { status: "", workspace: "" };
const statusFilters = {
	busy: (item) => item.busy,
	waiting: (item) => item.awaitingWrite,
};
const statusOptions = [
	{ value: "", label: "全部" },
	{ value: "busy", label: "进行中" },
	{ value: "waiting", label: "待批准" },
];
const back = by("sidebar-back");
const forward = by("sidebar-forward");
let writeApproval;
let pickerRequest = 0;
let pickerRevision;
let choosingModel = false;
let effortSaving = false;
let nextEffort;
let editingService;
let editingRevision;
let settingsEditor;
let settingsDiscovery = 0;
let settingsSaving = false;
let editorFocus;
let settingsFocus;
let capabilityRequest = 0;
let recommendedLevels = [];
let manualLevelsInitialized = false;
const effortNames = {
	default: "服务默认",
	off: "关闭",
	minimal: "极低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最高",
};
const reduceEffortMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let lastEffortPosition = 0;
const modelsWithIcons = [
	[/^(?:openai\/)?(?:gpt-|o[134](?:-|$))/, "openai", "openai.svg"],
	[/^(?:deepseek-ai\/)?deepseek/, "deepseek", "deepseek-color.svg"],
	[/^(?:anthropic\/)?claude/, "anthropic", "claude-color.svg"],
	[/^(?:google\/)?gemini/, "gemini", "gemini-color.svg"],
	[/^(?:alibaba\/)?(?:qwen|qwq)/, "qwen", "qwen-color.svg"],
	[/^(?:x-ai\/|xai\/)?grok/, "grok", "grok.svg"],
	[/^(?:moonshot(?:ai)?\/)?(?:kimi|moonshot)/, "moonshot", "moonshot.svg"],
	[/^(?:z-ai\/|zhipu\/)?glm-/, "zhipu", "zhipu-color.svg"],
	[/^(?:mistralai\/)?(?:mistral|codestral|pixtral|ministral)/, "mistral", "mistral-color.svg"],
];
const updateSessions = agentUI.sessionList(
	by("sessions"),
	(id) => action(() => ui.selectSession(id))(),
	openSidebarMenu,
);
const sidebarOptions = by("sidebar-options");
const sidebarDialog = by("sidebar-dialog");
let sidebarEdit;

function openSidebarMenu(type, key, trigger) {
	const space = type === "workspace";
	const item = space
		? state.workspaces.find((entry) => entry.workspaceId === key)
		: state.sessions.find((entry) => entry.id === key);
	if (!item) return;
	const label = space ? item.workspace : item.title;
	const members = state.sessions.filter((entry) => entry.workspaceId === key).length;
	const noun = space ? "工作区" : "会话";
	const options = [
		...(space ? [["create", "plus", "新建会话"]] : []),
		["pin", "pin", item.pinned ? "取消置顶" : "置顶"],
		["rename", "pencil", "重命名"],
		["delete", "trash", space ? "移除工作区" : "删除会话"],
	];
	sidebarOptions.replaceChildren(
		...options.map(([operation, glyph, title]) => {
			const control = flowerUI.button(
				"",
				() => {
					sidebarOptions.hidePopover();
					trigger.focus();
					if (["pin", "create"].includes(operation))
						return action(() => ui.manageSidebar(type, key, operation, !item.pinned))();
					sidebarEdit = { type, key, operation, members, trigger };
					const rename = operation === "rename";
					by("sidebar-dialog-title").textContent = rename ? `重命名${noun}` : title;
					by("sidebar-detail").textContent = rename
						? ""
						: space
							? `从 Flower 移除「${label}」及其 ${members} 条会话。磁盘上的工作区文件会保留。`
							: `将删除「${label}」的聊天记录和附件副本。`;
					const field = by("sidebar-name");
					field.hidden = field.disabled = !rename;
					field.value = label;
					by("sidebar-apply").textContent = rename ? "保存" : title;
					by("sidebar-apply").classList.toggle("destructive", !rename);
					sidebarDialog.showModal();
					if (rename) {
						field.focus();
						field.select();
					} else by("sidebar-cancel").focus();
				},
				"sidebar-menu-item",
			);
			control.setAttribute("role", "menuitem");
			control.dataset.operation = operation;
			control.append(flowerUI.icon(glyph), document.createTextNode(title));
			return control;
		}),
	);
	sidebarOptions.showPopover();
	const rect = trigger.getBoundingClientRect();
	sidebarOptions.style.left = `${Math.max(6, Math.min(innerWidth - sidebarOptions.offsetWidth - 6, rect.right - sidebarOptions.offsetWidth))}px`;
	sidebarOptions.style.top = `${rect.bottom + sidebarOptions.offsetHeight < innerHeight - 6 ? rect.bottom + 3 : Math.max(6, rect.top - sidebarOptions.offsetHeight - 3)}px`;
	sidebarOptions.firstElementChild.focus();
}
function menuNavigation(event) {
	const buttons = [...event.currentTarget.querySelectorAll("button")];
	const index = buttons.indexOf(document.activeElement);
	const next = {
		ArrowDown: (index + 1) % buttons.length,
		ArrowUp: (index + buttons.length - 1) % buttons.length,
		Home: 0,
		End: buttons.length - 1,
	}[event.key];
	if (next !== undefined) {
		event.preventDefault();
		buttons[next].focus();
	}
}
sidebarOptions.addEventListener("keydown", menuNavigation);
by("sidebar-cancel").onclick = () => sidebarDialog.close();
sidebarDialog.addEventListener("close", () => {
	const trigger = sidebarEdit?.trigger;
	if (trigger?.isConnected) trigger.focus();
	else by("new-session").focus();
});
by("sidebar-dialog-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const { type, key, operation, members } = sidebarEdit;
	const value = operation === "rename" ? by("sidebar-name").value.trim() : members;
	if (operation === "rename" && !value) return by("sidebar-name").focus();
	sidebarDialog.close();
	void action(() => ui.manageSidebar(type, key, operation, value))();
});

const workspacePanel = window.createWorkspacePanel(ui);
const showDraftFiles = window.flowerAttachments.view(
	by("attachment"),
	(key) => action(() => ui.removeAttachment(session, key))(),
	undefined,
	workspacePanel.previewAttachment,
);

window.flowerAttachments.bind(by("composer"), ui, () => session || ui.chooseWorkspace(), action);
const thread = agentUI.thread(by("timeline"), by("thread-scroll"), {
	cancel: (id, runId) => action(() => ui.cancel(session, id, runId))(),
	open: (id, path) => action(() => ui.openArtifact(session, id, path))(),
	previewAttachment: workspacePanel.previewAttachment,
	preview: (path, trigger) => workspacePanel.preview(path, trigger),
	openLink: (url) => action(() => ui.openReplyLink(url))(),
	copy: (id) =>
		action(async () => {
			await ui.copyReply(session, id);
			flowerUI.feedback(by("feedback"), "已复制回复原文。");
		})(),
});
for (const node of document.querySelectorAll("[data-flower]")) node.append(flowerUI.mark(node.dataset.flower));
agentUI.bindComposer(by("prompt"), by("send"));

function action(fn) {
	return async () => {
		flowerUI.feedback(by("feedback"), "");
		try {
			await fn();
		} catch (error) {
			const text = error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") ?? "操作未完成";
			flowerUI.feedback(by("feedback"), text, "error");
		}
	};
}

function timelineFor(id) {
	if (!timelines.has(id)) timelines.set(id, { requests: new Map(), active: new Set(), submitting: 0 });
	return timelines.get(id);
}

/** 判断当前会话是否可作为空白会话复用。
 * @returns {boolean} 记录已加载，且没有请求、文本草稿和待发附件
 */
function emptySession() {
	const timeline = timelines.get(session);
	const selected = state.sessions.find(({ id }) => id === session);
	return Boolean(
		timeline?.loaded &&
			!timeline.requests.size &&
			!timeline.active.size &&
			!timeline.submitting &&
			!by("prompt").value &&
			!selected?.attachments?.length,
	);
}

function pruneTimelines() {
	for (const [id, timeline] of timelines) {
		if (id !== session && id !== recentSession && !timeline.active.size && !timeline.submitting) timelines.delete(id);
	}
}

function invalidateHistory(timeline) {
	timeline.stale = true;
	timeline.reading = undefined;
}

function renderRequests(follow = false) {
	if (streamFrame) {
		cancelAnimationFrame(streamFrame);
		streamFrame = 0;
	}
	const timeline = timelines.get(session);
	const home = !session || (timeline?.loaded && !timeline.requests.size);
	workbench.dataset.home = String(Boolean(home));
	by("empty").hidden = !home;
	by("title").hidden = !session;
	by("home-suggestions").hidden = !home;
	by("thread-scroll").hidden = home;
	by("history-status").hidden = !session || timeline?.loaded || timeline?.failed || Boolean(timeline?.requests.size);
	thread.update(timeline?.requests.values() ?? [], follow);
}

function matchingSessions(query) {
	const { status, workspace: workspaceId } = sessionFilter;
	return (state?.sessions ?? []).filter(
		(item) =>
			(!workspaceId || item.workspaceId === workspaceId) &&
			(!status || statusFilters[status](item)) &&
			(!query ||
				[item.title, item.workspace, item.path, item.awaitingWrite ? "待批准" : ""].some((value) =>
					value?.toLocaleLowerCase().includes(query),
				)),
	);
}

function renderSessionFilter() {
	statusSelect.render(statusOptions, sessionFilter.status);
	workspaceSelect.render(
		[
			{ value: "", label: "所有工作区" },
			...(state?.workspaces ?? []).map(({ workspaceId, workspace, path }) => ({
				value: workspaceId,
				label: workspace || path,
				title: path,
			})),
		],
		sessionFilter.workspace,
	);
}

function renderSessions() {
	// 筛选中的工作区被移除后回到“所有工作区”，避免列表停在一个不存在的条件上
	if (sessionFilter.workspace && !state?.workspaces.some(({ workspaceId }) => workspaceId === sessionFilter.workspace))
		sessionFilter.workspace = "";
	const query = searchInput.value.trim().toLocaleLowerCase();
	const filtered = Boolean(sessionFilter.status || sessionFilter.workspace);
	const pinnedFirst = (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
	const items = matchingSessions(query).slice().sort(pinnedFirst);
	const matches = new Set(items.map((item) => item.workspaceId));
	const spaces = (state?.workspaces ?? [])
		.filter(
			(space) =>
				(!sessionFilter.workspace || space.workspaceId === sessionFilter.workspace) &&
				// 按状态筛选时只保留有匹配会话的工作区；否则工作区名或路径命中关键字也算匹配
				(matches.has(space.workspaceId) ||
					(!sessionFilter.status &&
						(!query || [space.workspace, space.path].some((value) => value.toLocaleLowerCase().includes(query))))),
		)
		.sort(pinnedFirst);
	const count = groupedByWorkspace ? spaces.length : items.length;
	// 会话列表用 query 判断是否处于搜索态并自动展开分组，筛选条件变化同样视为一次新搜索
	const searchKey = query || filtered ? [query, sessionFilter.status, sessionFilter.workspace].join("\n") : "";
	updateSessions(items, { active: session, grouped: groupedByWorkspace, spaces, query: searchKey });
	by("session-search-empty").hidden = !searchKey || Boolean(count);
	const empty = by("session-list-empty");
	empty.hidden = !state?.ready || Boolean(searchKey) || Boolean(count);
	empty.textContent = groupedByWorkspace ? "暂无工作区" : "暂无会话";
	filterButton.toggleAttribute("data-active", filtered);
	filterButton.setAttribute("aria-label", filtered ? "搜索条件，已启用筛选" : "搜索条件");
}

function setSidebarView(grouped) {
	groupedByWorkspace = grouped;
	sidebarView.setAttribute("aria-pressed", String(grouped));
	sidebarView.title = grouped ? "切换到会话模式" : "切换到工作区模式";
	sidebarView.querySelector("use").setAttribute("href", grouped ? "#icon-session-list" : "#icon-folder");
	by("sessions-title").textContent = grouped ? "工作区" : "会话";
	renderSessions();
}

const sidebarScroll = by("sidebar-scroll");
let sidebarScrollTimer;
function revealSidebarScroll() {
	sidebarScroll.toggleAttribute("data-scrolling", true);
	clearTimeout(sidebarScrollTimer);
	sidebarScrollTimer = setTimeout(() => sidebarScroll.removeAttribute("data-scrolling"), 2000);
}
sidebarScroll.addEventListener("scroll", revealSidebarScroll, { passive: true });
sidebarScroll.addEventListener(
	"mousemove",
	(event) => {
		if (sidebarScroll.scrollHeight <= sidebarScroll.clientHeight) return;
		const edge = sidebarScroll.getBoundingClientRect().right - event.clientX;
		if (edge >= 0 && edge <= 12) revealSidebarScroll();
	},
	{ passive: true },
);

function collapseSidebar(collapsed) {
	workbench.dataset.sidebar = collapsed ? "collapsed" : "expanded";
	by("sidebar-main").hidden = collapsed;
	const toggle = by("sidebar-toggle");
	toggle.title = collapsed ? "展开侧栏" : "折叠侧栏";
	toggle.setAttribute("aria-label", toggle.title);
	toggle.setAttribute("aria-expanded", String(!collapsed));
	try {
		window.localStorage.setItem(sidebarPreference, String(collapsed));
	} catch {
		// 本机偏好不可写时仍允许折叠当前窗口。
	}
}

function showSearch(open) {
	if (open && workbench.dataset.sidebar === "collapsed") collapseSidebar(false);
	searchBox.hidden = !open;
	searchButton.hidden = open;
	if (open) {
		searchInput.focus();
		searchInput.select();
	} else {
		// 收起后列表不应停留在看不见的条件上，关键字与筛选一起清空
		searchInput.value = "";
		sessionFilter.status = "";
		sessionFilter.workspace = "";
		if (filterPanel.matches(":popover-open")) filterPanel.hidePopover();
	}
	renderSessions();
}

try {
	collapseSidebar(window.localStorage.getItem(sidebarPreference) === "true");
	setSidebarView(window.localStorage.getItem(sidebarViewPreference) === "workspace");
} catch {
	// 使用初始视图，本机偏好不可用时仍允许切换。
}
sidebarView.addEventListener("click", () => {
	setSidebarView(!groupedByWorkspace);
	try {
		window.localStorage.setItem(sidebarViewPreference, groupedByWorkspace ? "workspace" : "session");
	} catch {
		// 仅保留当前窗口的视图选择。
	}
});
by("sidebar-toggle").addEventListener("click", () => collapseSidebar(workbench.dataset.sidebar !== "collapsed"));

function syncNavigation() {
	back.disabled = Boolean(moving) || visitIndex <= 0;
	forward.disabled = Boolean(moving) || visitIndex >= visits.length - 1;
}

function rememberVisit() {
	if (visits[visitIndex] === session) return;
	if (moving?.target === session) visitIndex = moving.index;
	else {
		visits.splice(visitIndex + 1, visits.length, session);
		visitIndex = visits.length - 1;
	}
	syncNavigation();
}

for (const [button, step] of [
	[back, -1],
	[forward, 1],
]) {
	button.addEventListener(
		"click",
		action(async () => {
			const index = visitIndex + step;
			if (moving || index < 0 || index >= visits.length) return;
			const restoreFocus = document.activeElement === button;
			moving = { index, target: visits[index] };
			syncNavigation();
			try {
				await ui.selectSession(moving.target);
			} finally {
				moving = undefined;
				syncNavigation();
				if (restoreFocus && [button, document.body].includes(document.activeElement)) {
					const alternate = step < 0 ? forward : back;
					(!button.disabled ? button : !alternate.disabled ? alternate : by("sidebar-toggle")).focus();
				}
			}
		}),
	);
}

const statusSelect = window.flowerSelect(by("session-status-select"), "session-status", "状态", (value) => {
	sessionFilter.status = value;
	renderSessionFilter();
	renderSessions();
});
const workspaceSelect = window.flowerSelect(by("session-workspace-select"), "session-workspace", "工作区", (value) => {
	sessionFilter.workspace = value;
	renderSessionFilter();
	renderSessions();
});
// 与 Cindy 的菜单一致：整行是触发按钮，悬停即展开右侧选项，点击只展开不收起
for (const [id, name] of [
	["session-status", "状态"],
	["session-workspace", "工作区"],
]) {
	const trigger = by(id);
	const menu = by(`${id}-options`);
	trigger.prepend(flowerUI.element("span", "session-filter-name", name));
	trigger.setAttribute("popovertargetaction", "show");
	trigger.addEventListener("pointerenter", () => {
		if (!menu.matches(":popover-open")) menu.showPopover({ source: trigger });
	});
	trigger.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowRight") return;
		event.preventDefault();
		menu.showPopover({ source: trigger });
	});
	menu.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowLeft") return;
		event.preventDefault();
		menu.hidePopover();
		trigger.focus();
	});
}
// 工作区列表随状态变化，打开时再生成选项，避免状态推送重建正在操作的菜单
filterPanel.addEventListener("beforetoggle", ({ newState }) => {
	if (newState === "open") renderSessionFilter();
});
searchButton.addEventListener("click", () => showSearch(true));
// 鼠标点到搜索区以外即恢复成按钮。正在搜索时点结果列表、行菜单或视图切换除外，便于逐条处理结果
const searchResultRegions = [by("sessions"), sidebarOptions, sidebarDialog, sidebarView];
document.addEventListener(
	"pointerdown",
	({ target }) => {
		if (searchBox.hidden || searchBox.contains(target) || filterPanel.contains(target)) return;
		const searching = searchInput.value || filterButton.hasAttribute("data-active");
		if (searching && searchResultRegions.some((node) => node.contains(target))) return;
		showSearch(false);
	},
	true,
);
// 键盘 Tab 移出时只在没有关键字和筛选时收起，避免还没走到结果就被清空
for (const region of [searchBox, filterPanel]) {
	region.addEventListener("focusout", ({ relatedTarget }) => {
		if (!relatedTarget || searchBox.contains(relatedTarget) || filterPanel.contains(relatedTarget)) return;
		if (!searchInput.value && !filterButton.hasAttribute("data-active")) showSearch(false);
	});
}
searchInput.addEventListener("input", renderSessions);
searchInput.addEventListener("keydown", (event) => {
	if (event.isComposing) return;
	if (event.key === "Escape") {
		event.preventDefault();
		showSearch(false);
		searchButton.focus();
	} else if (event.key === "Enter") {
		event.preventDefault();
		const first = [...by("sessions").querySelectorAll(".session-row")].find((button) => !button.closest("[hidden]"));
		first?.click();
	}
});
document.addEventListener("keydown", (event) => {
	if (event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
	if (event.key.toLowerCase() !== "k" || document.querySelector("dialog[open]")) return;
	event.preventDefault();
	showSearch(true);
});
by("assistant-home").addEventListener(
	"click",
	action(async () => {
		if (session) await ui.selectSession("");
		else by("prompt").focus();
	}),
);
by("home-suggestions").addEventListener("click", (event) => {
	const button = event.target.closest("[data-suggestion]");
	if (!button || workbench.dataset.home !== "true") return;
	const prompt = by("prompt");
	const separator = prompt.value && !prompt.value.endsWith("\n") ? "\n" : "";
	const next = `${prompt.value}${separator}${button.dataset.suggestion}`;
	if (next.length <= prompt.maxLength) {
		prompt.value = next;
		prompt.setSelectionRange(next.length, next.length);
		syncSend();
		flowerUI.feedback(by("feedback"), "");
	} else flowerUI.feedback(by("feedback"), "草稿已达长度上限，无法加入建议。", "error");
	prompt.focus();
});

async function reloadHistory(id) {
	if (!id || !state?.ready) return;
	const timeline = timelineFor(id);
	if (timeline.reading || (timeline.loaded && !timeline.stale)) return;
	const stamp = Symbol();
	timeline.reading = stamp;
	const beforeHistory = eventRevision;
	try {
		const rows = await ui.history(id);
		// 这次读取可能已经失效，或该会话已被逐出后以新条目重新打开。
		if (timelines.get(id) !== timeline || timeline.reading !== stamp) return;
		// 已持久化的顺序为准。读取期间收到的事件可继续补充同一条消息。
		const merged = new Map();
		for (const row of rows) {
			const current = timeline.requests.get(row.requestId);
			const newer =
				current &&
				(current.eventRevision > beforeHistory || (activeStatuses.has(row.status) && activeStatuses.has(current.status)));
			merged.set(
				row.requestId,
				newer
					? { ...row, ...current, input: row.input, file: row.file, attachments: row.attachments, artifacts: row.artifacts }
					: { ...row, tools: current?.tools ?? [] },
			);
		}
		for (const [requestId, current] of timeline.requests) {
			if (!merged.has(requestId)) merged.set(requestId, current);
		}
		timeline.requests = merged;
		timeline.active = new Set();
		for (const record of merged.values()) {
			if (activeStatuses.has(record.status)) timeline.active.add(record.requestId);
		}
		timeline.loaded = true;
		timeline.stale = false;
		timeline.failed = false;
		if (id === session) renderRequests();
	} catch {
		if (timelines.get(id) !== timeline || timeline.reading !== stamp) return;
		timeline.failed = true;
		if (id === session) {
			renderRequests();
			flowerUI.feedback(by("feedback"), "暂时无法读取此会话历史。", "error");
		}
	} finally {
		if (timeline.reading === stamp) timeline.reading = undefined;
	}
}

function showContextUsage(usage) {
	const status = by("context-usage");
	const configured = state?.modelSettings?.context;
	status.hidden = !session || !model || !configured;
	if (status.hidden) return;
	const number = (value) => value.toLocaleString("zh-CN");
	const limit = usage?.limit ?? configured.limit;
	status.textContent = usage
		? `上下文约 ${number(usage.tokens)} / ${number(limit)} tokens`
		: `上下文上限 ${number(limit)} tokens`;
	const source = { custom: "手动设置", catalog: "pi 模型目录", fallback: "未知型号的本机兜底" };
	status.title = `会话占用为估算。窗口来源：${source[configured.source] ?? "当前配置"}。`;
	if (configured.source === "fallback") status.textContent += " · 兜底窗口";
}

async function refreshContextUsage(reset = false) {
	const stamp = ++contextRevision;
	if (reset) showContextUsage();
	if (!session || !model || !state?.modelSettings?.context) return;
	try {
		const usage = await ui.contextUsage(session);
		if (stamp === contextRevision) showContextUsage(usage);
	} catch {
		if (stamp === contextRevision) showContextUsage();
	}
}

function update(next) {
	const old = session;
	const previous = state;
	const wasReady = state?.ready;
	state = next;
	model = next.model;
	session = next.selected;
	window.flowerImages.setSession(session);
	const runtimeExited = previous && next.runtimeRevision !== previous.runtimeRevision;
	if (runtimeExited) {
		// 工作进程退出时没有终态事件。保留的会话由恢复后的持久化记录核对状态。
		for (const timeline of timelines.values()) {
			if (!timeline.active.size && !timeline.reading) continue;
			timeline.active.clear();
			invalidateHistory(timeline);
		}
	}
	if (previous && next.sessions.length < previous.sessions.length) {
		const live = new Set(["", ...next.sessions.map((entry) => entry.id)]);
		for (let i = visits.length - 1; i >= 0; i--)
			if (!live.has(visits[i])) {
				visits.splice(i, 1);
				if (i <= visitIndex) visitIndex--;
			}
		for (const id of drafts.keys()) if (!live.has(id)) drafts.delete(id);
		for (const id of timelines.keys()) if (!live.has(id)) timelines.delete(id);
	}
	if (next.ready) rememberVisit();
	by("desktop-version").textContent = next.version ? `版本 ${next.version}` : "";
	by("theme-open").setAttribute(
		"aria-label",
		next.version ? `本机工作台，版本 ${next.version}，应用设置` : "本机工作台，应用设置",
	);
	for (const id of [
		"workspace",
		"composer-add",
		"new-session",
		"model-picker-open",
		"write-mode-open",
		"assistant-home",
	])
		by(id).disabled = !next.ready;
	syncWriteControls(next);
	const modelName = next.modelSettings?.modelId;
	by("model").textContent = modelName || "选择模型";
	const effort = next.modelSettings?.available.length ? effortNames[next.modelSettings.effort] : "";
	const modelLabel = modelName ? `选择模型：${modelName}${effort ? `，推理强度：${effort}` : ""}` : "选择模型";
	by("model-picker-open").title = modelLabel;
	by("model-picker-open").setAttribute("aria-label", modelLabel);
	const icon = by("composer-model-icon");
	icon.replaceChildren(modelIcon(modelName));
	icon.hidden = !modelName;
	by("composer-effort").textContent = effort;
	by("composer-effort").hidden = !effort;
	by("effort-model-name").textContent = modelName ?? "";
	by("effort-model-icon").replaceChildren(modelIcon(modelName));
	if (!effortSaving) syncEffort();
	syncPickerControls();
	by("gateway-notice").hidden = !next.gatewayError;
	by("gateway-notice").textContent = next.gatewayError ?? "";
	renderSessions();
	by("assistant-home").setAttribute("aria-current", String(!session));
	const selected = next.sessions.find(({ id }) => id === session);
	workspacePanel.setSession(selected, next.ready);
	by("title").textContent = selected?.title ?? "Flower Desktop";
	by("title").title = selected ? `${selected.title} · ${selected.path}` : by("title").textContent;
	const workspaceLabel = selected?.workspace || "选择工作区";
	by("workspace-label").textContent = workspaceLabel;
	// 未选工作区时按钮文案已是“选择工作区”，只在已选中时补充切换提示
	by("workspace-hint").hidden = !selected;
	by("workspace").title = selected ? `切换工作区 · ${selected.path}` : workspaceLabel;
	by("workspace").setAttribute("aria-label", selected ? `切换工作区：${workspaceLabel}` : workspaceLabel);
	showDraftFiles(selected?.attachments, session);
	by("composer-workspace").querySelector("span").textContent = selected ? "切换工作区…" : "选择工作区…";
	if (old !== session) {
		const prompt = by("prompt");
		if (old === "" || next.sessions.some((item) => item.id === old)) drafts.set(old, prompt.value);
		if (old) recentSession = old;
		const created = session && wasReady && !previous.sessions.some(({ id }) => id === session);
		if (created) timelineFor(session).loaded = true;
		// 首页草稿只随刚选定的新工作区转移。打开已有会话时读取该会话的草稿。
		if (old === "" && created) {
			drafts.set(session, prompt.value);
			drafts.delete("");
		}
		thread.reset();
		prompt.value = drafts.get(session) ?? "";
		renderRequests();
		if (!moving && !by("model-dialog").open) prompt.focus();
	}
	syncSend();
	if (old !== session || runtimeExited || next.modelRevision !== previous?.modelRevision || (!wasReady && next.ready)) {
		void refreshContextUsage(true);
	}
	if (old !== session || runtimeExited || (!wasReady && next.ready)) {
		pruneTimelines();
		void reloadHistory(session);
	}
}

function syncWriteControls(next) {
	const mode = modeOptions.find((button) => button.dataset.writeMode === next.writeMode);
	if (mode) {
		const label = mode.querySelector(".mode-label").textContent;
		by("write-mode-open")
			.querySelector("use")
			.setAttribute("href", mode.querySelector(".mode-glyph use").getAttribute("href"));
		by("write-mode-name").textContent = label;
		by("write-mode-open").title = `工作区权限：${label}`;
		by("write-mode-open").setAttribute("aria-label", by("write-mode-open").title);
	}
	by("write-mode-scope").textContent = next.selected
		? "仅限本会话已授权的工作区。"
		: "选择工作区后，此权限将用于新会话。";
	by("write-mode-busy").hidden = !next.writeModeBusy;
	for (const button of modeOptions) {
		button.disabled = Boolean(next.writeModeBusy);
		button.setAttribute("aria-pressed", String(button === mode));
	}

	const pending = next.writeApproval;
	if (pending?.id === writeApproval?.id) return;
	writeApproval = pending;
	writePanel.hidden = !pending;
	by("write-workspace").textContent = pending?.workspace ?? "";
	by("write-input").textContent = pending?.input || "当前对话";
	by("write-files").replaceChildren(...(pending?.files ?? []).map((file) => flowerUI.element("li", "", file)));
	flowerUI.feedback(by("write-approval-error"), "");
	by("write-approval-live").textContent = pending ? "当前会话有待批准的文件生成。" : "";
}

for (const button of modeOptions)
	button.addEventListener(
		"click",
		action(async () => {
			await ui.setWriteMode(session, button.dataset.writeMode);
			modePicker.hidePopover();
			by("write-mode-open").focus();
		}),
	);

async function respondToWrite(action) {
	const pending = writeApproval;
	if (!pending) return;
	try {
		await action(pending);
	} catch {
		if (writeApproval?.id === pending.id)
			flowerUI.feedback(by("write-approval-error"), "处理未完成，请重试或拒绝本次生成。", "error");
	}
}

const denyWrite = () => void respondToWrite(({ id }) => ui.decideWrite(id, false));
by("write-deny").addEventListener("click", denyWrite);
by("write-allow").addEventListener("click", () => void respondToWrite(({ id }) => ui.decideWrite(id, true)));
by("write-cancel-task").addEventListener(
	"click",
	() => void respondToWrite(({ session, requestId, runId }) => ui.cancel(session, requestId, runId)),
);
function syncSend() {
	const send = by("send");
	const label = !session
		? "提交任务（先选择工作区）"
		: model
			? "提交任务"
			: state?.modelSettings && !state.modelSettings.keyUnavailable
				? "提交任务（先选择模型）"
				: "提交任务（先配置模型）";
	if (send.title !== label) {
		send.setAttribute("aria-label", label);
		send.title = label;
	}
	send.disabled = !state?.ready || effortSaving || !by("prompt").value.trim();
}

function receive(event) {
	if (!event?.sessionId) return;
	const { sessionId, requestId, type } = event;
	if (type === "terminal" && !timelines.has(sessionId)) return;
	const timeline = timelineFor(sessionId);
	const { requests } = timeline;
	if (type !== "terminal") timeline.active.add(requestId);
	const record = requests.get(event.requestId) ?? {
		input: "",
		requestId: event.requestId,
		text: "",
		status: "queued",
		tools: [],
	};
	requests.set(event.requestId, record);
	record.eventRevision = ++eventRevision;
	if (event.runId) record.runId = event.runId;
	switch (event.type) {
		case "queued":
			record.status = "queued";
			break;
		case "started":
			record.status = "running";
			break;
		case "cancelling":
			record.status = "cancelling";
			break;
		case "text_delta":
			record.text += event.delta;
			break;
		case "tool_started":
			record.tools.push({ id: event.toolCallId, label: toolLabels[event.toolName] ?? "调用工具", state: "running" });
			break;
		case "tool_result": {
			const step = record.tools.find(({ id }) => id === event.toolCallId);
			if (step) step.state = event.isError ? "error" : "done";
			break;
		}
		case "terminal":
			timeline.active.delete(requestId);
			record.status = event.status;
			record.failure = event.failure?.message;
			for (const step of record.tools) {
				if (step.state === "running") step.state = "stopped";
			}
			// 后台终态已经落盘。下次打开时读取，避免在后台为整段历史再分配内存。
			invalidateHistory(timeline);
			pruneTimelines();
			if (sessionId === session) void reloadHistory(sessionId);
			if (sessionId === session) void refreshContextUsage();
			break;
	}
	if (sessionId === session) {
		// 同一绘制帧内的分片共用一次排版，完整原文仍逐片追加。
		if (type === "text_delta") {
			if (!streamFrame) streamFrame = requestAnimationFrame(() => renderRequests());
		} else {
			renderRequests();
		}
	}
}

function modelIcon(id = "") {
	const icon = flowerUI.element("img", "model-mark");
	const match = modelsWithIcons.find(([pattern]) => pattern.test(id.toLowerCase()));
	icon.dataset.family = match?.[1] ?? "other";
	icon.src = `./ui/models/${match?.[2] ?? "unknown.svg"}`;
	icon.alt = "";
	icon.draggable = false;
	return icon;
}

function effortOptions() {
	return ["default", ...(state?.modelSettings?.available ?? [])];
}

function paintEffort(hop = false) {
	const range = by("effort-range");
	const options = effortOptions();
	const value = effortNames[options[Number(range.value)]] ?? effortNames.default;
	const position = Number(range.value) / Math.max(1, Number(range.max));
	range.setAttribute("aria-valuetext", value);
	by("effort-track").style.setProperty("--effort", String(position));
	by("effort-track").toggleAttribute("data-petals", position > 0 && options[Number(range.value)] !== "off");
	if (hop && position !== lastEffortPosition && !reduceEffortMotion.matches) {
		const avatar = by("effort-avatar");
		const direction = Math.sign(position - lastEffortPosition);
		for (const animation of avatar.getAnimations()) animation.cancel();
		avatar.animate(
			[
				{ transform: "translateY(0) rotate(0deg)", offset: 0 },
				{ transform: `translateY(-8px) rotate(${direction * 10}deg)`, offset: 0.38 },
				{ transform: `translateY(1px) rotate(${direction * -3}deg)`, offset: 0.75 },
				{ transform: "translateY(0) rotate(0deg)", offset: 1 },
			],
			{ duration: 240, easing: "ease-out" },
		);
	}
	lastEffortPosition = position;
	by("effort-label").textContent = value;
	by("effort-reset").disabled = range.disabled || range.value === "0";
}

function syncEffort() {
	const range = by("effort-range");
	const options = effortOptions();
	const max = String(options.length - 1);
	if (range.max !== max) {
		range.max = max;
		by("effort-stops").replaceChildren(...options.map(() => flowerUI.element("span")));
	}
	range.value = String(Math.max(0, options.indexOf(state?.modelSettings?.effort)));
	paintEffort();
}

function showPickerPage(showEffort, focus = false) {
	const available = effortOptions().length > 1;
	const effort = available && showEffort;
	picker.dataset.page = effort ? "effort" : "models";
	by("effort-panel").hidden = !effort;
	by("model-list-panel").hidden = effort;
	by("model-back-effort").hidden = !available;
	const title = by("model-picker-title");
	title.textContent = effort ? "推理强度" : "选择模型";
	title.classList.toggle("sr-only", effort);
	if (focus) by(effort ? "effort-range" : available ? "model-back-effort" : "settings").focus();
}

async function saveEffort(effort) {
	if (!effort || state?.modelBusy || choosingModel) return;
	nextEffort = effort;
	if (effortSaving) return;
	effortSaving = true;
	syncSend();
	syncPickerControls();
	try {
		let revision = state.modelRevision;
		while (nextEffort) {
			const selected = nextEffort;
			nextEffort = undefined;
			revision = await ui.setModelEffort(selected, revision);
		}
	} catch (error) {
		nextEffort = undefined;
		flowerUI.feedback(by("model-choice-feedback"), modelError(error, "无法保存推理强度。"), "error");
	} finally {
		effortSaving = false;
		syncSend();
		syncPickerControls();
		syncEffort();
	}
}

by("effort-range").addEventListener("input", () => paintEffort(true));
by("effort-range").addEventListener("change", (event) => void saveEffort(effortOptions()[Number(event.target.value)]));
by("effort-reset").addEventListener("click", () => {
	by("effort-range").value = "0";
	paintEffort(true);
	void saveEffort("default");
	by("effort-range").focus();
});
by("effort-models").addEventListener("click", () => showPickerPage(false, true));
by("model-back-effort").addEventListener("click", () => showPickerPage(true, true));

function syncPickerControls() {
	const busy = Boolean(state?.modelBusy || choosingModel || effortSaving);
	const disabled = busy || state?.modelSettings?.keyUnavailable;
	by("model-busy").hidden = !state?.modelBusy;
	for (const item of by("model-options").querySelectorAll("button")) {
		item.disabled = disabled || item.getAttribute("aria-current") === "true";
	}
	by("model-manual").disabled = disabled;
	by("model-manual-save").disabled = disabled;
	by("settings").disabled = busy;
	by("picker-service").disabled = busy;
	if (busy) pickerService.close();
	by("effort-range").disabled = Boolean(state?.modelBusy || choosingModel || state?.modelSettings?.keyUnavailable);
	by("effort-reset").disabled = by("effort-range").disabled || by("effort-range").value === "0";
	for (const id of ["save-settings", "settings-service", "settings-add-model", "settings-edit-service"]) {
		by(id).disabled = busy || settingsSaving;
	}
	if (by("settings-service").disabled) settingsService.close();
	for (const button of by("settings-model-cards").querySelectorAll("button")) {
		button.disabled = busy || settingsSaving;
	}
	for (const control of by("model-editor").querySelectorAll('[name="model-policy"], .model-level, #context-window')) {
		control.disabled = busy || settingsSaving;
	}
}

function showModelChoices(ids, current) {
	const rows = [...new Set(current ? [current, ...ids] : ids)].map((id) => {
		const row = flowerUI.element("li");
		const button = flowerUI.button(id, () => void chooseModel(id), "model-option");
		button.prepend(modelIcon(id));
		button.title = id;
		button.setAttribute("aria-label", id);
		if (id === current) button.setAttribute("aria-current", "true");
		row.append(button);
		return row;
	});
	by("model-options").replaceChildren(...rows);
	syncPickerControls();
}

function serviceOptions(control, id, allowNew) {
	const options = (state?.modelServices ?? []).map(({ id, name, baseUrl }) => ({
		value: id,
		label: name,
		title: baseUrl,
	}));
	if (allowNew) options.push({ value: "", label: "添加服务" });
	control.render(options, id ?? "");
	if (!allowNew) by("picker-service-select").hidden = options.length < 2;
}

async function discoverModels() {
	const request = ++pickerRequest;
	pickerRevision = state?.modelRevision;
	const configured = state?.modelSettings;
	const status = by("model-discovery");
	by("model-manual-form").hidden = !configured;
	by("model-manual").value = "";
	flowerUI.feedback(by("model-choice-feedback"), "");
	const saved = configured?.models.map(({ id }) => id) ?? [];
	serviceOptions(pickerService, configured?.id, false);
	showModelChoices(saved, configured?.modelId);
	flowerUI.feedback(status, configured ? "正在读取服务模型…" : "请先配置模型服务。");
	if (!configured) return;
	try {
		const ids = await ui.listModels(configured.id, pickerRevision);
		if (request !== pickerRequest || !picker.matches(":popover-open")) return;
		showModelChoices([...saved, ...ids], configured.modelId);
		flowerUI.feedback(status, ids.length ? "" : "服务没有返回模型，可手动输入。");
	} catch (error) {
		if (request !== pickerRequest || !picker.matches(":popover-open")) return;
		const message = error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") ?? "暂时无法读取模型。";
		flowerUI.feedback(status, message, "error");
	}
}

async function chooseModel(id) {
	if (choosingModel || effortSaving || state?.modelBusy) return;
	choosingModel = true;
	syncPickerControls();
	try {
		await ui.chooseModel(id, pickerRevision);
		picker.hidePopover();
		by("prompt").focus({ preventScroll: true });
	} catch (error) {
		const message = error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") ?? "模型切换未完成。";
		flowerUI.feedback(by("model-choice-feedback"), message, "error");
	} finally {
		choosingModel = false;
		syncPickerControls();
	}
}

picker.addEventListener("beforetoggle", (event) => {
	if (event.newState === "open") showPickerPage(true);
});
picker.addEventListener("toggle", (event) => {
	if (event.newState === "open") void discoverModels();
	else pickerRequest++;
});
const pickerService = window.flowerSelect(by("picker-service-select"), "picker-service", "模型服务", async (id) => {
	if (choosingModel || effortSaving || state?.modelBusy) return;
	choosingModel = true;
	syncPickerControls();
	try {
		await ui.chooseModelService(id, pickerRevision);
		showPickerPage(false);
		void discoverModels();
	} catch (error) {
		serviceOptions(pickerService, state?.modelSettings?.id, false);
		flowerUI.feedback(by("model-choice-feedback"), modelError(error, "无法切换模型服务。"), "error");
	} finally {
		choosingModel = false;
		syncPickerControls();
	}
});
by("model-manual-form").addEventListener("submit", (event) => {
	event.preventDefault();
	void chooseModel(by("model-manual").value);
});

function modelError(error, fallback) {
	return error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") ?? fallback;
}

const modelPolicies = [...by("model-capability").querySelectorAll("input")];
const modelLevels = new Map();
for (const [level, description] of Object.entries(effortNames)) {
	if (level === "default") continue;
	const chip = flowerUI.button(
		description,
		() => {
			chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
		},
		"model-level",
	);
	chip.prepend(flowerUI.icon("check"));
	chip.setAttribute("aria-pressed", "false");
	modelLevels.set(level, chip);
	by("model-levels").append(chip);
}

function editingSavedAddress() {
	return editingService?.baseUrl === by("base-url").value.trim().replace(/\/+$/, "");
}

function selectedModelPolicy() {
	return modelPolicies.find(({ checked }) => checked).value;
}

function setManualLevels(levels) {
	for (const [level, chip] of modelLevels) chip.setAttribute("aria-pressed", String(levels.includes(level)));
}

function renderModelPolicy() {
	const policy = selectedModelPolicy();
	by("model-recommendation").hidden = policy !== "auto";
	by("model-levels").hidden = policy !== "standard";
	by("model-default-effort").hidden = policy !== "none";
}

async function showRecommendation() {
	const request = ++capabilityRequest;
	const id = by("model-id").value.trim();
	const source = by("model-recommendation-source");
	const levels = by("model-recommendation-levels");
	source.textContent = "";
	source.hidden = true;
	levels.textContent = "";
	if (!id) {
		levels.textContent = "输入或选取模型后识别。";
		return;
	}
	const sources = { builtin: "pi 本地目录", service: "服务模型列表" };
	try {
		const preset = await ui.modelEffortPreset(editingSavedAddress() ? editingService.id : "", id);
		if (request !== capabilityRequest) return;
		recommendedLevels = preset.levels;
		source.textContent = sources[preset.source] ?? "";
		source.hidden = !source.textContent;
		levels.textContent = preset.levels.length
			? preset.levels.map((level) => effortNames[level]).join(" · ")
			: "采用服务默认档位。";
	} catch {
		if (request !== capabilityRequest) return;
		levels.textContent = "暂时无法读取推荐。";
	}
}

function showCapability() {
	const editedRecord =
		editingSavedAddress() && editingService.models.find(({ id }) => id === by("model-id").value.trim());
	manualLevelsInitialized = Boolean(editedRecord?.levels);
	by("context-window").value = editedRecord?.contextWindow ?? "";
	for (const policy of modelPolicies) policy.checked = policy.value === (editedRecord?.mode ?? "auto");
	recommendedLevels = [];
	setManualLevels(editedRecord?.levels ?? []);
	renderModelPolicy();
	void showRecommendation();
}

function renderSettingsModels(ids) {
	by("settings-models").replaceChildren(
		...[...new Set(ids)].map((id) => {
			const item = flowerUI.element("li");
			const button = flowerUI.button(
				id,
				() => {
					by("model-id").value = id;
					showCapability();
					by("model-id").focus();
				},
				"model-option",
			);
			button.prepend(modelIcon(id));
			button.setAttribute("aria-label", id);
			button.title = id;
			item.append(button);
			return item;
		}),
	);
}

function syncSettingsDiscovery() {
	by("settings-discover").disabled =
		!editingService ||
		!editingSavedAddress() ||
		Boolean(by("api-key").value || by("clear-key").checked || editingService.keyUnavailable);
}

function fillModelSettings(saved, modelId = saved?.modelId ?? "") {
	editingService = saved;
	settingsDiscovery++;
	by("service-name").value = saved?.name ?? "";
	by("base-url").value = saved?.baseUrl ?? "";
	by("model-id").value = modelId;
	by("api-key").value = "";
	by("clear-key").checked = false;
	by("clear-key-row").hidden = !(saved?.hasKey || saved?.keyUnavailable);
	const hint = saved?.keyUnavailable
		? "请重新输入或清除已保存的 Key。"
		: saved?.hasKey
			? "地址相同时留空保留已保存的 Key。"
			: "无 Key 的服务可留空。";
	by("key-hint").textContent = hint;
	flowerUI.feedback(by("settings-feedback"), "");
	flowerUI.feedback(by("settings-discovery"), saved ? "" : "保存服务后可读取模型列表。");
	renderSettingsModels(by("model-id").readOnly ? [] : (saved?.models.map(({ id }) => id) ?? []));
	showCapability();
	syncSettingsDiscovery();
}

function renderModelOverview(snapshot = state) {
	by("model-editor-identity").hidden = true;
	const saved = snapshot?.modelSettings;
	by("model-title").textContent = "模型设置";
	delete by("model-dialog").dataset.editor;
	by("settings-appearance").hidden = false;
	by("model-overview").hidden = false;
	by("model-form").hidden = true;
	by("api-key").value = "";
	by("model-id").readOnly = false;
	settingsDiscovery++;
	capabilityRequest++;
	serviceOptions(settingsService, saved?.id, true);
	const models = saved?.models ?? [];
	by("settings-provider-meta").textContent = `${models.length} 个`;
	by("settings-model-empty").hidden = Boolean(models.length);
	flowerUI.feedback(by("settings-overview-feedback"), "");
	by("settings-model-cards").replaceChildren(
		...models.map(({ id }) => {
			const current = id === saved.modelId;
			const card = flowerUI.element("li", "catalog-model-card");
			card.dataset.current = String(current);
			const select = flowerUI.button(
				"",
				() => {
					if (!current) void changeOverview(() => ui.chooseModel(id, snapshot.modelRevision), id);
				},
				"catalog-model-select",
			);
			select.dataset.model = id;
			select.setAttribute("aria-label", id);
			select.setAttribute("aria-pressed", String(current));
			const label = flowerUI.element("span", "catalog-model-name", id);
			const selected = flowerUI.element("span", "catalog-model-selected");
			selected.setAttribute("aria-hidden", "true");
			select.append(modelIcon(id), label, selected);
			const edit = flowerUI.button("", () => showSettingsEditor("model", saved, id), "quiet catalog-model-edit");
			edit.dataset.editModel = id;
			edit.setAttribute("aria-label", `编辑模型：${id}`);
			edit.append(flowerUI.icon("pencil"));
			card.append(select, edit);
			return card;
		}),
	);
	syncPickerControls();
}

async function changeOverview(change, focusModel) {
	if (settingsSaving || state?.modelBusy || effortSaving || choosingModel) return;
	settingsSaving = true;
	syncPickerControls();
	try {
		await change();
		renderModelOverview(await ui.state());
	} catch (error) {
		renderModelOverview();
		flowerUI.feedback(by("settings-overview-feedback"), modelError(error, "无法更新模型设置。"), "error");
	} finally {
		settingsSaving = false;
		syncPickerControls();
		const row = [...by("settings-model-cards").querySelectorAll(".catalog-model-select")].find(
			(button) => button.dataset.model === focusModel,
		);
		(row ?? by("settings-service")).focus();
	}
}

function showSettingsEditor(kind, saved, id) {
	editorFocus = { id: document.activeElement?.id, model: id };
	settingsEditor = kind;
	editingRevision = state?.modelRevision;
	const names = { setup: "添加服务", service: "编辑服务", model: id ? "编辑模型" : "添加模型" };
	by("model-title").textContent = names[kind];
	by("model-dialog").dataset.editor = kind;
	by("settings-appearance").hidden = kind === "model";
	by("model-overview").hidden = true;
	by("model-form").hidden = false;
	by("service-editor").hidden = kind === "model";
	by("model-editor").hidden = kind === "service";
	by("base-url").required = kind !== "model";
	by("model-id").required = kind === "model" && !id;
	by("model-id").readOnly = kind === "model" && Boolean(id);
	const identity = by("model-editor-identity");
	identity.hidden = !id;
	identity.replaceChildren(...(id ? [modelIcon(id), flowerUI.element("strong", "", id)] : []));
	by("model-entry").hidden = Boolean(id);
	fillModelSettings(saved, kind === "model" ? (id ?? "") : saved?.modelId);
	syncPickerControls();
	by(id ? "model-title" : kind === "model" ? "model-id" : "service-name").focus();
}

function returnToModelOverview(snapshot = state) {
	renderModelOverview(snapshot);
	const edit = [...by("settings-model-cards").querySelectorAll("[data-edit-model]")].find(
		(button) => button.dataset.editModel === editorFocus?.model,
	);
	(edit ?? by(editorFocus?.id) ?? by("model-title")).focus({ preventScroll: true });
}

function openModelSettings(trigger) {
	const dialog = by("model-dialog");
	if (dialog.open || !state?.ready) return;
	settingsFocus = trigger;
	if (state.modelSettings) renderModelOverview();
	else showSettingsEditor("setup");
	dialog.showModal();
	by(state.modelSettings ? "model-title" : "service-name").focus();
}

by("settings").addEventListener("click", () => {
	picker.hidePopover();
	openModelSettings(by("model-picker-open"));
});
by("theme-open").addEventListener("click", () => openModelSettings(by("theme-open")));
const settingsService = window.flowerSelect(by("settings-service-select"), "settings-service", "当前服务商", (id) => {
	if (id) void changeOverview(() => ui.chooseModelService(id, state.modelRevision));
	else showSettingsEditor("setup");
});
by("settings-edit-service").addEventListener("click", () => showSettingsEditor("service", state?.modelSettings));
by("settings-add-model").addEventListener("click", () => showSettingsEditor("model", state?.modelSettings));
by("model-id").addEventListener("input", showCapability);
by("model-capability").addEventListener("change", () => {
	if (selectedModelPolicy() === "standard" && !manualLevelsInitialized) {
		manualLevelsInitialized = true;
		setManualLevels(recommendedLevels);
	}
	renderModelPolicy();
});
for (const id of ["base-url", "api-key", "clear-key"]) by(id).addEventListener("input", syncSettingsDiscovery);
by("base-url").addEventListener("input", () => {
	settingsDiscovery++;
	renderSettingsModels(editingSavedAddress() ? editingService.models.map(({ id }) => id) : []);
	flowerUI.feedback(by("settings-discovery"), editingSavedAddress() ? "" : "保存新地址后可读取模型列表。");
	showCapability();
});
by("settings-discover").addEventListener("click", async () => {
	const service = editingService;
	const revision = ++settingsDiscovery;
	if (by("settings-discover").disabled || !service) return;
	flowerUI.feedback(by("settings-discovery"), "正在读取服务模型…");
	try {
		const ids = await ui.listModels(service.id, editingRevision);
		if (revision !== settingsDiscovery) return;
		renderSettingsModels([...service.models.map(({ id }) => id), ...ids]);
		void showRecommendation();
		flowerUI.feedback(by("settings-discovery"), ids.length ? "" : "服务没有返回模型，可手动输入。");
	} catch (error) {
		if (revision !== settingsDiscovery) return;
		flowerUI.feedback(by("settings-discovery"), modelError(error, "暂时无法读取模型。"), "error");
	}
});
by("settings-close-dialog").addEventListener("click", () => by("model-dialog").close());
by("close-settings").addEventListener("click", () => {
	if (!state?.modelSettings) by("model-dialog").close();
	else returnToModelOverview();
});
by("model-dialog").addEventListener("cancel", (event) => {
	if (!state?.modelSettings || by("model-form").hidden) return;
	event.preventDefault();
	if (!settingsSaving) returnToModelOverview();
});
by("model-dialog").addEventListener("close", () => {
	settingsDiscovery++;
	capabilityRequest++;
	by("api-key").value = "";
	if (document.activeElement === document.body || by("model-dialog").contains(document.activeElement)) {
		settingsFocus?.focus({ preventScroll: true });
	}
});
by("model-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const save = by("save-settings");
	if (save.disabled) return;
	settingsSaving = true;
	syncPickerControls();
	try {
		await ui.saveModel({
			serviceId: editingService?.id ?? "",
			revision: editingRevision,
			name: by("service-name").value.trim() || undefined,
			baseUrl: by("base-url").value,
			modelId: by("model-id").value,
			keepSelectedModel: settingsEditor === "model" && Boolean(editorFocus?.model),
			apiKey: by("api-key").value,
			clearKey: by("clear-key").checked,
			capability:
				settingsEditor === "service"
					? undefined
					: {
							mode: selectedModelPolicy(),
							contextWindow: by("context-window").value,
							levels: [...modelLevels]
								.filter(([, chip]) => chip.getAttribute("aria-pressed") === "true")
								.map(([level]) => level),
						},
		});
		if (settingsEditor === "setup" && editorFocus?.id !== "settings-service") {
			by("model-dialog").close();
			by("prompt").focus({ preventScroll: true });
		} else {
			settingsSaving = false;
			returnToModelOverview(await ui.state());
		}
	} catch (error) {
		const message = error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") ?? "无法保存模型设置。";
		flowerUI.feedback(by("settings-feedback"), message, "error");
	} finally {
		settingsSaving = false;
		syncPickerControls();
	}
});
by("workspace").addEventListener(
	"click",
	action(() => ui.chooseWorkspace()),
);
const addMenu = by("composer-add-menu");
const addTrigger = by("composer-add");
addMenu.addEventListener("keydown", menuNavigation);
addTrigger.addEventListener("keydown", (event) => {
	if (event.key === "ArrowDown") {
		event.preventDefault();
		addMenu.showPopover({ source: addTrigger });
	}
});
addMenu.addEventListener("click", (event) => {
	const item = event.target.closest("button");
	if (!item) return;
	addMenu.hidePopover();
	addTrigger.focus({ preventScroll: true });
	void action(async () => {
		if (item.id === "composer-workspace") return ui.chooseWorkspace();
		const id = session || (await ui.chooseWorkspace());
		if (!id) return;
		if (item.id === "file") return ui.chooseFile(id);
		if (item.id === "paste-clipboard-image") return ui.pasteClipboardImage(id);
		if (session !== id) {
			const next = await ui.state();
			if (next.selected !== id) return;
			update(next);
		}
		workspacePanel.browseFiles(id, addTrigger);
	})();
});
let creatingSession = false;
by("new-session").addEventListener(
	"click",
	action(async () => {
		// 仅复用真正空白的会话，避免重复点击堆出空会话，同时保留有内容的草稿。
		if (!session || creatingSession || emptySession()) return by("prompt").focus();
		creatingSession = true;
		try {
			await ui.newSession(session);
		} finally {
			creatingSession = false;
		}
	}),
);

by("prompt").addEventListener("input", syncSend);
by("send").addEventListener(
	"click",
	action(async () => {
		const selected = session;
		const prompt = by("prompt");
		const text = prompt.value;
		if (!text.trim()) return;
		if (!selected) {
			await ui.chooseWorkspace();
			return;
		}
		if (!model) {
			if (state?.modelSettings && !state.modelSettings.keyUnavailable)
				picker.showPopover({ source: by("model-picker-open") });
			else openModelSettings();
			return;
		}
		prompt.value = "";
		prompt.focus({ preventScroll: true });
		syncSend();
		const timeline = timelineFor(selected);
		timeline.submitting++;
		try {
			const record = await ui.submit(selected, text);
			const { requests } = timeline;
			const current = requests.get(record.requestId);
			requests.set(record.requestId, {
				...record,
				...current,
				input: record.input,
				file: record.file,
				attachments: record.attachments,
				tools: current?.tools ?? [],
			});
			if (session === selected) renderRequests(true);
		} catch (error) {
			if (session === selected && !prompt.value) prompt.value = text;
			if (session === selected) {
				syncSend();
				throw error;
			}
			if (!drafts.get(selected)) drafts.set(selected, text);
		} finally {
			timeline.submitting--;
			pruneTimelines();
		}
	}),
);
renderRequests();
syncSend();
const unsubscribe = ui.subscribe(({ kind, state, event }) => {
	if (kind === "state") update(state);
	else if (kind === "event") receive(event);
});
window.addEventListener("unload", unsubscribe, { once: true });
