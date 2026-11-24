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

	/** 按平铺或工作区组织会话，复用可聚焦的会话行。@param {HTMLElement} root 列表 @param {Function} select 选择会话 @param {Function} openMenu 打开所选行的操作菜单 @param {(id: string, requestId: string) => void} [openHit] 打开正文命中的那一轮 @returns {Function} 更新列表 */
	function sessionList(root, select, openMenu, openHit) {
		const nodes = new Map();
		// 正文搜索的命中片段，显示在会话行下方。
		const hitNodes = new Map();

		function hits(id, list) {
			if (!list?.length) {
				hitNodes.get(id)?.remove();
				hitNodes.delete(id);
				return;
			}
			let node = hitNodes.get(id);
			if (!node) {
				node = element("div", "session-snippets");
				hitNodes.set(id, node);
			}
			const key = JSON.stringify(list);
			if (node.dataset.key !== key) {
				node.dataset.key = key;
				node.replaceChildren(
					...list.map((hit) => {
						const control = button("", () => openHit?.(id, hit.requestId), "session-snippet");
						control.append(element("span", "", hit.before), element("mark", "", hit.match), element("span", "", hit.after));
						control.setAttribute(
							"aria-label",
							`${hit.field === "input" ? "提问" : "回复"}中命中：${hit.before}${hit.match}${hit.after}`,
						);
						return control;
					}),
				);
			}
			return node;
		}
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

		const render = (items, { active, grouped, spaces, query: nextQuery, snippets }) => {
			// 搜索自动展开结果，清除查询后恢复原来的折叠状态。
			if (query !== nextQuery) searchCollapsed.clear();
			query = nextQuery;
			const live = new Set(items.map(({ id }) => id));
			for (const [id, control] of nodes) {
				if (live.has(id)) continue;
				control.remove();
				nodes.delete(id);
			}
			for (const id of hitNodes.keys()) if (!live.has(id) || !snippets?.has(id)) hits(id);
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
				const hit = hits(id, snippets?.get(id));
				return hit ? [row, hit] : [row];
			});
			if (!grouped) {
				orderChildren(root, rows.flat());
				groups.clear();
				return;
			}

			const entries = new Map(
				spaces.map((space) => [space.workspaceId, { ...space, rows: [], indicator: undefined, containsActive: false }]),
			);
			for (const [index, item] of items.entries()) {
				const { workspaceId, awaitingWrite, id } = item;
				const entry = entries.get(workspaceId);
				entry.rows.push(...rows[index]);
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

	/**
	 * 输入框上方的排队消息：显示首行与附件数，可行内编辑、删除、拖动或键盘排序、插话，暂停时显示「继续」。
	 * @param {HTMLElement} root 队列区域
	 * @param {object} actions 编辑、删除、排序、继续、插话与更多菜单
	 * @returns {(view?: {items: object[], paused: boolean, steerable: boolean}) => void} 按 Main 的队列视图更新
	 */
	function queueBar(root, actions) {
		const head = element("div", "queue-head");
		const title = element("span", "queue-title");
		const paused = element("span", "queue-paused", "已暂停");
		const resume = button("继续", () => actions.resume(), "quiet queue-resume");
		head.append(title, paused, resume);
		const list = element("ol", "queue-list");
		window.flowerUI.softScroll(list);
		root.append(head, list);
		const rows = new Map();
		let items = [];
		let editing;
		let dragged;

		function reorder(ids) {
			if (ids.join("\n") !== items.map(({ id }) => id).join("\n")) actions.reorder(ids);
		}
		function move(id, step) {
			const ids = items.map((item) => item.id);
			const index = ids.indexOf(id);
			const target = index + step;
			if (index < 0 || target < 0 || target >= ids.length) return;
			[ids[index], ids[target]] = [ids[target], ids[index]];
			reorder(ids);
		}
		async function editor(item, entry) {
			// 先占位再请 Main 暂缓派发这一条，连续点击只进入一次；已发出或正在插话时不进入编辑。
			if (editing) return;
			editing = item.id;
			if (!(await actions.hold(item.id))) {
				editing = undefined;
				return;
			}
			if (editing !== item.id || !rows.has(item.id) || !entry.row.isConnected) {
				if (editing === item.id) editing = undefined;
				return void actions.hold();
			}
			const form = element("form", "queue-editor");
			const field = element("textarea");
			field.value = item.input;
			field.maxLength = 16000;
			field.rows = 3;
			field.setAttribute("aria-label", "编辑排队消息");
			let kept = [...item.attachments];
			const files = element("div", "queue-editor-files");
			const showFiles = () =>
				files.replaceChildren(
					...kept.map((ref) => {
						const chip = element("span", "file-chip", ref.name);
						const remove = button(
							"",
							() => {
								kept = kept.filter(({ id }) => id !== ref.id);
								showFiles();
								field.focus();
							},
							"chip-remove",
						);
						remove.setAttribute("aria-label", `移除 ${ref.name}`);
						remove.title = remove.getAttribute("aria-label");
						remove.append(icon("panel-close"));
						chip.append(remove);
						return chip;
					}),
				);
			showFiles();
			const close = () => {
				editing = undefined;
				actions.hold();
				form.replaceWith(entry.row);
				entry.signature = "";
				update();
				entry.row.querySelector(".queue-edit")?.focus();
			};
			const save = button("保存", () => form.requestSubmit(), "primary");
			save.type = "submit";
			const cancel = button("取消", close, "secondary");
			const footer = element("div", "queue-editor-actions");
			footer.append(cancel, save);
			form.append(field, files, footer);
			form.addEventListener("submit", async (event) => {
				event.preventDefault();
				if (!field.value.trim()) return field.focus();
				if (
					await actions.edit(
						item.id,
						field.value,
						kept.map(({ id }) => id),
					)
				)
					close();
			});
			field.addEventListener("keydown", (event) => {
				if (event.isComposing || event.keyCode === 229) return;
				if (event.key === "Escape") {
					event.preventDefault();
					close();
				} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					form.requestSubmit();
				}
			});
			entry.row.replaceWith(form);
			field.focus();
			field.setSelectionRange(field.value.length, field.value.length);
		}
		function row(item) {
			let entry = rows.get(item.id);
			if (!entry) {
				const node = element("li", "queue-item");
				node.dataset.id = item.id;
				node.draggable = true;
				const grip = icon("grip");
				grip.classList.add("queue-grip");
				const text = element("span", "queue-text");
				const files = element("span", "queue-files");
				const steering = element("span", "queue-steering", "插话中…");
				const steer = button("插话", () => actions.steer(item.id), "quiet queue-steer");
				steer.title = "在当前这一步结束后送入正在进行的回复";
				const edit = button("", () => void editor(entry.item, entry), "quiet icon-button queue-edit");
				edit.setAttribute("aria-label", "编辑");
				edit.title = "编辑";
				edit.append(icon("pencil"));
				const remove = button("", () => actions.remove(item.id), "quiet icon-button");
				remove.setAttribute("aria-label", "删除");
				remove.title = "删除";
				remove.append(icon("trash"));
				const more = button(
					"",
					() => actions.menu(entry.item.id, more, items.indexOf(entry.item), items.length),
					"quiet icon-button",
				);
				more.setAttribute("aria-label", "更多操作");
				more.setAttribute("aria-haspopup", "menu");
				more.title = "更多操作";
				more.append(icon("more"));
				node.append(grip, text, files, steering, steer, edit, remove, more);
				// Alt + ↑/↓ 在键盘上调整顺序，与拖动等效。
				node.addEventListener("keydown", (event) => {
					if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
					event.preventDefault();
					move(entry.item.id, event.key === "ArrowUp" ? -1 : 1);
				});
				entry = { row: node, text, files, steering, steer, edit, remove, more, signature: "" };
				rows.set(item.id, entry);
			}
			entry.item = item;
			return entry;
		}
		function update(
			view = { items, paused: root.dataset.paused === "true", steerable: root.dataset.steerable === "true" },
		) {
			items = view.items ?? [];
			root.hidden = !items.length;
			root.dataset.paused = String(Boolean(view.paused));
			root.dataset.steerable = String(Boolean(view.steerable));
			title.textContent = `排队 ${items.length} 条`;
			paused.hidden = resume.hidden = !view.paused;
			for (const id of rows.keys()) if (!items.some((item) => item.id === id)) rows.delete(id);
			if (editing && !rows.has(editing)) editing = undefined;
			const nodes = items.map((item, index) => {
				const entry = row(item);
				const signature = JSON.stringify([item, view.steerable, index, items.length]);
				if (entry.signature !== signature) {
					entry.signature = signature;
					const first = item.input.trim().split(/\r?\n/)[0];
					entry.text.textContent = first;
					entry.row.title = item.input;
					entry.files.replaceChildren(
						...(item.attachments.length ? [icon("clip"), document.createTextNode(String(item.attachments.length))] : []),
					);
					entry.files.hidden = !item.attachments.length;
					entry.files.title = item.attachments.map(({ name }) => name).join("、");
					entry.steering.hidden = !item.steering;
					entry.steer.hidden = item.steering || !view.steerable;
					for (const control of [entry.edit, entry.remove, entry.more]) control.disabled = item.steering;
					entry.row.draggable = !item.steering;
					entry.row.dataset.steering = String(Boolean(item.steering));
				}
				// 正在编辑的行保留输入框，不被状态推送替换。
				return editing === item.id ? (entry.row.isConnected ? entry.row : list.querySelector(".queue-editor")) : entry.row;
			});
			let cursor = list.firstElementChild;
			for (const node of nodes) {
				if (!node) continue;
				if (node !== cursor) list.insertBefore(node, cursor);
				cursor = node.nextElementSibling;
			}
			while (cursor) {
				const next = cursor.nextElementSibling;
				cursor.remove();
				cursor = next;
			}
		}

		list.addEventListener("dragstart", (event) => {
			const node = event.target.closest?.(".queue-item");
			if (!node) return;
			dragged = node.dataset.id;
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("application/x-flower-queue", dragged);
			node.toggleAttribute("data-dragging", true);
		});
		list.addEventListener("dragover", (event) => {
			if (!dragged) return;
			event.preventDefault();
			const target = event.target.closest?.(".queue-item");
			for (const node of list.querySelectorAll("[data-drop]")) if (node !== target) node.removeAttribute("data-drop");
			if (!target || target.dataset.id === dragged) return;
			const box = target.getBoundingClientRect();
			target.dataset.drop = event.clientY < box.top + box.height / 2 ? "before" : "after";
		});
		list.addEventListener("drop", (event) => {
			if (!dragged) return;
			event.preventDefault();
			const target = list.querySelector("[data-drop]");
			if (target) {
				const ids = items.map(({ id }) => id).filter((id) => id !== dragged);
				const index = ids.indexOf(target.dataset.id) + (target.dataset.drop === "after" ? 1 : 0);
				ids.splice(index, 0, dragged);
				reorder(ids);
			}
		});
		list.addEventListener("dragend", () => {
			dragged = undefined;
			for (const node of list.querySelectorAll("[data-drop], [data-dragging]")) {
				node.removeAttribute("data-drop");
				node.removeAttribute("data-dragging");
			}
		});
		update.move = move;
		return update;
	}

	/**
	 * 把选中文字转为 Markdown 引用块并插入到光标处，前后留空行，光标停在引用之后。
	 * @param {string} value 输入框原文
	 * @param {number} start 选区起点
	 * @param {number} end 选区终点
	 * @param {string} text 被引用的文字
	 * @param {number} limit 输入框字数上限
	 * @returns {{value: string, caret: number} | undefined} 插入后的内容与光标；超出上限时为 undefined
	 */
	function quoteInsertion(value, start, end, text, limit) {
		const block = text
			.replace(/\r\n?/g, "\n")
			.trim()
			.split("\n")
			.map((line) => (line ? `> ${line}` : ">"))
			.join("\n");
		const before = value.slice(0, start);
		const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
		const insert = `${lead}${block}\n\n`;
		const next = before + insert + value.slice(end);
		if (next.length > limit) return;
		return { value: next, caret: before.length + insert.length };
	}

	/**
	 * 回复选区工具条：选区完全位于同一条回复的正文内时，在选区末端上方显示「引用」「侧边追问」。
	 * @param {HTMLElement} scroll 会话滚动区域
	 * @param {HTMLElement} toolbar 工具条，按钮带 data-selection="quote|side"
	 * @param {{quote(text: string): void, side(text: string): void}} actions 引用与侧边追问
	 * @returns {{current(): {text: string} | undefined}} 当前有效的回复选区
	 */
	function selectionActions(scroll, toolbar, actions) {
		let frame = 0;
		let picked;
		function current() {
			const selection = document.getSelection();
			if (!selection || selection.isCollapsed || !selection.rangeCount) return;
			const range = selection.getRangeAt(0);
			const holder = (node) =>
				(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(".markdown-reply");
			const start = holder(range.startContainer);
			const end = holder(range.endContainer);
			const reply = start?.closest(".assistant-message");
			if (!end || !reply || reply !== end.closest(".assistant-message") || !scroll.contains(reply)) return;
			const text = selection.toString().trim();
			return text ? { text, range } : undefined;
		}
		function hide() {
			toolbar.hidden = true;
			picked = undefined;
		}
		function sync() {
			frame = 0;
			picked = current();
			if (!picked || scroll.hidden) return hide();
			const rects = picked.range.getClientRects();
			const last = rects[rects.length - 1] ?? picked.range.getBoundingClientRect();
			const area = scroll.getBoundingClientRect();
			// 选区末端已滚出会话区时不显示，避免工具条浮在输入区或标题栏上。
			if (last.bottom < area.top || last.top > area.bottom) return hide();
			toolbar.hidden = false;
			const above = last.top - toolbar.offsetHeight - 6;
			const top = above >= area.top ? above : Math.min(last.bottom + 6, area.bottom - toolbar.offsetHeight);
			const left = Math.min(
				Math.max(area.left + 6, last.right - toolbar.offsetWidth / 2),
				area.right - toolbar.offsetWidth - 6,
			);
			toolbar.style.top = `${top}px`;
			toolbar.style.left = `${left}px`;
		}
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(sync);
		};
		document.addEventListener("selectionchange", schedule);
		scroll.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		// 按下按钮时保留选区。
		toolbar.addEventListener("mousedown", (event) => event.preventDefault());
		toolbar.addEventListener("click", (event) => {
			const choice = event.target.closest("[data-selection]")?.dataset.selection;
			if (!choice || !picked) return;
			const { text } = picked;
			document.getSelection()?.removeAllRanges();
			hide();
			actions[choice]?.(text);
		});
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !toolbar.hidden) hide();
		});
		return { current };
	}

	/**
	 * 取光标前正在输入的 @ 查询：@ 位于行首或空白之后，查询中不含空白与 @。
	 * @param {string} value 输入框原文
	 * @param {number} caret 光标位置
	 * @returns {{start: number, query: string} | undefined} @ 的位置与查询
	 */
	function mentionQuery(value, caret) {
		const match = /(^|\s)@([^\s@]{0,80})$/.exec(value.slice(0, caret));
		if (!match) return;
		return { start: caret - match[2].length - 1, query: match[2] };
	}

	/**
	 * 输入框 @ 补全工作区文件。列表打开时方向键、Enter、Tab 与 Esc 由补全处理，不触发历史召回与发送；输入法组合中不触发。
	 * @param {HTMLTextAreaElement} input 输入框
	 * @param {HTMLElement} list 候选列表
	 * @param {{search(query: string): Promise<string[] | undefined>, pick(path: string): void}} actions 查询与选中
	 * @returns {{close(): void}} 关闭列表
	 */
	function mentionPicker(input, list, actions) {
		let composing = false;
		let current;
		let options = [];
		let active = -1;
		let stamp = 0;
		let timer;
		window.flowerUI.softScroll(list);
		input.setAttribute("aria-autocomplete", "list");
		input.setAttribute("aria-controls", list.id);
		input.setAttribute("aria-expanded", "false");
		function close() {
			clearTimeout(timer);
			stamp++;
			current = undefined;
			options = [];
			active = -1;
			list.hidden = true;
			list.replaceChildren();
			input.setAttribute("aria-expanded", "false");
			input.removeAttribute("aria-activedescendant");
		}
		function highlight(index) {
			active = index;
			for (const [position, node] of [...list.children].entries())
				node.setAttribute("aria-selected", String(position === index));
			const node = list.children[index];
			if (!node) return input.removeAttribute("aria-activedescendant");
			input.setAttribute("aria-activedescendant", node.id);
			node.scrollIntoView({ block: "nearest" });
		}
		function show(paths) {
			if (!paths) return close();
			options = paths;
			list.hidden = false;
			input.setAttribute("aria-expanded", "true");
			list.replaceChildren(
				...(paths.length
					? paths.map((path, index) => {
							const slash = path.lastIndexOf("/");
							const option = element("div", "mention-option");
							option.id = `mention-option-${index}`;
							option.setAttribute("role", "option");
							option.title = path;
							option.append(
								element("span", "mention-name", path.slice(slash + 1)),
								element("span", "mention-path", slash > 0 ? path.slice(0, slash) : ""),
							);
							return option;
						})
					: [element("div", "mention-empty", "没有匹配的文件")]),
			);
			highlight(paths.length ? 0 : -1);
		}
		function refresh() {
			if (composing) return;
			const next = input.selectionStart === input.selectionEnd && mentionQuery(input.value, input.selectionStart);
			if (!next) return close();
			current = next;
			clearTimeout(timer);
			const ticket = ++stamp;
			// 连续输入时合并查询，迟到的结果按序号丢弃。
			timer = setTimeout(async () => {
				let paths;
				try {
					paths = await actions.search(next.query);
				} catch {
					paths = [];
				}
				if (ticket === stamp) show(paths);
			}, 120);
		}
		function choose(index) {
			const path = options[index];
			if (!path || !current) return;
			const { start } = current;
			input.value = input.value.slice(0, start) + input.value.slice(input.selectionStart);
			input.setSelectionRange(start, start);
			close();
			input.dispatchEvent(new Event("input", { bubbles: true }));
			actions.pick(path);
		}
		input.addEventListener("input", refresh);
		input.addEventListener("compositionstart", () => {
			composing = true;
			close();
		});
		input.addEventListener("compositionend", () => {
			composing = false;
			refresh();
		});
		input.addEventListener("blur", close);
		input.addEventListener("keyup", (event) => {
			if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) refresh();
		});
		// 捕获阶段先于输入框的普通按键监听执行，列表打开时截获导航与确认键。
		input.addEventListener(
			"keydown",
			(event) => {
				if (list.hidden || event.isComposing || composing || event.keyCode === 229) return;
				const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
				const confirm = (event.key === "Enter" || event.key === "Tab") && !event.shiftKey;
				if (step === undefined && !confirm && event.key !== "Escape") return;
				event.preventDefault();
				event.stopImmediatePropagation();
				if (step !== undefined) {
					if (options.length) highlight((active + step + options.length) % options.length);
				} else if (confirm && options.length) choose(active);
				else close();
			},
			{ capture: true },
		);
		list.addEventListener("mousedown", (event) => event.preventDefault());
		list.addEventListener("click", (event) => {
			const option = event.target.closest(".mention-option");
			if (option) choose([...list.children].indexOf(option));
		});
		return { close };
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
		// 未完成请求的回复正文不进入模型上下文（只保留工具回执），可以原样重试，或放回输入框修改后再发。
		const retry = button("重试", () => actions.retry(id), "quiet retry-task");
		const edit = button("编辑", () => actions.edit(id), "quiet retry-task");
		head.append(mark("small"), element("h2", "", "Flower"), status, cancel, retry, edit, copy);
		// 推理只是运行中的瞬时提示，单独成行避免挤压状态与操作按钮。
		const thought = element("p", "reasoning-preview");
		thought.setAttribute("aria-live", "polite");
		const text = element("div", "message-text markdown-reply");
		const markdown = window.flowerMarkdown.view(text, actions.openLink, actions.paths);
		// 每条插话后接一段回复正文，按送达时的正文位置切分。
		const segments = [];
		function showSteers(steers, full) {
			const cuts = steers.map(({ textOffset }) => Math.min(Math.max(0, textOffset ?? full.length), full.length));
			markdown.update(full.slice(0, cuts[0] ?? full.length));
			while (segments.length < steers.length) {
				const bubble = element("div", "steer-message");
				const words = element("p", "steer-text");
				const files = element("div", "message-file file-chips");
				const showFiles = window.flowerAttachments.view(files, undefined, id, actions.previewAttachment);
				bubble.append(element("span", "steer-label", "插话"), words, files);
				const body = element("div", "message-text markdown-reply");
				const view = window.flowerMarkdown.view(body, actions.openLink, actions.paths);
				(segments.at(-1)?.body ?? text).after(bubble, body);
				segments.push({ bubble, words, showFiles, body, view });
			}
			while (segments.length > steers.length) {
				const last = segments.pop();
				last.showFiles.dispose();
				last.bubble.remove();
				last.body.remove();
			}
			for (const [index, steer] of steers.entries()) {
				const segment = segments[index];
				if (segment.words.textContent !== steer.input) segment.words.textContent = steer.input;
				segment.showFiles(steer.attachments ?? []);
				const part = full.slice(cuts[index], cuts[index + 1] ?? full.length);
				segment.view.update(part);
				segment.body.hidden = !part;
			}
		}
		const failure = element("p", "message-text message-error");
		const steps = toolSteps();
		const deliveries = deliverables((path) => actions.open(id, path), actions.preview, actions.paths?.menu);
		reply.append(head, thought, steps.node, text, failure, deliveries.node);
		// 最近一次压缩落在本轮之前或之后时显示分隔。
		const [compactedBefore, compactedAfter] = [0, 1].map(() => {
			const divider = element("p", "compaction-divider", "以上对话已压缩为摘要");
			divider.setAttribute("role", "separator");
			divider.hidden = true;
			return divider;
		});
		node.append(compactedBefore, prompt, reply, compactedAfter);
		return {
			node,
			reply: text,
			dispose() {
				showFiles.dispose();
				for (const segment of segments) segment.showFiles.dispose();
			},
			update(next) {
				record = next;
				node.dataset.status = record.status;
				compactedBefore.hidden = !record.compactedBefore;
				compactedAfter.hidden = !record.compactedAfter;
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
				const retryText = record.status === "interrupted" ? "继续任务" : "重试";
				if (retry.textContent !== retryText) retry.textContent = retryText;
				copyInput.hidden = !record.input;
				copy.hidden = !record.text || !record.status || ["queued", "running", "cancelling"].includes(record.status);
				showSteers(record.steers ?? [], record.text ?? "");
				failure.hidden = !record.failure;
				if (failure.textContent !== (record.failure ?? "")) failure.textContent = record.failure ?? "";
				steps.update(record.steps ?? [], record);
				deliveries.update(record.artifacts ?? []);
			},
		};
	}

	/** 把一轮滚到会话区顶部附近，减弱动效时直接跳转。@param {HTMLElement} scroll 滚动区域 @param {HTMLElement} node 该轮节点 @returns {void} */
	function scrollToTurn(scroll, node) {
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const top = scroll.scrollTop + node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
		scroll.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
	}

	let flashTimer;
	/**
	 * 短暂高亮该轮中的关键词约 2 秒；关键词被格式拆开找不到时，整轮短暂提示。
	 * @param {HTMLElement} node 该轮节点
	 * @param {string} query 关键词
	 * @returns {void}
	 */
	function flashTurn(node, query) {
		const needle = query?.toLocaleLowerCase();
		const ranges = [];
		if (needle && window.CSS?.highlights) {
			const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
			for (let text = walker.nextNode(); text; text = walker.nextNode()) {
				const value = text.nodeValue.toLocaleLowerCase();
				if (value.length !== text.nodeValue.length) continue;
				for (let index = value.indexOf(needle); index >= 0; index = value.indexOf(needle, index + needle.length)) {
					const range = new Range();
					range.setStart(text, index);
					range.setEnd(text, index + needle.length);
					ranges.push(range);
				}
			}
		}
		clearTimeout(flashTimer);
		window.CSS?.highlights?.delete("flower-search");
		if (ranges.length) window.CSS.highlights.set("flower-search", new Highlight(...ranges));
		else {
			node.removeAttribute("data-located");
			void node.offsetWidth;
			node.toggleAttribute("data-located", true);
		}
		flashTimer = setTimeout(() => {
			window.CSS?.highlights?.delete("flower-search");
			node.removeAttribute("data-located");
		}, 2000);
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
			if (node) scrollToTurn(scroll, node);
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
			// 导航条覆盖滚动区域的可视高度；刻度中线固定离会话区左缘 20 像素，宽窗留白再大也贴边，不悬在空白中间。
			nav.style.top = `${scroll.offsetTop}px`;
			nav.style.height = `${scroll.clientHeight}px`;
			nav.style.left = `${scroll.offsetLeft + 20}px`;
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
			/**
			 * 跳到某轮并短暂高亮关键词，覆盖切换会话时待恢复的阅读位置。
			 * @param {string} requestId 请求 ID
			 * @param {string} [query] 关键词
			 * @returns {boolean} 该轮已渲染时为 true
			 */
			reveal(requestId, query) {
				const view = views.get(requestId);
				if (!view) return false;
				pending = undefined;
				scrollToTurn(scroll, view.node);
				flashTurn(view.node, query);
				return true;
			},
		};
	}

	return {
		sessionList,
		bindComposer,
		thread,
		inputRecall,
		navigatorTurn,
		turnPreview,
		queueBar,
		quoteInsertion,
		selectionActions,
		mentionQuery,
		mentionPicker,
	};
})();
