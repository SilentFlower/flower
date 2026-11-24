const ui = window.flower;
const { agentUI, flowerUI } = window;
const by = (id) => document.getElementById(id);
const toast = window.flowerToast.mount(by("toasts"));
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
// 侧栏当前列出的工作区或会话数，决定「全部折叠」是否显示。
let listedCount = 0;
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
	off: "关闭思考",
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
	openHit,
);
// 正文搜索：两个字起由 Main 查找会话正文，结果按查询序号丢弃过期响应。
let bodyHits = new Map();
let bodyQuery = "";
let bodyTicket = 0;
let bodyTimer;
// 点击命中片段后待跳转的轮次，会话历史渲染后执行。
let pendingReveal;
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
	showMenu(sidebarOptions, trigger);
}
/** 在触发按钮旁打开菜单，空间不足时翻到上方，并聚焦第一项。@param {HTMLElement} menu 菜单 @param {HTMLElement} trigger 触发按钮 @returns {void} */
function showMenu(menu, trigger) {
	menu.showPopover();
	const rect = trigger.getBoundingClientRect();
	menu.style.left = `${Math.max(6, Math.min(innerWidth - menu.offsetWidth - 6, rect.right - menu.offsetWidth))}px`;
	menu.style.top = `${rect.bottom + menu.offsetHeight < innerHeight - 6 ? rect.bottom + 3 : Math.max(6, rect.top - menu.offsetHeight - 3)}px`;
	menu.querySelector("button:not(:disabled)")?.focus();
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
const queueOptions = by("queue-options");
queueOptions.addEventListener("keydown", menuNavigation);
/** 排队消息的更多操作。@param {string} item 排队消息 ID @param {HTMLElement} trigger 触发按钮 @param {number} index 位置 @param {number} count 总数 @returns {void} */
function openQueueMenu(item, trigger, index, count) {
	const entries = [
		["up", "上移", index > 0, () => updateQueue.move(item, -1)],
		["down", "下移", index < count - 1, () => updateQueue.move(item, 1)],
		["side", "侧边追问", true, () => void sideChat.fromQueue(item, trigger)],
	];
	queueOptions.replaceChildren(
		...entries.map(([operation, title, enabled, run]) => {
			const control = flowerUI.button(
				title,
				() => {
					queueOptions.hidePopover();
					trigger.focus();
					run();
				},
				"sidebar-menu-item",
			);
			control.setAttribute("role", "menuitem");
			control.dataset.operation = operation;
			control.disabled = !enabled;
			return control;
		}),
	);
	showMenu(queueOptions, trigger);
}
const updateQueue = agentUI.queueBar(by("queue"), {
	resume: () => action(() => ui.resumeQueue(session))(),
	steer: (item) => action(() => ui.steerQueueItem(session, item))(),
	remove: (item) => action(() => ui.removeQueueItem(session, item))(),
	reorder: (ids) => action(() => ui.reorderQueue(session, ids))(),
	/** 开始编辑时返回是否成功暂缓；不传 ID 表示结束编辑。 */
	async hold(item) {
		try {
			await ui.holdQueueItem(session, item);
			return true;
		} catch (error) {
			if (item) toast(modelError(error, "这条排队消息已发送或已删除。"), { tone: "error" });
			return false;
		}
	},
	async edit(item, input, keep) {
		try {
			await ui.editQueueItem(session, item, input, keep);
			return true;
		} catch (error) {
			toast(modelError(error, "无法保存修改。"), { tone: "error" });
			return false;
		}
	},
	menu: openQueueMenu,
});
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
// 回复中的工作区图片按会话缓存，流式更新重建节点时同步填回，避免反复读取和闪烁。
const replyImages = new Map();
function hydrateReplyImages(root) {
	const owner = session;
	for (const image of root.querySelectorAll("img[data-workspace-image]:not([src])")) {
		const path = image.dataset.workspaceImage;
		const key = JSON.stringify([owner, path]);
		let entry = replyImages.get(key);
		if (!entry) {
			entry = { owner, url: "", blob: undefined };
			entry.ready = ui
				.previewWorkspaceFile(owner, path)
				.then((result) => {
					if (result?.kind !== "image") return;
					entry.blob = new Blob([result.bytes], { type: result.mime });
					entry.url = URL.createObjectURL(entry.blob);
				})
				.catch(() => {});
			replyImages.set(key, entry);
		}
		const show = () => {
			if (!image.isConnected || image.src) return;
			if (entry.url) image.src = entry.url;
			else image.replaceWith(document.createTextNode(image.dataset.markdownRaw ?? path));
		};
		if (entry.url) show();
		else void entry.ready.then(show);
	}
}
// 回复中的路径按会话缓存宿主的核对结果。工具执行后可能新建文件，届时丢弃「不存在」「多个同名」与仍在核对中的结论。
const replyPaths = new Map();
const replyPathKey = (owner, path) => JSON.stringify([owner, path]);
function checkReplyPath(path) {
	return replyPaths.get(replyPathKey(session, path))?.result ?? { state: "pending", path };
}
function checkReplyPaths(root, refresh) {
	const owner = session;
	const waiting = new Set();
	const asking = [];
	for (const node of root.querySelectorAll("[data-path-pending]")) {
		const path = node.dataset.pathPending;
		let entry = replyPaths.get(replyPathKey(owner, path));
		if (!entry) {
			entry = { owner };
			replyPaths.set(replyPathKey(owner, path), entry);
			asking.push([path, entry]);
		}
		if (!entry.result) waiting.add(entry);
	}
	// 宿主每次最多核对 64 项，同一次渲染的路径合并请求。
	for (let start = 0; start < asking.length; start += 64) {
		const batch = asking.slice(start, start + 64);
		const ready = ui
			.resolveReplyPaths(
				owner,
				batch.map(([path]) => path),
			)
			.then(
				(results) => {
					for (const [index, [path, entry]] of batch.entries()) {
						const found = results[index] ?? {};
						entry.result = found.path
							? { state: "file", path: found.path }
							: found.candidates
								? { state: "choices", path, candidates: found.candidates }
								: { state: "missing" };
					}
				},
				() => {
					// 切换会话等原因读取失败时不留结论，下次渲染重新核对，也不触发重渲染以免反复请求。
					for (const [path, entry] of batch) {
						if (replyPaths.get(replyPathKey(owner, path)) === entry) replyPaths.delete(replyPathKey(owner, path));
					}
				},
			);
		for (const [, entry] of batch) entry.ready = ready;
	}
	if (!waiting.size) return;
	void Promise.all([...waiting].map((entry) => entry.ready)).then(() => {
		if (root.isConnected && owner === session && [...waiting].every((entry) => entry.result)) refresh();
	});
}
function forgetMissingPaths(owner) {
	for (const [key, entry] of replyPaths) {
		// 在途核对反映的是工具执行前的文件状态，一并移出缓存；迟到结果只落到旧条目上，重渲染时重新核对。
		if (entry.owner === owner && entry.result?.state !== "file") replyPaths.delete(key);
	}
}
function releaseReplyImages(owner) {
	for (const [key, entry] of replyImages) {
		if (entry.owner !== owner) continue;
		if (entry.url) URL.revokeObjectURL(entry.url);
		replyImages.delete(key);
	}
}

const thread = agentUI.thread(
	by("timeline"),
	by("thread-scroll"),
	{
		paths: {
			resolve: (text) => flowerMarkdown.workspacePath(state?.sessions.find((entry) => entry.id === session)?.path, text),
			check: checkReplyPath,
			open: (path, trigger) => workspacePanel.preview(path, trigger, checkReplyPath(path).candidates),
			menu(path, trigger) {
				// 多个同名文件没有单一的本机路径，右键同样列出候选。
				const { candidates } = checkReplyPath(path);
				if (candidates) return workspacePanel.preview(path, trigger, candidates);
				action(async () => {
					if ((await ui.showPathMenu(session, path, true)) === "preview") workspacePanel.preview(path, trigger);
				})();
			},
			hydrate(root, refresh) {
				hydrateReplyImages(root);
				checkReplyPaths(root, refresh);
			},
			openImage(image) {
				const entry = replyImages.get(JSON.stringify([session, image.dataset.workspaceImage]));
				if (entry?.blob) void window.flowerImages.open(image.alt, async () => entry.blob, image);
			},
		},
		cancel: (id, runId) => action(() => ui.cancel(session, id, runId))(),
		open: (id, path) => action(() => ui.openArtifact(session, id, path))(),
		previewAttachment: workspacePanel.previewAttachment,
		preview: (path, trigger) => workspacePanel.preview(path, trigger),
		openLink: (url) => action(() => ui.openReplyLink(url))(),
		copy: (id) =>
			action(async () => {
				await ui.copyReply(session, id);
				toast("已复制回复原文。");
			})(),
		copyInput: (id) =>
			action(async () => {
				const input = timelines.get(session)?.requests.get(id)?.input;
				if (!input) return;
				await ui.copyText(input);
				toast("已复制提问原文。");
			})(),
		retry: (id) =>
			action(async () => {
				const selected = session;
				const original = timelines.get(selected)?.requests.get(id);
				const record = await ui.retryRequest(selected, id);
				const timeline = timelines.get(selected);
				if (!timeline || record.queued) return;
				const current = timeline.requests.get(record.requestId);
				timeline.requests.set(record.requestId, {
					...record,
					...current,
					input: record.input ?? original?.input,
					attachments: record.attachments,
					steps: current?.steps ?? [],
				});
				if (session === selected) renderRequests(true);
			})(),
		edit: (id) =>
			action(async () => {
				const selected = session;
				const prompt = by("prompt");
				const draft = state?.sessions.find((entry) => entry.id === selected)?.attachments?.length;
				// 编辑会替换输入框与草稿附件，先确认不会丢掉用户尚未发送的内容。
				if (
					(prompt.value.trim() || draft) &&
					!(await confirmAction("用原请求替换当前草稿？", "输入框中未发送的文字和附件将被替换。", "替换"))
				)
					return;
				const { input } = await ui.restoreRequestDraft(selected, id);
				if (session !== selected) return;
				prompt.value = input;
				syncSend();
				prompt.focus();
				prompt.setSelectionRange(input.length, input.length);
			})(),
	},
	by("back-to-bottom"),
	by("thread-navigator"),
);

/**
 * 打开通用确认框。
 * @param {string} title 标题
 * @param {string} detail 说明
 * @param {string} apply 确认按钮文字
 * @returns {Promise<boolean>} 用户是否确认
 */
function confirmAction(title, detail, apply) {
	const dialog = by("confirm-dialog");
	by("confirm-title").textContent = title;
	by("confirm-detail").textContent = detail;
	by("confirm-apply").textContent = apply;
	const trigger = document.activeElement;
	dialog.returnValue = "";
	dialog.showModal();
	return new Promise((resolve) => {
		dialog.addEventListener(
			"close",
			() => {
				trigger?.focus?.();
				resolve(dialog.returnValue === "apply");
			},
			{ once: true },
		);
	});
}
const sideChat = window.createSideChat(ui, {
	panel: workspacePanel,
	toast,
	confirm: confirmAction,
	apply: applyEvent,
	errorText: modelError,
});
/** 把回复中的选中文字以引用块插入输入框。@param {string} text 选中文字 @returns {void} */
function quoteIntoPrompt(text) {
	const prompt = by("prompt");
	const result = agentUI.quoteInsertion(
		prompt.value,
		prompt.selectionStart,
		prompt.selectionEnd,
		text,
		prompt.maxLength,
	);
	if (!result) return toast("引用后超过 16000 字，未插入。", { tone: "error" });
	prompt.value = result.value;
	prompt.focus();
	prompt.setSelectionRange(result.caret, result.caret);
	prompt.dispatchEvent(new Event("input", { bubbles: true }));
}
const replySelection = agentUI.selectionActions(by("thread-scroll"), by("selection-actions"), {
	quote: quoteIntoPrompt,
	side: (text) => void sideChat.open(text),
});
// 回复选区上的右键改用专门菜单；路径、交付文件等已自行处理的右键与选区外的位置仍按原样。
let menuSelection;
by("timeline").addEventListener("contextmenu", (event) => {
	if (event.defaultPrevented) return;
	const picked = replySelection.current();
	if (!picked?.range.intersectsNode(event.target)) return;
	event.preventDefault();
	menuSelection = picked.text;
	void ui.showReplyMenu();
});
for (const node of document.querySelectorAll("[data-flower]")) node.append(flowerUI.mark(node.dataset.flower));
agentUI.bindComposer(by("prompt"), by("send"), () => {
	const inputs = [];
	for (const { input } of timelines.get(session)?.requests.values() ?? []) {
		// 连续重复的提问只保留一次，翻找时不原地停留。
		if (input && input !== inputs.at(-1)) inputs.push(input);
	}
	return inputs;
});

agentUI.mentionPicker(by("prompt"), by("mention-list"), {
	search: (query) => (session ? ui.workspaceFiles(session, query) : Promise.resolve(undefined)),
	pick: (path) => action(() => ui.referenceFile(session, path))(),
});

function action(fn) {
	return async () => {
		flowerUI.feedback(by("feedback"), "");
		try {
			await fn();
		} catch (error) {
			toast(modelError(error, "操作未完成"), { tone: "error" });
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
	const home = Boolean(!session || (timeline?.loaded && !timeline.requests.size));
	// 进入或离开空白页（如新会话发出首个请求）时同步上下文圆环。
	const homeChanged = workbench.dataset.home !== String(home);
	workbench.dataset.home = String(home);
	by("empty").hidden = !home;
	by("title").hidden = !session;
	by("home-suggestions").hidden = !home;
	by("thread-scroll").hidden = home;
	by("history-status").hidden = !session || timeline?.loaded || timeline?.failed || Boolean(timeline?.requests.size);
	thread.update(timeline?.requests.values() ?? [], follow);
	revealPending();
	syncCompact();
	if (homeChanged) void refreshContextUsage(true);
}

/** 同步详情卡的「压缩上下文」：最近一次压缩之后仍有已完成的轮次才可用，运行中停用，压缩中可取消。@returns {void} */
function syncCompact() {
	const button = by("context-compact");
	const compacting = Boolean(state?.compacting);
	const records = [...(timelines.get(session)?.requests.values() ?? [])];
	const marker = records.findIndex(({ compactedBefore, compactedAfter }) => compactedBefore || compactedAfter);
	const fresh = marker < 0 ? records : records.slice(records[marker].compactedAfter ? marker + 1 : marker);
	const available = fresh.some(({ status }) => status === "succeeded");
	const busy = !compacting && state?.sessions.find(({ id }) => id === session)?.busy;
	button.textContent = compacting ? "正在压缩… 取消" : "压缩上下文";
	button.toggleAttribute("data-compacting", compacting);
	button.disabled = !compacting && (busy || !available);
	button.title = compacting
		? "取消压缩，保留原上下文"
		: busy
			? "当前任务结束后可压缩"
			: available
				? "把迄今的对话归纳为摘要，后续以摘要续接"
				: "没有尚未压缩的对话";
}

function matchingSessions(query, hits) {
	const { status, workspace: workspaceId } = sessionFilter;
	return (state?.sessions ?? []).filter(
		(item) =>
			(!workspaceId || item.workspaceId === workspaceId) &&
			(!status || statusFilters[status](item)) &&
			(!query ||
				hits?.has(item.id) ||
				[item.title, item.workspace, item.path, item.awaitingWrite ? "待批准" : ""].some((value) =>
					value?.toLocaleLowerCase().includes(query),
				)),
	);
}

/** 输入停顿 200 毫秒后查找会话正文，单字只按名称匹配。@returns {void} */
function searchBodies() {
	const query = searchInput.value.trim();
	clearTimeout(bodyTimer);
	const ticket = ++bodyTicket;
	if ([...query].length < 2) {
		if (bodyHits.size) {
			bodyHits = new Map();
			renderSessions();
		}
		return;
	}
	bodyTimer = setTimeout(async () => {
		try {
			const results = await ui.searchSessions(query);
			if (ticket !== bodyTicket) return;
			bodyHits = new Map(results.map(({ id, snippets }) => [id, snippets]));
			bodyQuery = query;
			renderSessions();
		} catch {
			// 正文搜索失败时保留名称匹配结果。
		}
	}, 200);
}

/** 打开正文命中的那一轮：切换会话后等历史渲染再跳转。@param {string} id 会话 ID @param {string} requestId 请求 ID @returns {void} */
function openHit(id, requestId) {
	pendingReveal = { session: id, requestId, query: bodyQuery };
	if (id === session) revealPending();
	else action(() => ui.selectSession(id))();
}

function revealPending() {
	if (!pendingReveal || pendingReveal.session !== session) return;
	if (thread.reveal(pendingReveal.requestId, pendingReveal.query)) pendingReveal = undefined;
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
	// 只采用与当前输入一致的正文结果，避免显示上一次查询的片段。
	const hits = query && bodyQuery.toLocaleLowerCase() === query ? bodyHits : undefined;
	const items = matchingSessions(query, hits).slice().sort(pinnedFirst);
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
	updateSessions(items, { active: session, grouped: groupedByWorkspace, spaces, query: searchKey, snippets: hits });
	listedCount = count;
	syncSessionTools();
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
for (const node of [sidebarScroll, by("thread-scroll")]) flowerUI.softScroll(node);

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

/** 同步侧栏标题行的折叠与定位按钮。@returns {void} */
function syncSessionTools() {
	const collapse = by("sessions-collapse");
	collapse.hidden = !groupedByWorkspace || !listedCount;
	const expanded = updateSessions.anyExpanded();
	collapse.title = expanded ? "全部折叠" : "全部展开";
	collapse.setAttribute("aria-label", collapse.title);
	collapse.querySelector("use").setAttribute("href", expanded ? "#icon-collapse-all" : "#icon-expand-all");
	by("sessions-locate").disabled = !session;
}
by("sessions-collapse").addEventListener("click", () => {
	updateSessions.collapseAll(updateSessions.anyExpanded());
	syncSessionTools();
});
// 单独展开或折叠某个分组后，同步「全部折叠 / 全部展开」。
by("sessions").addEventListener("click", syncSessionTools);
by("sessions-locate").addEventListener("click", () => {
	if (!session) return;
	if (workbench.dataset.sidebar === "collapsed") collapseSidebar(false);
	// 搜索或筛选可能把当前会话隐藏，恢复完整列表后再定位。
	if (!updateSessions.reveal(session) && (searchInput.value || sessionFilter.status || sessionFilter.workspace)) {
		showSearch(false);
		updateSessions.reveal(session);
	}
	syncSessionTools();
});

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
		searchBodies();
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
searchInput.addEventListener("input", () => {
	renderSessions();
	searchBodies();
});
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
					? {
							...row,
							...current,
							input: row.input,
							file: row.file,
							attachments: row.attachments,
							artifacts: row.artifacts,
							compactedBefore: row.compactedBefore,
							compactedAfter: row.compactedAfter,
						}
					: row,
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
			toast("暂时无法读取此会话历史。", { tone: "error" });
		}
	} finally {
		if (timeline.reading === stamp) timeline.reading = undefined;
	}
}

/** 紧凑显示 token 数，如 87.5K、1M。@param {number} value token 数 @returns {string} 紧凑文本 */
function compactTokens(value) {
	if (value < 1000) return String(value);
	const [size, unit] = value < 1_000_000 ? [1000, "K"] : [1_000_000, "M"];
	return `${Number((value / size).toFixed(1))}${unit}`;
}

function showContextUsage(usage) {
	const meter = by("context-meter");
	const configured = state?.modelSettings?.context;
	// 空白新会话只有系统提示与工具声明的占用，发出首个请求后再显示。
	meter.hidden = !session || !model || !configured || workbench.dataset.home === "true";
	if (meter.hidden) return;
	const number = (value) => value.toLocaleString("zh-CN");
	const limit = usage?.limit ?? configured.limit;
	const ratio = usage ? Math.min(1, usage.tokens / limit) : 0;
	const percent = ratio * 100;
	const shortPercent = !usage ? "" : percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
	// 70% 起提醒，90% 时转红。运行时按输入预算自动压缩，实际阈值随窗口与输出上限约在 72%～89% 之间。
	meter.dataset.level = ratio >= 0.9 ? "danger" : ratio >= 0.7 ? "warn" : "normal";
	by("context-ring-value").style.strokeDasharray = `${percent} 100`;
	by("context-bar-value").style.width = `${percent}%`;
	by("context-percent").textContent = shortPercent;
	by("context-amount").textContent = usage
		? `${compactTokens(usage.tokens)} / ${compactTokens(limit)} · ${Number(percent.toFixed(1))}%`
		: `上限 ${compactTokens(limit)}`;
	// 窗口来源对使用者没有意义，只在未识别型号使用兜底窗口时提示上限可能不准。
	by("context-source").textContent = [
		usage ? "估算值" : "占用待估算",
		configured.source === "fallback" ? "未识别型号，上限为兜底值" : "",
	]
		.filter(Boolean)
		.join(" · ");
	by("context-usage").setAttribute(
		"aria-label",
		usage
			? `上下文已用约 ${shortPercent}，${number(usage.tokens)} / ${number(limit)} tokens`
			: `上下文上限 ${number(limit)} tokens`,
	);
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
	// 关闭思考时按钮只显示模型名，档位文字只在开启思考时出现。
	const effortText = next.modelSettings?.effort === "off" ? "" : effort;
	by("model-picker-open").title = modelLabel;
	by("model-picker-open").setAttribute("aria-label", modelLabel);
	const icon = by("composer-model-icon");
	icon.replaceChildren(modelIcon(modelName));
	icon.hidden = !modelName;
	by("composer-effort").textContent = effortText;
	by("composer-effort").hidden = !effortText;
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
	showInterrupted(next.interrupted ?? []);
	updateQueue(next.queue);
	sideChat.setState(session, next.sideChats, next.runtimeRevision);
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
		thread.reset(old, session);
		releaseReplyImages(old);
		prompt.value = drafts.get(session) ?? "";
		renderRequests();
		if (!moving && !by("model-dialog").open) prompt.focus();
	}
	syncSend();
	syncCompact();
	if (old !== session || runtimeExited || next.modelRevision !== previous?.modelRevision || (!wasReady && next.ready)) {
		void refreshContextUsage(true);
	}
	if (old !== session || runtimeExited || (!wasReady && next.ready)) {
		pruneTimelines();
		void reloadHistory(session);
	}
}

/** 侧栏顶部的中断横幅：列出上次被中断的会话，可全部继续或忽略。@param {{id: string, title: string}[]} items 中断的会话 @returns {void} */
function showInterrupted(items) {
	const banner = by("interrupted-banner");
	banner.hidden = !items.length;
	by("interrupted-title").textContent = `${items.length} 个任务上次被中断`;
	const key = JSON.stringify(items);
	if (banner.dataset.key === key) return;
	banner.dataset.key = key;
	by("interrupted-list").replaceChildren(
		...items.map(({ id, title }) => {
			const item = flowerUI.element("li");
			const open = flowerUI.button(title, () => action(() => ui.selectSession(id))(), "quiet interrupted-session");
			open.title = title;
			item.append(open);
			return item;
		}),
	);
}
by("interrupted-resume").addEventListener(
	"click",
	action(async () => {
		const ids = state?.interrupted?.map(({ id }) => id) ?? [];
		if (!ids.length) return;
		await ui.resumeInterrupted(ids);
		toast(`已继续 ${ids.length} 个任务。`);
	}),
);
by("interrupted-dismiss").addEventListener(
	"click",
	action(() => ui.dismissInterrupted()),
);

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
	const selected = state?.sessions.find(({ id }) => id === session);
	const label = !session
		? "提交任务（先选择工作区）"
		: model
			? selected?.busy || state?.queue?.items.length
				? "加入队列（当前任务结束后发送）"
				: "提交任务"
			: state?.modelSettings && !state.modelSettings.keyUnavailable
				? "提交任务（先选择模型）"
				: "提交任务（先配置模型）";
	if (send.title !== label) {
		send.setAttribute("aria-label", label);
		send.title = label;
	}
	send.disabled = !state?.ready || effortSaving || !by("prompt").value.trim();
}

/**
 * 按运行事件更新请求记录的状态、正文、插话与工具步骤。主会话与侧边追问共用。
 * @param {object} record 请求记录
 * @param {object} event 运行时事件
 * @returns {void}
 */
function applyEvent(record, event) {
	record.eventRevision = ++eventRevision;
	if (event.runId) record.runId = event.runId;
	switch (event.type) {
		case "queued":
			record.status = "queued";
			break;
		case "started":
			record.status = "running";
			record.startedAt = event.at;
			break;
		case "cancelling":
			record.status = "cancelling";
			break;
		case "text_delta":
			record.text += event.delta;
			break;
		case "steered":
			// 送达位置以此刻已收到的正文长度为准，终态后由历史记录校正。
			record.steers = [
				...(record.steers ?? []),
				{
					steerId: event.steerId,
					input: event.input ?? "",
					attachments: event.attachments ?? [],
					textOffset: record.text.length,
				},
			];
			break;
		case "tool_started":
			record.steps.push({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				target: event.target,
				startedAt: event.at,
			});
			break;
		case "tool_result": {
			const step = record.steps.find(({ toolCallId, endedAt }) => toolCallId === event.toolCallId && !endedAt);
			if (step) Object.assign(step, { endedAt: event.at, isError: event.isError });
			break;
		}
		case "terminal":
			record.status = event.status;
			record.failure = event.failure?.message;
			record.endedAt = event.at;
			break;
	}
}

function receive(event) {
	if (!event?.sessionId || sideChat.receive(event)) return;
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
		steps: [],
	};
	requests.set(event.requestId, record);
	applyEvent(record, event);
	if (type === "tool_result") forgetMissingPaths(sessionId);
	if (type === "terminal") {
		forgetMissingPaths(sessionId);
		timeline.active.delete(requestId);
		// 后台终态已经落盘。下次打开时读取，避免在后台为整段历史再分配内存。
		invalidateHistory(timeline);
		pruneTimelines();
		if (sessionId === session) void reloadHistory(sessionId);
		if (sessionId === session) void refreshContextUsage();
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

/** 记录运行中请求的最新一句推理。只放在内存时间线，不随历史保存或复制。@param {{sessionId: string, requestId: string, text: string}} message 推理预览 @returns {void} */
function receiveReasoning({ sessionId, requestId, text }) {
	const record = timelines.get(sessionId)?.requests.get(requestId);
	if (!record || record.status !== "running" || record.text) return;
	record.reasoning = text;
	if (sessionId === session) renderRequests();
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
	return state?.modelSettings?.available ?? [];
}

function paintEffort(hop = false) {
	const range = by("effort-range");
	const options = effortOptions();
	const value = effortNames[options[Number(range.value)]] ?? "";
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
	const max = String(Math.max(0, options.length - 1));
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
	void saveEffort(effortOptions()[0]);
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

by("context-compact").addEventListener(
	"click",
	action(async () => {
		const target = session;
		if (state?.compacting) return ui.cancelCompaction(target);
		const changed = await ui.compactContext(target);
		toast(changed ? "已压缩上下文，后续以摘要续接。" : "没有尚未压缩的对话。");
		const timeline = timelines.get(target);
		if (timeline) invalidateHistory(timeline);
		if (target !== session) return;
		void reloadHistory(target);
		void refreshContextUsage();
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
			if (record.queued) return;
			const { requests } = timeline;
			const current = requests.get(record.requestId);
			requests.set(record.requestId, {
				...record,
				...current,
				input: record.input,
				file: record.file,
				attachments: record.attachments,
				steps: current?.steps ?? [],
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
const unsubscribe = ui.subscribe((message) => {
	if (message.kind === "state") update(message.state);
	else if (message.kind === "event") receive(message.event);
	else if (message.kind === "reasoning") receiveReasoning(message);
	else if (message.kind === "reply-menu" && menuSelection) {
		const text = menuSelection;
		menuSelection = undefined;
		if (message.choice === "quote") quoteIntoPrompt(text);
		else if (message.choice === "side") void sideChat.open(text);
	} else if (message.kind === "notice") {
		const title = message.session !== session && state?.sessions.find(({ id }) => id === message.session)?.title;
		toast(title ? `${title}：${message.text}` : message.text, { tone: message.tone });
	}
	// 点击系统通知后回到对应会话，与侧栏点击走同一路径。
	else if (message.kind === "focus-session" && message.id !== session) action(() => ui.selectSession(message.id))();
});
window.addEventListener("unload", unsubscribe, { once: true });
