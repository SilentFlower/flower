window.agentUI = (() => {
	const { element, button, icon, mark } = window.flowerUI;
	const states = {
		queued: "已排队",
		running: "运行中",
		cancelling: "正在取消",
		succeeded: "已完成",
		cancelled: "已取消",
		failed: "未完成",
		denied: "授权已失效",
		interrupted: "上次运行已中断",
	};
	const stepStates = { running: "进行中", done: "完成", error: "出错", stopped: "已结束" };

	function orderChildren(parent, children) {
		let cursor = parent.firstElementChild;
		for (const child of children) {
			if (child !== cursor) parent.insertBefore(child, cursor);
			cursor = child.nextElementSibling;
		}
		while (cursor) {
			const next = cursor.nextElementSibling;
			cursor.remove();
			cursor = next;
		}
	}

	function workspaceLocation(entry, entries) {
		const separator = entry.path.startsWith("/") ? "/" : "\\";
		const parentsOf = (path) => path.split(separator).slice(0, -1);
		const parents = parentsOf(entry.path);
		// 同名目录逐级补充父目录，直到侧栏能区分它们。
		const peers = entries
			.filter((other) => other.workspace === entry.workspace && other.path !== entry.path)
			.map(({ path }) => parentsOf(path));
		let length = 1;
		let location = parents.at(-1);
		while (length < parents.length && peers.some((parts) => parts.slice(-length).join(separator) === location)) {
			length++;
			location = parents.slice(-length).join(separator);
		}
		if (!location) return separator;
		return length < parents.length ? `…${separator}${location}` : location;
	}

	/** 按平铺或工作区组织会话，复用可聚焦的会话行。@param {HTMLElement} root 列表 @param {Function} select 选择会话 @param {Function} openMenu 打开所选行的操作菜单 @returns {Function} 更新列表 */
	function sessionList(root, select, openMenu) {
		const nodes = new Map();
		const groups = new Map();
		const collapsed = new Set();
		const searchCollapsed = new Set();
		let query = "";
		let groupNumber = 0;

		function managedRow(control, type, key) {
			const row = element("div", "managed-row");
			const pin = icon("pin");
			pin.classList.add("sidebar-pin");
			const more = button("", () => openMenu(type, key, more), "icon-button sidebar-options");
			more.append(icon("more"));
			more.setAttribute("aria-haspopup", "menu");
			row.addEventListener("contextmenu", (event) => {
				event.preventDefault();
				openMenu(type, key, more);
			});
			row.append(control, pin, more);
			return row;
		}

		function showGroup(group, expanded) {
			group.control.setAttribute("aria-expanded", String(expanded));
			const badge = !expanded && group.waiting ? "，待批准" : "";
			group.control.setAttribute("aria-label", `${group.name.textContent}，${group.control.title}${badge}`);
			group.control.dataset.current = String(!expanded && group.containsActive);
			group.entries.hidden = !expanded;
			group.badge.hidden = expanded || !group.waiting;
		}

		function workspaceGroup(id) {
			if (groups.has(id)) return groups.get(id);
			const elementRoot = element("div", "workspace-group");
			const entries = element("div", "workspace-group-entries");
			entries.id = `workspace-group-${++groupNumber}`;
			const name = element("span", "workspace-group-name");
			const path = element("span", "workspace-group-path");
			const caption = element("span", "workspace-group-caption");
			caption.append(name, path);
			const badge = element("span", "session-approval", "待批准");
			const disclosure = element("span", "workspace-disclosure");
			disclosure.setAttribute("aria-hidden", "true");
			const control = button(
				"",
				() => {
					const folds = query ? searchCollapsed : collapsed;
					if (folds.delete(id)) showGroup(group, true);
					else {
						folds.add(id);
						showGroup(group, false);
					}
				},
				"workspace-group-toggle",
			);
			control.setAttribute("aria-controls", entries.id);
			control.append(disclosure, caption, badge);
			const row = managedRow(control, "workspace", id);
			elementRoot.append(row, entries);
			const group = { elementRoot, entries, name, path, badge, control, row };
			groups.set(id, group);
			return group;
		}

		return (items, { active, grouped, spaces, query: nextQuery }) => {
			// 搜索自动展开结果，清除查询后恢复原来的折叠状态。
			if (query !== nextQuery) searchCollapsed.clear();
			query = nextQuery;
			const live = new Set(items.map(({ id }) => id));
			for (const [id, control] of nodes) {
				if (live.has(id)) continue;
				control.remove();
				nodes.delete(id);
			}
			const rows = items.map(({ id, title, awaitingWrite, pinned }) => {
				if (!nodes.has(id)) {
					const control = button("", () => select(id), "session-row");
					control.append(element("span"), element("span", "session-approval", "待批准"));
					nodes.set(id, managedRow(control, "session", id));
				}
				const row = nodes.get(id);
				row.dataset.pinned = String(Boolean(pinned));
				row.lastElementChild.setAttribute("aria-label", `会话操作：${title}`);
				const control = row.firstElementChild;
				control.firstElementChild.textContent = title;
				control.lastElementChild.hidden = !awaitingWrite;
				control.title = title;
				control.setAttribute("aria-current", String(id === active));
				control.setAttribute("aria-label", awaitingWrite ? `${title}，待批准` : title);
				return row;
			});
			if (!grouped) {
				orderChildren(root, rows);
				groups.clear();
				return;
			}

			const entries = new Map(
				spaces.map((space) => [space.workspaceId, { ...space, rows: [], waiting: false, containsActive: false }]),
			);
			for (const [index, item] of items.entries()) {
				const { workspaceId, awaitingWrite, id } = item;
				const entry = entries.get(workspaceId);
				entry.rows.push(rows[index]);
				entry.waiting ||= awaitingWrite;
				entry.containsActive ||= id === active;
			}
			const folds = query ? searchCollapsed : collapsed;
			const roots = [];
			const workspaces = [...entries.values()];
			for (const [id, entry] of entries) {
				const group = workspaceGroup(id);
				group.name.textContent = entry.workspace || entry.path;
				group.path.textContent = workspaceLocation(entry, workspaces);
				group.control.title = entry.path;
				group.row.dataset.pinned = String(Boolean(entry.pinned));
				group.row.lastElementChild.setAttribute("aria-label", `工作区操作：${entry.workspace}`);
				group.waiting = entry.waiting;
				group.containsActive = entry.containsActive;
				orderChildren(group.entries, entry.rows);
				showGroup(group, !folds.has(id));
				roots.push(group.elementRoot);
			}
			orderChildren(root, roots);
			for (const id of groups.keys()) {
				if (!entries.has(id)) groups.delete(id);
			}
		};
	}

	/** 绑定任务输入快捷键并保留原生中文输入。@param {HTMLTextAreaElement} input 输入框 @param {HTMLButtonElement} submit 提交按钮 @returns {void} */
	function bindComposer(input, submit) {
		let composing = false;
		input.addEventListener("compositionstart", () => {
			composing = true;
		});
		input.addEventListener("compositionend", () => {
			composing = false;
		});
		input.addEventListener("blur", () => {
			composing = false;
		});
		input.addEventListener("keydown", (event) => {
			if (
				event.key !== "Enter" ||
				event.shiftKey ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.isComposing ||
				composing ||
				event.keyCode === 229
			)
				return;
			event.preventDefault();
			if (!event.repeat && !submit.disabled) submit.click();
		});
	}

	function toolSteps() {
		const node = element("details", "step-list");
		const summary = element("summary");
		const list = element("ol");
		node.append(summary, list);
		let previous = "";
		return {
			node,
			update(steps) {
				const key = JSON.stringify(steps);
				if (previous === key) return;
				previous = key;
				node.hidden = steps.length === 0;
				const running = steps.some(({ state }) => state === "running");
				summary.textContent = `工具步骤 · ${steps.length} 项${running ? " · 进行中" : ""}`;
				list.replaceChildren(
					...steps.map(({ label, state }) => {
						const line = element("li");
						line.append(element("span", "", label), element("span", "", stepStates[state]));
						return line;
					}),
				);
			},
		};
	}

	function deliverables(open, preview) {
		const node = element("section", "deliveries");
		const files = element("div", "deliveries");
		node.append(element("h3", "", "交付文件"), files);
		let previous = "";
		return {
			node,
			update(paths) {
				const key = JSON.stringify(paths);
				if (key === previous) return;
				previous = key;
				node.hidden = paths.length === 0;
				files.replaceChildren(
					...paths.map((path) => {
						const name = path.split(/[\\/]/).at(-1) || path;
						const workbook = /\.xlsx$/i.test(name);
						const row = element("div", "deliverable");
						const kind = element("span", "document-icon", workbook ? "XLSX" : "MD");
						const title = element("span", "document-name", name);
						title.title = path;
						const control = button("打开 ↗", () => open(path));
						control.setAttribute(
							"aria-label",
							workbook ? "打开汇总工作簿" : name === "核对报告.md" ? "打开核对报告" : "打开分析报告",
						);
						const inspect = button("预览", (event) => preview(path, event.currentTarget));
						inspect.setAttribute(
							"aria-label",
							workbook ? "预览汇总工作簿" : name === "核对报告.md" ? "预览核对报告" : "预览分析报告",
						);
						row.append(kind, title, inspect, control);
						return row;
					}),
				);
			},
		};
	}

	function message(id, actions) {
		const node = element("article", "task");
		node.dataset.request = id;
		const prompt = element("div", "user-message");
		const input = element("p", "user-message-text");
		const file = element("div", "message-file file-chips");
		const showFiles = window.flowerAttachments.view(file, undefined, id, actions.previewAttachment);
		prompt.append(input, file);
		const reply = element("section", "assistant-message");
		const head = element("header", "assistant-head");
		const status = element("span", "status");
		status.setAttribute("role", "status");
		let record;
		const cancel = button("取消任务", () => actions.cancel(id, record.runId), "quiet cancel-task");
		const copy = button("", () => actions.copy(id), "quiet copy-reply");
		copy.title = "复制回复原文";
		copy.setAttribute("aria-label", copy.title);
		copy.append(icon("copy"));
		head.append(mark("small"), element("h2", "", "Flower"), status, cancel, copy);
		const text = element("div", "message-text markdown-reply");
		const markdown = window.flowerMarkdown.view(text, actions.openLink);
		const failure = element("p", "message-text message-error");
		const steps = toolSteps();
		const deliveries = deliverables((path) => actions.open(id, path), actions.preview);
		reply.append(head, steps.node, text, failure, deliveries.node);
		node.append(prompt, reply);
		return {
			node,
			dispose: showFiles.dispose,
			update(next) {
				record = next;
				node.dataset.status = record.status;
				prompt.hidden = !record.input;
				if (input.textContent !== (record.input ?? "")) input.textContent = record.input ?? "";
				showFiles(record.attachments ?? (record.file ? [{ id: `file:${record.file}`, name: record.file }] : []));
				const state = states[record.status] ?? record.status;
				if (status.textContent !== state) status.textContent = state;
				status.dataset.state = record.status;
				cancel.hidden = !["queued", "running"].includes(record.status);
				copy.hidden = !record.text || !record.status || ["queued", "running", "cancelling"].includes(record.status);
				markdown.update(record.text ?? "");
				failure.hidden = !record.failure;
				if (failure.textContent !== (record.failure ?? "")) failure.textContent = record.failure ?? "";
				steps.update(record.tools ?? []);
				deliveries.update(record.artifacts ?? []);
			},
		};
	}

	/** 更新同一会话的消息，保留工具折叠、键盘焦点与阅读位置。@param {HTMLElement} root 消息列表 @param {HTMLElement} scroll 滚动区域 @param {object} actions 取消与打开交付物 @returns {object} 消息更新与重置接口 */
	function thread(root, scroll, actions) {
		const views = new Map();
		return {
			reset() {
				for (const view of views.values()) view.dispose();
				root.replaceChildren();
				views.clear();
				scroll.scrollTop = 0;
			},
			update(records, forceFollow = false) {
				// 紧凑会话刚出现滚动条时，停在顶部仍代表用户正在回看。
				const offset = scroll.scrollTop;
				const overflow = scroll.scrollHeight - scroll.clientHeight;
				const follow = forceFollow || overflow <= 0 || (offset > 0 && overflow - offset < 65);
				let cursor = root.firstElementChild;
				for (const record of records) {
					if (!views.has(record.requestId)) views.set(record.requestId, message(record.requestId, actions));
					const view = views.get(record.requestId);
					view.update(record);
					if (view.node !== cursor) root.insertBefore(view.node, cursor);
					cursor = view.node.nextElementSibling;
				}
				scroll.scrollTop = follow ? scroll.scrollHeight : offset;
			},
		};
	}

	return { sessionList, bindComposer, thread };
})();
