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
	const stepStates = { error: "出错", stopped: "已结束" };
	// 侧栏状态点的读屏文案；待批准沿用原有徽标显示文字。
	const indicators = { running: "运行中", done: "已完成，未查看", failed: "失败，未查看", approval: "待批准" };
	const indicatorRank = { approval: 4, running: 3, failed: 2, done: 1 };

	/** 设置状态点。@param {HTMLElement} dot 状态点 @param {string | undefined} indicator 状态 @returns {void} */
	function showIndicator(dot, indicator) {
		dot.dataset.indicator = indicator ?? "";
		// 待批准已有文字徽标，状态点只表示其余三种状态。
		dot.hidden = !indicator || indicator === "approval";
	}
	const activeStatuses = new Set(["queued", "running", "cancelling"]);
	// 每个工具的进行中、完成、基础动作与摘要量词；未知工具归入「另外 N 项」。
	const toolActions = {
		list_workspace: ["正在查看", "已查看", "查看", "个目录"],
		read_text_file: ["正在读取", "已读取", "读取", "个文件"],
		inspect_excel: ["正在检查", "已检查", "检查", "个工作簿"],
		analyze_excel: ["正在分析", "已分析", "分析", "个工作簿"],
		write_report: ["正在写入", "已写入", "写入", "份报告"],
	};
	const otherAction = ["正在调用工具", "已调用工具", "调用工具"];
	const endings = {
		succeeded: "已处理",
		failed: "处理失败，耗时",
		cancelled: "已取消，耗时",
		denied: "未获授权，耗时",
		interrupted: "运行已中断",
	};
	// 导航预览卡在回复尚无正文时显示的状态说明；失败另取失败原因。
	const previewStates = {
		queued: "正在处理…",
		running: "正在处理…",
		cancelled: "已取消",
		interrupted: "上次运行已中断",
		denied: "未获授权",
	};

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
			// 折叠时组上只显示最高优先级的状态，展开后由各会话行显示。
			const indicator = expanded ? undefined : group.indicator;
			const badge = indicator ? `，${indicators[indicator]}` : "";
			group.control.setAttribute("aria-label", `${group.name.textContent}，${group.control.title}${badge}`);
			group.control.dataset.current = String(!expanded && group.containsActive);
			group.entries.hidden = !expanded;
			group.badge.hidden = indicator !== "approval";
			showIndicator(group.dot, indicator);
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
			const dot = element("span", "session-indicator");
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
			control.append(disclosure, caption, dot, badge);
			const row = managedRow(control, "workspace", id);
			elementRoot.append(row, entries);
			const group = { elementRoot, entries, name, path, badge, dot, control, row };
			groups.set(id, group);
			return group;
		}

		/** 按当前搜索态取折叠集合。@returns {Set<string>} 折叠的工作区 */
		const foldSet = () => (query ? searchCollapsed : collapsed);

		const render = (items, { active, grouped, spaces, query: nextQuery }) => {
			// 搜索自动展开结果，清除查询后恢复原来的折叠状态。
			if (query !== nextQuery) searchCollapsed.clear();
			query = nextQuery;
			const live = new Set(items.map(({ id }) => id));
			for (const [id, control] of nodes) {
				if (live.has(id)) continue;
				control.remove();
				nodes.delete(id);
			}
			const rows = items.map(({ id, title, awaitingWrite, pinned, indicator }) => {
				if (!nodes.has(id)) {
					const control = button("", () => select(id), "session-row");
					control.append(
						element("span"),
						element("span", "session-indicator"),
						element("span", "session-approval", "待批准"),
					);
					nodes.set(id, managedRow(control, "session", id));
				}
				const row = nodes.get(id);
				row.dataset.pinned = String(Boolean(pinned));
				row.lastElementChild.setAttribute("aria-label", `会话操作：${title}`);
				const control = row.firstElementChild;
				control.firstElementChild.textContent = title;
				control.lastElementChild.hidden = !awaitingWrite;
				showIndicator(control.children[1], indicator);
				control.title = title;
				control.setAttribute("aria-current", String(id === active));
				const label = awaitingWrite ? "approval" : indicator;
				control.setAttribute("aria-label", label ? `${title}，${indicators[label]}` : title);
				return row;
			});
			if (!grouped) {
				orderChildren(root, rows);
				groups.clear();
				return;
			}

			const entries = new Map(
				spaces.map((space) => [space.workspaceId, { ...space, rows: [], indicator: undefined, containsActive: false }]),
			);
			for (const [index, item] of items.entries()) {
				const { workspaceId, awaitingWrite, id } = item;
				const entry = entries.get(workspaceId);
				entry.rows.push(rows[index]);
				const indicator = awaitingWrite ? "approval" : item.indicator;
				if ((indicatorRank[indicator] ?? 0) > (indicatorRank[entry.indicator] ?? 0)) entry.indicator = indicator;
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
				group.indicator = entry.indicator;
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
		/** 折叠或展开全部工作区分组，搜索中作用于搜索结果。@param {boolean} collapse 为 true 时全部折叠 @returns {void} */
		render.collapseAll = (collapse) => {
			for (const [id, group] of groups) {
				if (collapse) foldSet().add(id);
				else foldSet().delete(id);
				showGroup(group, !collapse);
			}
		};
		/** 是否还有展开的分组。@returns {boolean} 有展开分组时为 true */
		render.anyExpanded = () => [...groups.keys()].some((id) => !foldSet().has(id));
		/**
		 * 展开会话所在分组，滚动到侧栏中部并聚焦、短暂高亮。
		 * @param {string} id 会话 ID
		 * @returns {boolean} 会话行在列表中时为 true
		 */
		render.reveal = (id) => {
			const row = nodes.get(id);
			if (!row?.isConnected) return false;
			for (const [key, group] of groups) {
				if (!group.entries.contains(row) || !foldSet().delete(key)) continue;
				showGroup(group, true);
			}
			const control = row.firstElementChild;
			const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
			control.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
			control.focus({ preventScroll: true });
			control.removeAttribute("data-located");
			void control.offsetWidth;
			control.toggleAttribute("data-located", true);
			setTimeout(() => control.removeAttribute("data-located"), 1200);
			return true;
		};
		return render;
	}

	/**
	 * 历史输入召回：空输入框按 ↑ 取出更早的已发输入，↓ 返回较新的一条，越过最新一条或 Esc 恢复原草稿。
	 * 召回内容被修改后退出召回，方向键回到普通光标移动。
	 * @returns {{key(key: string, value: string, entries: string[]): string | undefined}} 按键处理，返回新的输入内容或 undefined
	 */
	function inputRecall() {
		let cursor = -1;
		let saved = "";
		let shown = "";
		return {
			key(key, value, entries) {
				if (cursor >= 0 && value !== shown) cursor = -1;
				if (key === "Escape") {
					if (cursor < 0) return;
					cursor = -1;
					return saved;
				}
				if (key === "ArrowUp") {
					if (cursor < 0) {
						if (value || !entries.length) return;
						saved = value;
						cursor = entries.length;
					}
					cursor = Math.max(0, cursor - 1);
					shown = entries[cursor];
					return shown;
				}
				if (key !== "ArrowDown" || cursor < 0) return;
				cursor += 1;
				if (cursor >= entries.length) {
					cursor = -1;
					return saved;
				}
				shown = entries[cursor];
				return shown;
			},
		};
	}

	/**
	 * 绑定任务输入快捷键并保留原生中文输入。
	 * @param {HTMLTextAreaElement} input 输入框
	 * @param {HTMLButtonElement} submit 提交按钮
	 * @param {() => string[]} [history] 当前会话已发输入，旧到新
	 * @returns {void}
	 */
	function bindComposer(input, submit, history) {
		const recall = inputRecall();
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
			const plain =
				!event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && !composing;
			if (history && plain && event.keyCode !== 229 && ["ArrowUp", "ArrowDown", "Escape"].includes(event.key)) {
				const next = recall.key(event.key, input.value, history());
				if (next === undefined) return;
				event.preventDefault();
				input.value = next;
				input.setSelectionRange(next.length, next.length);
				// 与用户输入一致地通知发送按钮与草稿状态。
				input.dispatchEvent(new Event("input", { bubbles: true }));
				return;
			}
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

	/** 将毫秒耗时格式化为中文时长。@param {number} ms 毫秒 @returns {string} 如「2 分 13 秒」 */
	function duration(ms) {
		const seconds = Math.max(1, Math.round(ms / 1000));
		if (seconds < 60) return `${seconds} 秒`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`;
		return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${Math.floor(minutes / 60)} 小时`;
	}

	/** 按工具统计摘要计数。@param {object[]} steps 工具步骤 @returns {string} 如「读取 3 个文件、分析 1 个工作簿」 */
	function stepCounts(steps) {
		const counts = new Map();
		for (const { toolName } of steps) {
			const key = toolActions[toolName] ? toolName : "";
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts]
			.map(([toolName, count]) => {
				if (!toolName) return `另外 ${count} 项`;
				const [, , action, unit] = toolActions[toolName];
				return `${action} ${count} ${unit}`;
			})
			.join("、");
	}

	/** 展示用目标只保留最后一级，完整路径放在悬停提示。@param {object} step 工具步骤 @returns {string} 目标名 */
	const targetName = ({ target }) => target?.split("/").at(-1) ?? "";

	/** 渲染工具步骤：运行中展开显示当前动作，结束后折叠为耗时与动作计数。@returns {object} 节点与更新接口 */
	function toolSteps() {
		const node = element("details", "step-list");
		const summary = element("summary");
		const list = element("ol");
		node.append(summary, list);
		let previous = "";
		let active;
		return {
			node,
			update(steps, record) {
				const key = JSON.stringify([steps, record.status, record.startedAt, record.endedAt]);
				if (previous === key) return;
				previous = key;
				node.hidden = steps.length === 0;
				const running = activeStatuses.has(record.status);
				// 只在运行与结束之间切换时改变展开状态，保留用户手动展开或收起的选择。
				if (active !== running) node.open = running;
				active = running;
				const current = steps.findLast(({ endedAt }) => !endedAt);
				if (running) {
					const [doing] = toolActions[current?.toolName] ?? otherAction;
					summary.textContent = current ? `${doing} ${targetName(current)}`.trim() : `已执行 ${steps.length} 步`;
				} else {
					const ending = endings[record.status] ?? "已结束";
					const spent = record.startedAt && record.endedAt ? ` ${duration(record.endedAt - record.startedAt)}` : "";
					const label = ending.endsWith("耗时") && !spent ? ending.slice(0, -3) : `${ending}${spent}`;
					summary.textContent = `${label} · ${stepCounts(steps)}`;
				}
				list.replaceChildren(
					...steps.map((step) => {
						const [doing, done, action] = toolActions[step.toolName] ?? otherAction;
						const state = step.endedAt ? (step.isError ? "error" : "done") : running ? "running" : "stopped";
						const verb = state === "running" ? doing : state === "done" ? done : action;
						const line = element("li");
						line.dataset.state = state;
						const what = element("span", "", `${verb} ${targetName(step)}`.trim());
						if (step.target) what.title = step.target;
						line.append(what, element("span", "", stepStates[state] ?? ""));
						return line;
					}),
				);
			},
		};
	}

	function deliverables(open, preview, menu) {
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
						// 右键或菜单键提供预览、在文件夹中显示与复制路径。
						row.addEventListener("contextmenu", (event) => {
							if (!menu) return;
							event.preventDefault();
							menu(path, event.target.closest("button") ?? inspect);
						});
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
		const copyInput = button("", () => actions.copyInput(id), "quiet copy-reply copy-input");
		copyInput.title = "复制提问原文";
		copyInput.setAttribute("aria-label", copyInput.title);
		copyInput.append(icon("copy"));
		prompt.append(input, file, copyInput);
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
		// 未完成的请求没有进入模型上下文，可以原样重试，或放回输入框修改后再发。
		const retry = button("重试", () => actions.retry(id), "quiet retry-task");
		const edit = button("编辑", () => actions.edit(id), "quiet retry-task");
		head.append(mark("small"), element("h2", "", "Flower"), status, cancel, retry, edit, copy);
		// 推理只是运行中的瞬时提示，单独成行避免挤压状态与操作按钮。
		const thought = element("p", "reasoning-preview");
		thought.setAttribute("aria-live", "polite");
		const text = element("div", "message-text markdown-reply");
		const markdown = window.flowerMarkdown.view(text, actions.openLink, actions.paths);
		const failure = element("p", "message-text message-error");
		const steps = toolSteps();
		const deliveries = deliverables((path) => actions.open(id, path), actions.preview, actions.paths?.menu);
		reply.append(head, thought, steps.node, text, failure, deliveries.node);
		node.append(prompt, reply);
		return {
			node,
			reply: text,
			dispose: showFiles.dispose,
			update(next) {
				record = next;
				node.dataset.status = record.status;
				prompt.hidden = !record.input;
				if (input.textContent !== (record.input ?? "")) input.textContent = record.input ?? "";
				showFiles(record.attachments ?? (record.file ? [{ id: `file:${record.file}`, name: record.file }] : []));
				const state = states[record.status] ?? record.status;
				// 首个正文或工具步骤到达前给出等待提示，避免用户以为没有响应。
				const waiting = record.status === "running" && !record.text && !record.steps?.length;
				const label = waiting ? "正在思考" : state;
				if (status.textContent !== label) status.textContent = label;
				status.dataset.state = record.status;
				status.toggleAttribute("data-thinking", waiting);
				const reasoning = record.status === "running" && !record.text ? (record.reasoning ?? "") : "";
				if (thought.textContent !== reasoning) thought.textContent = reasoning;
				thought.hidden = !reasoning;
				cancel.hidden = !["queued", "running"].includes(record.status);
				const unfinished =
					["failed", "cancelled", "interrupted", "denied"].includes(record.status) && Boolean(record.input);
				retry.hidden = edit.hidden = !unfinished;
				copyInput.hidden = !record.input;
				copy.hidden = !record.text || !record.status || ["queued", "running", "cancelling"].includes(record.status);
				markdown.update(record.text ?? "");
				failure.hidden = !record.failure;
				if (failure.textContent !== (record.failure ?? "")) failure.textContent = record.failure ?? "";
				steps.update(record.steps ?? [], record);
				deliveries.update(record.artifacts ?? []);
			},
		};
	}

	/**
	 * 判定当前阅读的轮次：贴底时为最后一轮，否则为顶部已进入视口上部三分之一的最后一轮。
	 * @param {number[]} tops 各轮顶部相对滚动视口顶部的偏移，按时间顺序递增
	 * @param {number} viewport 滚动视口高度
	 * @param {boolean} atBottom 是否贴底
	 * @returns {number} 当前轮次下标，没有轮次时为 -1
	 */
	function navigatorTurn(tops, viewport, atBottom) {
		if (!tops.length) return -1;
		// 最后一轮可能很短，顶部到不了阅读线，贴底时直接视为在读最后一轮。
		if (atBottom) return tops.length - 1;
		let current = 0;
		for (const [index, top] of tops.entries()) {
			if (top > viewport / 3) break;
			current = index;
		}
		return current;
	}

	/**
	 * 生成导航预览卡文案：提问取原话，只有附件时取附件名；回复取正文开头，尚无正文时按状态说明。
	 * @param {object} record 请求记录
	 * @param {string} replyText 回复正文的纯文本
	 * @returns {{title: string, body: string}} 提问与回复开头
	 */
	function turnPreview(record, replyText) {
		const files = record.attachments ?? (record.file ? [{ name: record.file }] : []);
		const input = (record.input ?? "").replace(/\s+/g, " ").trim();
		const title = input || files.map(({ name }) => name).join("、") || "（无文字）";
		const reply = (replyText ?? "").replace(/\s+/g, " ").trim();
		// 按码点截取，避免把表情等代理对切成乱码。
		if (reply) return { title, body: Array.from(reply.slice(0, 320)).slice(0, 160).join("") };
		if (record.status === "failed") return { title, body: record.failure || "运行失败" };
		return { title, body: previewStates[record.status] ?? "" };
	}

	/**
	 * 会话导航条：每轮一个刻度并高亮当前阅读的轮次，悬停或聚焦刻度时预览该轮，点击跳到该轮开头。
	 * 只占一个 Tab 停留点，方向键在刻度间移动。
	 * @param {HTMLElement} nav 导航条
	 * @param {HTMLElement} scroll 滚动区域
	 * @param {HTMLElement} root 消息列表
	 * @param {Map<string, object>} views 按请求 ID 保存的消息视图
	 * @returns {{update(records: object[]): void, reset(): void}} 刻度更新与清空接口
	 */
	function navigatorView(nav, scroll, root, views) {
		const list = nav.querySelector(".navigator-ticks");
		const card = nav.querySelector(".navigator-card");
		const [title, body] = card.children;
		const items = new Map();
		let records = [];
		let ticks = [];
		let current = -1;
		let previewed = -1;
		let frame = 0;

		function rove(index) {
			for (const [position, tick] of ticks.entries()) tick.tabIndex = position === Math.max(index, 0) ? 0 : -1;
		}
		function hide() {
			card.hidden = true;
			previewed = -1;
		}
		function preview(index) {
			const view = views.get(records[index]?.requestId);
			if (!view) return hide();
			// 每次显示都从回复节点读取，流式输出中也是最新内容。
			const text = turnPreview(records[index], view.reply.textContent);
			if (title.textContent !== text.title) title.textContent = text.title;
			if (body.textContent !== text.body) body.textContent = text.body;
			body.hidden = !text.body;
			card.hidden = false;
			previewed = index;
			// 卡片与刻度垂直居中对齐，靠近上下边缘时收在导航条内。
			const tick = ticks[index].getBoundingClientRect();
			const center = tick.top + tick.height / 2 - nav.getBoundingClientRect().top;
			const top = Math.min(center - card.offsetHeight / 2, nav.clientHeight - card.offsetHeight);
			card.style.top = `${Math.max(0, top)}px`;
		}
		function jump(index) {
			const node = views.get(records[index]?.requestId)?.node;
			if (!node) return;
			const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
			const top = scroll.scrollTop + node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
			scroll.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
		}
		function sync() {
			frame = 0;
			const viewport = scroll.getBoundingClientRect();
			// 留白从消息列正文左缘量起，窄窗时只剩边距，放不下刻度就不显示。
			const gap =
				root.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(root).paddingLeft) - viewport.left;
			const shown = !scroll.hidden && ticks.length >= 3 && scroll.scrollHeight > scroll.clientHeight && gap >= 40;
			nav.hidden = !shown;
			if (!shown) return hide();
			// 导航条覆盖滚动区域的可视高度，横向位于左侧留白的中线。
			nav.style.top = `${scroll.offsetTop}px`;
			nav.style.height = `${scroll.clientHeight}px`;
			nav.style.left = `${scroll.offsetLeft + gap / 2}px`;
			const tops = records.map(({ requestId }) => views.get(requestId).node.getBoundingClientRect().top - viewport.top);
			const atBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 65;
			const next = navigatorTurn(tops, scroll.clientHeight, atBottom);
			if (next !== current) {
				ticks[current]?.removeAttribute("aria-current");
				ticks[next]?.setAttribute("aria-current", "true");
				current = next;
				// 刻度多到在导航条内滚动时，让当前刻度保持可见。
				ticks[next]?.scrollIntoView({ block: "nearest" });
			}
			// 焦点在导航条内时停留点跟随焦点，离开后回到当前轮次。
			if (!nav.contains(document.activeElement)) rove(current);
			if (previewed >= 0) preview(previewed);
		}
		function schedule() {
			if (!frame) frame = requestAnimationFrame(sync);
		}

		scroll.addEventListener("scroll", schedule, { passive: true });
		list.addEventListener("scroll", schedule, { passive: true });
		const observer = new ResizeObserver(schedule);
		observer.observe(scroll);
		observer.observe(root);
		list.addEventListener("click", (event) => jump(ticks.indexOf(event.target.closest(".navigator-tick"))));
		list.addEventListener("pointerover", (event) => {
			const index = ticks.indexOf(event.target.closest(".navigator-tick"));
			if (index >= 0 && index !== previewed) preview(index);
		});
		list.addEventListener("focusin", (event) => {
			const index = ticks.indexOf(event.target);
			if (index < 0) return;
			rove(index);
			preview(index);
		});
		list.addEventListener("keydown", (event) => {
			const index = ticks.indexOf(event.target);
			if (index < 0) return;
			if (event.key === "Escape") {
				if (card.hidden) return;
				event.preventDefault();
				hide();
				return;
			}
			const target = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: ticks.length - 1 }[event.key];
			if (target === undefined) return;
			event.preventDefault();
			ticks[Math.max(0, Math.min(target, ticks.length - 1))].focus();
		});
		// 指针离开时若刻度仍有键盘焦点，卡片回到该刻度，否则收起。
		nav.addEventListener("pointerleave", () => {
			const focused = ticks.findIndex((tick) => tick.matches(":focus-visible"));
			if (focused >= 0) preview(focused);
			else hide();
		});
		nav.addEventListener("focusout", ({ relatedTarget }) => {
			if (nav.contains(relatedTarget)) return;
			rove(current);
			if (!nav.matches(":hover")) hide();
		});
		// 点击卡片不抢走刻度焦点，效果与点击刻度相同。
		card.addEventListener("mousedown", (event) => event.preventDefault());
		card.addEventListener("click", () => jump(previewed));

		return {
			/** 按请求记录同步刻度与名称。@param {object[]} next 当前会话的请求记录 @returns {void} */
			update(next) {
				const ids = next.map(({ requestId }) => requestId);
				if (ids.join("\n") !== records.map(({ requestId }) => requestId).join("\n")) {
					for (const id of items.keys()) if (!ids.includes(id)) items.delete(id);
					for (const id of ids) {
						if (items.has(id)) continue;
						const item = element("li");
						const tick = element("button", "navigator-tick");
						tick.type = "button";
						tick.tabIndex = -1;
						tick.dataset.request = id;
						item.append(tick);
						items.set(id, item);
					}
					// 复用已有刻度，新增轮次时不打断正在刻度上的键盘焦点。
					orderChildren(
						list,
						ids.map((id) => items.get(id)),
					);
					ticks = ids.map((id) => items.get(id).firstElementChild);
					for (const tick of ticks) tick.removeAttribute("aria-current");
					current = -1;
					hide();
				}
				records = next;
				for (const [index, tick] of ticks.entries()) {
					const label = `第 ${index + 1} 轮：${Array.from(turnPreview(records[index], "").title).slice(0, 40).join("")}`;
					if (tick.getAttribute("aria-label") !== label) tick.setAttribute("aria-label", label);
				}
				schedule();
			},
			/** 切换会话时清空刻度并隐藏导航条。@returns {void} */
			reset() {
				records = [];
				ticks = [];
				items.clear();
				list.replaceChildren();
				current = -1;
				hide();
				nav.hidden = true;
			},
		};
	}

	/**
	 * 更新同一会话的消息，保留工具折叠、键盘焦点与阅读位置；切换会话时记住并恢复各自的位置。
	 * @param {HTMLElement} root 消息列表
	 * @param {HTMLElement} scroll 滚动区域
	 * @param {object} actions 取消与打开交付物
	 * @param {HTMLButtonElement} bottom 回到底部按钮
	 * @param {HTMLElement} [navigator] 会话导航条，未传时不显示导航
	 * @returns {object} 消息更新与重置接口
	 */
	function thread(root, scroll, actions, bottom, navigator) {
		const views = new Map();
		const positions = new Map();
		const navigation = navigator && navigatorView(navigator, scroll, root, views);
		let pending;
		let unseen = false;
		const distance = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
		function syncBottom() {
			const away = !scroll.hidden && distance() >= 65;
			if (!away) unseen = false;
			bottom.hidden = !away;
			bottom.toggleAttribute("data-unseen", unseen);
			bottom.setAttribute("aria-label", unseen ? "回到底部，有新内容" : "回到底部");
		}
		scroll.addEventListener("scroll", syncBottom, { passive: true });
		bottom.addEventListener("click", () => {
			const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
			scroll.scrollTo({ top: scroll.scrollHeight, behavior: reduced ? "auto" : "smooth" });
		});
		return {
			/** 切换会话前记住旧会话的位置。@param {string} [previous] 旧会话 @param {string} [next] 新会话 @returns {void} */
			reset(previous, next) {
				if (previous && views.size) positions.set(previous, { offset: scroll.scrollTop, atBottom: distance() < 65 });
				for (const view of views.values()) view.dispose();
				root.replaceChildren();
				views.clear();
				scroll.scrollTop = 0;
				pending = next ? positions.get(next) : undefined;
				unseen = false;
				navigation?.reset();
			},
			update(records, forceFollow = false) {
				// 紧凑会话刚出现滚动条时，停在顶部仍代表用户正在回看。
				const offset = scroll.scrollTop;
				const height = scroll.scrollHeight;
				const overflow = height - scroll.clientHeight;
				const follow = forceFollow || overflow <= 0 || (offset > 0 && overflow - offset < 65);
				let cursor = root.firstElementChild;
				const list = [...records];
				for (const record of list) {
					if (!views.has(record.requestId)) views.set(record.requestId, message(record.requestId, actions));
					const view = views.get(record.requestId);
					view.update(record);
					if (view.node !== cursor) root.insertBefore(view.node, cursor);
					cursor = view.node.nextElementSibling;
				}
				if (pending && views.size) {
					// 会话内容首次渲染后回到上次离开的位置，离开时贴底的会话继续跟随输出。
					const max = scroll.scrollHeight - scroll.clientHeight;
					scroll.scrollTop = pending.atBottom ? scroll.scrollHeight : Math.min(pending.offset, max);
					pending = undefined;
				} else {
					if (!follow && scroll.scrollHeight > height) unseen = true;
					scroll.scrollTop = follow ? scroll.scrollHeight : offset;
				}
				syncBottom();
				navigation?.update(list);
			},
		};
	}

	return { sessionList, bindComposer, thread, inputRecall, navigatorTurn, turnPreview };
})();
