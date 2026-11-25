(() => {
	const labels = {
		queued: "排队中",
		running: "运行中",
		cancelling: "正在取消",
		paused: "排队已暂停",
		starting: "正在准备",
		"waiting-model": "等待模型",
		"waiting-answer": "待回答",
		"waiting-write": "待批准",
		succeeded: "已完成",
		failed: "失败",
		denied: "已拒绝",
		cancelled: "已取消",
		interrupted: "已中断",
		missed: "已错过",
	};
	const actions = new Set(["running", "starting", "queued", "waiting-model", "waiting-answer", "waiting-write"]);
	const timestamp = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

	/**
	 * 显示来自真实会话和自动化的后台任务。
	 * @param host 工作台受限接口
	 * @param root 右栏任务面板
	 * @returns 显隐和刷新入口
	 */
	function createBackgroundTasks(host, root) {
		const { button, element, icon, feedback, softScroll } = window.flowerUI;
		const header = element("header", "background-heading");
		const heading = element("h3", "", "后台任务");
		const list = element("ul", "background-list");
		const note = element("p", "feedback");
		note.setAttribute("role", "status");
		let visible = false;
		let revision = 0;
		let timer;
		let busy = false;
		let changed = false;
		let target;
		const refresh = button("", () => void load(), "icon-button");
		refresh.append(icon("reset"));
		refresh.title = "刷新后台任务";
		refresh.setAttribute("aria-label", refresh.title);
		header.append(heading, refresh);
		root.replaceChildren(header, note, list);
		softScroll(root);

		function append(task) {
			const item = element("li", "background-row");
			item.dataset.status = task.status;
			item.dataset.task = task.id;
			const body = element("div", "background-copy");
			const controls = element("div", "background-actions");
			const open = task.session
				? button(
						task.title || task.input,
						async () => {
							try {
								await host.selectSession(task.session);
							} catch {
								feedback(note, "这条任务关联的会话已移除，请刷新列表。", "error");
							}
						},
						"quiet background-open",
					)
				: element("strong", "", task.title || task.input);
			const state = element("span", "background-state", labels[task.status] ?? task.status);
			const details = element("small", "", task.workspace);
			if (task.path) details.title = task.path;
			if (task.at) {
				const time = new Date(task.at);
				if (Number.isFinite(time.getTime())) details.append(` · ${timestamp.format(time)}`);
			}
			body.append(open, details);
			if (task.input && task.title !== task.input) body.append(element("p", "", task.input));
			if (task.progress && actions.has(task.status)) body.append(element("p", "", task.progress));
			if (task.result) body.append(element("p", "background-result", task.result));
			controls.append(state);
			if (task.cancellable && actions.has(task.status)) {
				const cancel = button(
					"取消",
					async () => {
						cancel.disabled = true;
						try {
							if (task.automation) await host.cancelAutomation(task.id);
							else await host.cancelBackgroundTask(task.session, task.id);
							refreshSoon();
						} catch {
							cancel.disabled = false;
							feedback(note, "任务状态已变化，请刷新后重试。", "error");
						}
					},
					"quiet",
				);
				cancel.setAttribute("aria-label", `取消任务：${task.title || task.input}`);
				controls.append(cancel);
			}
			item.append(body, controls);
			list.append(item);
			if (task.id === target) {
				target = undefined;
				item.scrollIntoView({ block: "nearest" });
				if (task.session) open.focus({ preventScroll: true });
			}
		}

		async function load() {
			if (!visible) return;
			if (busy) {
				changed = true;
				return;
			}
			const stamp = ++revision;
			busy = true;
			try {
				const rows = await host.backgroundTasks();
				if (stamp !== revision) return;
				const focused = document.activeElement?.closest("[data-task]")?.dataset.task;
				list.replaceChildren();
				feedback(note, rows.length ? "" : "任务开始后会显示在这里。");
				for (const task of rows) append(task);
				if (focused && document.activeElement === document.body) {
					Array.from(list.children)
						.find((item) => item.dataset.task === focused)
						?.querySelector("button")
						?.focus({ preventScroll: true });
				}
			} catch {
				if (stamp === revision) feedback(note, "暂时无法读取后台任务，请刷新后重试。", "error");
			} finally {
				busy = false;
				if (changed) {
					changed = false;
					refreshSoon();
				}
			}
		}

		function refreshSoon() {
			if (visible && !timer)
				timer = setTimeout(() => {
					timer = undefined;
					void load();
				}, 140);
		}

		return {
			show(id) {
				visible = true;
				if (id) target = id;
				void load();
			},
			hide() {
				if (!visible) return;
				visible = false;
				target = undefined;
				revision++;
				clearTimeout(timer);
				timer = undefined;
			},
			refresh: refreshSoon,
		};
	}

	window.createBackgroundTasks = createBackgroundTasks;
})();
