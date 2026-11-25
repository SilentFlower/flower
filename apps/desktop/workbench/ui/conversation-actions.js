window.flowerConversationActions = (() => {
	const by = (id) => document.getElementById(id);
	const { element, feedback, icon, softScroll } = window.flowerUI;
	const modes = {
		edit: ["编辑重发", "发送修改后的任务"],
		rewind: ["回到此处", "回到此处"],
		fork: ["从此处分叉", "创建分叉"],
	};
	const fileStates = {
		ready: "可撤销",
		changed: "已修改，将保留",
		missing: "文件已不在原处",
		undone: "已撤销",
		legacy: "已有产物",
	};

	function revisionFile({ path, status }) {
		const row = element("li", "tier3-file");
		const details = element("details");
		const summary = element("summary", "tier3-file-summary");
		summary.title = path;
		const boundary = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
		const label = element("span", "tier3-file-label");
		const name = path.slice(boundary + 1);
		label.append(
			element("strong", "tier3-file-name", name),
			element("small", "tier3-file-directory", boundary < 0 ? "工作区根目录" : path.slice(0, boundary)),
		);
		const hint = element("span", "tier3-file-hint");
		hint.append(element("small", "tier3-file-state", fileStates[status] ?? ""), icon("chevron"));
		summary.append(label, hint);
		const fullPath = element("p", "tier3-file-full-path", path);
		details.append(summary, fullPath);
		row.append(details);
		return row;
	}

	function imageText({ role, text }) {
		if (role !== "Flower") return text;
		const box = element("div");
		window.flowerMarkdown.view(box, () => {}).update(text);
		if (!box.children.length) return box.textContent;
		return [...box.children]
			.map((block) => {
				if (block.matches("ul,ol"))
					return [...block.children]
						.map((item, index) => (block.tagName === "UL" ? "• " : `${index + 1}. `) + item.textContent)
						.join("\n");
				if (block.matches(".markdown-table-scroll,table"))
					return [...block.querySelectorAll("tr")]
						.map((row) => [...row.cells].map((cell) => cell.textContent).join("  |  "))
						.join("\n");
				return block.textContent.trim();
			})
			.join("\n\n");
	}

	function lines(context, value, width) {
		const out = [];
		for (const paragraph of value.split("\n")) {
			let line = "";
			const words = paragraph.match(/\s+|[\p{Script=Han}]|[^\s\p{Script=Han}]+/gu) ?? [];
			for (const word of words) {
				if (context.measureText(line + word).width <= width) {
					line += word;
				} else if (context.measureText(word).width <= width) {
					out.push(line);
					line = word.trimStart();
				} else {
					for (const char of word) {
						if (context.measureText(line + char).width > width) {
							out.push(line);
							line = "";
						}
						line += char;
					}
				}
			}
			out.push(line);
		}
		return out;
	}

	async function imageBytes({ title, segments }) {
		if (segments.reduce((size, row) => size + row.text.length, 0) > 45000) throw new Error("所选消息过长，请减少选择。");
		await document.fonts.ready;
		const css = getComputedStyle(document.documentElement);
		const color = (key) => css.getPropertyValue(key).trim();
		const family = getComputedStyle(by("prompt")).fontFamily;
		const canvas = element("canvas");
		const context = canvas.getContext("2d");
		const width = 960;
		const font = (size, weight = 400) => (context.font = `${weight} ${size}px ${family}`);
		font(32, 700);
		const headings = lines(context, title, 864);
		font(21);
		const cards = segments.map((row) => {
			const contents = [imageText(row), ...(row.names.length ? [`附件：${row.names.join("、")}`] : [])].join("\n");
			const rows = lines(context, contents, 820);
			return { role: row.role, rows, height: 52 + 32 * rows.length };
		});
		const height = 112 + headings.length * 46 + cards.reduce((sum, row) => sum + row.height + 14, 0);
		if (height > 12000) throw new Error("复制图片的长度超出上限，请减少选择。");
		canvas.width = width;
		canvas.height = height;
		context.textBaseline = "top";
		context.fillStyle = color("--canvas");
		context.fillRect(0, 0, width, height);
		context.fillStyle = color("--accent");
		font(19, 650);
		context.fillText("Flower Desktop", 42, 39);
		context.fillStyle = color("--ink");
		font(32, 700);
		for (const [index, line] of headings.entries()) context.fillText(line, 42, 68 + 46 * index);
		let top = 94 + headings.length * 46;
		for (const card of cards) {
			context.fillStyle = color(card.role === "Flower" ? "--surface" : "--wash");
			context.beginPath();
			context.roundRect(42, top, 876, card.height, 14);
			context.fill();
			context.fillStyle = color(card.role === "Flower" ? "--accent" : "--muted");
			font(16, 680);
			context.fillText(card.role, 63, top + 14);
			context.fillStyle = color("--ink");
			font(21);
			for (const [index, line] of card.rows.entries()) context.fillText(line, 63, top + 40 + 32 * index);
			top += card.height + 14;
		}
		const image = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
		if (!image) throw new Error("无法生成消息图片。");
		return new Uint8Array(await image.arrayBuffer());
	}

	/** 接通会话导出、修订和更新设置。
	 * @param options 当前会话、草稿恢复及工作台反馈接口
	 * @returns 时间线使用的菜单及选择同步入口
	 */
	function mount({ ui, getSession, showMenu, menuNavigation, notify, restoreDraft }) {
		const menu = by("conversation-actions");
		const share = by("conversation-actions-open");
		const timeline = by("timeline");
		const selection = by("conversation-selection");
		const shareCopy = by("conversation-selection-copy");
		const revisionMenu = by("turn-revision-menu");
		const revisionDialog = by("turn-revision");
		const revisionApply = by("turn-revision-apply");
		const revisionInput = by("turn-revision-input");
		const revisionCancel = by("turn-revision-cancel");
		const revisionFiles = by("turn-revision-files");
		const revisionFeedback = by("turn-revision-feedback");
		let selectionSession;
		let selecting = false;
		let copying = false;
		let revision;
		let revisionBusy = false;
		let opener;
		const report = (error) =>
			error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") ?? "操作未完成。";
		softScroll(by("turn-revision-scroll"));
		softScroll(by("desktop-update-scroll"));

		function checked() {
			return [...timeline.querySelectorAll(".tier3-select-message:not([hidden]) input:checked")].map((entry) => ({
				requestId: entry.closest("[data-request]").dataset.request,
				kind: entry.dataset.kind,
				index: Number(entry.dataset.index),
			}));
		}

		function syncSelection() {
			const length = checked().length;
			by("conversation-selection-count").textContent = `已选 ${length} 条`;
			shareCopy.disabled = !length || length > 30 || copying;
		}

		function selectMessages(enabled) {
			selecting = enabled;
			timeline.toggleAttribute("data-capture", enabled);
			selection.hidden = !enabled;
			if (!enabled)
				for (const entry of timeline.querySelectorAll(".tier3-select-message input:checked")) entry.checked = false;
			syncSelection();
		}

		share.addEventListener("click", () => showMenu(menu, share));
		menu.addEventListener("keydown", menuNavigation);
		menu.addEventListener("click", async (event) => {
			const operation = event.target.closest("button")?.dataset.share;
			if (!operation) return;
			menu.hidePopover();
			const session = getSession();
			try {
				if (operation === "image") {
					selectMessages(true);
					timeline.querySelector(".tier3-select-message:not([hidden]) input")?.focus();
				} else if (operation === "markdown") {
					await ui.copySessionMarkdown(session);
					notify("已复制会话 Markdown。");
				} else if (await ui.exportSessionHtml(session)) notify("已保存会话 HTML。");
			} catch (error) {
				notify(report(error), { tone: "error" });
			}
		});
		timeline.addEventListener("change", (event) => {
			if (event.target.matches(".tier3-select-message input")) syncSelection();
		});
		by("conversation-selection-cancel").addEventListener("click", () => {
			selectMessages(false);
			share.focus();
		});
		shareCopy.addEventListener("click", async () => {
			const session = getSession();
			copying = true;
			syncSelection();
			try {
				const data = await ui.sessionImageContent(session, checked());
				const png = await imageBytes(data);
				if (session !== getSession() || !selecting) return;
				await ui.copySessionImage(session, png);
				selectMessages(false);
				share.focus();
				notify("已复制所选消息图片。");
			} catch (error) {
				notify(report(error), { tone: "error" });
			} finally {
				copying = false;
				syncSelection();
			}
		});

		revisionMenu.addEventListener("keydown", menuNavigation);
		revisionMenu.addEventListener("click", async (event) => {
			const mode = event.target.closest("button")?.dataset.revision;
			if (!modes[mode] || !revision || revisionBusy) return;
			const current = { ...revision, mode };
			revision = current;
			revisionMenu.hidePopover();
			try {
				const plan = await ui.sessionRevisionPreview(current.session, current.requestId, mode);
				if (getSession() !== current.session || revision !== current) return;
				current.plan = plan;
				by("turn-revision-title").textContent = modes[mode][0];
				by("turn-revision-session").textContent = plan.title;
				by("turn-revision-edit").hidden = mode !== "edit";
				revisionInput.value = mode === "edit" ? plan.input : "";
				revisionInput.required = mode === "edit";
				revisionFiles.hidden = !plan.fileCount;
				revisionFiles.replaceChildren(...plan.files.map(revisionFile));
				if (plan.fileCount > plan.files.length)
					revisionFiles.append(element("li", "", `共 ${plan.fileCount} 个涉及文件。`));
				const start = mode === "edit" && !plan.retained ? "从修改后的提问开始。" : `保留前 ${plan.retained} 轮作为上下文。`;
				const history = `${start}原来的 ${plan.retained + plan.excluded} 轮对话将保留。`;
				by("turn-revision-impact").textContent = plan.fileCount ? `${history} 默认保留工作区文件。` : history;
				by("turn-revision-undo-row").hidden = !plan.canUndo;
				by("turn-revision-undo").checked = false;
				revisionApply.textContent = modes[mode][1];
				feedback(revisionFeedback, "");
				revisionDialog.showModal();
				(mode === "edit" ? revisionInput : revisionCancel).focus();
			} catch (error) {
				notify(report(error), { tone: "error" });
			}
		});
		revisionCancel.addEventListener("click", () => revisionDialog.close());
		revisionDialog.addEventListener("cancel", (event) => {
			if (revisionBusy) event.preventDefault();
		});
		revisionDialog.addEventListener("close", () => {
			if (opener?.isConnected && document.activeElement !== by("prompt")) opener.focus();
		});
		by("turn-revision-form").addEventListener("submit", async (event) => {
			event.preventDefault();
			if (!revision?.plan || revisionBusy) return;
			const { session, requestId, mode, plan } = revision;
			revisionBusy = revisionApply.disabled = revisionCancel.disabled = true;
			try {
				const result = await ui.applySessionRevision(
					session,
					requestId,
					mode,
					plan.revision,
					revisionInput.value,
					by("turn-revision-undo").checked
						? plan.files.filter(({ status }) => status === "ready").map(({ path }) => path)
						: [],
				);
				opener = undefined;
				revisionDialog.close();
				if (result.draft) {
					restoreDraft(result.id, result.draft);
					notify("发送失败，修改内容已放回草稿。", { tone: "error" });
				} else if (result.undone || result.unresolved) {
					notify(`已撤销 ${result.undone} 个文件，${result.unresolved} 项需在原会话核对。`);
				} else notify(mode === "edit" ? "已在新会话重发。" : `已${modes[mode][0]}。`);
			} catch (error) {
				feedback(revisionFeedback, report(error), "error");
			} finally {
				revisionBusy = revisionApply.disabled = revisionCancel.disabled = false;
			}
		});

		const syncUpdate = mountUpdate({ ui, report });
		return {
			syncUpdate,
			sync(session, available) {
				share.hidden = !available;
				if (selectionSession !== session || (selecting && !available)) {
					selectionSession = session;
					selectMessages(false);
				} else if (selecting) syncSelection();
			},
			openRevision(requestId, trigger) {
				const session = getSession();
				if (!session) return;
				opener = trigger;
				revision = { session, requestId };
				showMenu(revisionMenu, trigger);
			},
		};
	}

	function mountUpdate({ ui, report }) {
		const panel = by("desktop-update");
		const setting = by("settings-update");
		const badge = by("desktop-update-ready");
		const title = by("desktop-update-title");
		const status = by("desktop-update-feedback");
		const current = by("desktop-update-version");
		const candidate = by("desktop-update-candidate");
		const release = by("desktop-update-release");
		const notes = by("desktop-update-notes");
		const transfer = by("desktop-update-transfer");
		const progress = by("desktop-update-progress");
		const scheduleNote = by("desktop-update-schedule-note");
		const check = by("desktop-update-check");
		const schedule = by("desktop-update-schedule");
		const restart = by("desktop-update-restart");
		const descriptions = {
			unavailable: "当前是旧版便携应用。请改用最新版 Flower Desktop 启动器，原有工作台资料会继续使用。",
			idle: "应用会在后台检查并下载更新。",
			checking: "正在检查更新…",
			downloading: "正在后台下载更新。你可以继续使用工作台。",
			ready: "更新已就绪。你可以选择何时安装。",
			current: "当前已是最新版本。",
			unpublished: "当前频道尚未发布更新。",
			error: "更新失败，请重试。",
			installing: "正在安装更新…",
		};
		const percentage = new Intl.NumberFormat("zh-CN", { style: "percent" });
		let state;
		let pending = false;
		let actionError = "";
		const showText = (node, value) => {
			if (node.textContent !== value) node.textContent = value;
		};

		function render() {
			const { phase, currentVersion, version, channel, received, size, scheduled, canRestart, error, installPolicy } =
				state ?? {};
			const nativeExit = installPolicy === "on-exit";
			const ready = phase === "ready";
			badge.hidden = !ready;
			setting.classList.toggle("has-desktop-update", ready);
			if (panel.hidden) return;

			showText(
				current,
				currentVersion ? `当前版本 ${currentVersion} · ${channel === "qa" ? "测试渠道" : "稳定渠道"}` : "",
			);
			const nativeDescription =
				nativeExit && phase === "unavailable" ? "此构建用于本机预演。正式版会在这里检查更新。" : undefined;
			const message = actionError || error || nativeDescription || descriptions[phase] || "正在读取更新状态…";
			feedback(status, message, actionError || error || phase === "error" ? "error" : "neutral");
			candidate.hidden = !version;
			showText(release, version ? `新版本 ${version}` : "");
			notes.hidden = !state?.notes;
			showText(notes, state?.notes ?? "");
			transfer.hidden = phase !== "downloading";
			if (!transfer.hidden) {
				const ratio = Number.isFinite(received) && size > 0 ? Math.max(0, Math.min(1, received / size)) : undefined;
				if (ratio === undefined) progress.removeAttribute("value");
				else progress.value = 100 * ratio;
				by("desktop-update-transfer-label").textContent = ratio === undefined ? "" : percentage.format(ratio);
			}
			check.hidden = (ready && (nativeExit || !error)) || phase === "installing" || phase === "unavailable";
			check.disabled = pending || !phase || phase === "checking" || phase === "downloading";
			check.textContent = error || phase === "error" ? "重试" : "检查更新";
			restart.hidden = !ready;
			schedule.hidden = !ready || nativeExit;
			schedule.disabled = pending;
			restart.disabled = pending || canRestart === false;
			schedule.textContent = scheduled ? "取消退出时更新" : "退出时更新";
			const reminders = [
				nativeExit
					? "正常退出应用后将自动安装。"
					: scheduled &&
						(state.trayAvailable ? "在系统托盘中右键选择「退出 Flower」后安装。" : "已安排在你退出应用时安装。"),
				canRestart === false && "工作台有任务正在处理，结束后可立即重启更新。",
			].filter(Boolean);
			scheduleNote.hidden = !ready || !reminders.length;
			showText(scheduleNote, reminders.join(" "));
			const active = document.activeElement;
			if ([check, schedule, restart].includes(active) && active.hidden) title.focus();
		}

		function sync(next) {
			if (!next?.phase) return;
			state = next;
			render();
		}

		async function run(action) {
			if (pending) return;
			pending = true;
			actionError = "";
			const previous = state;
			render();
			try {
				const result = await action();
				// 命令发出之后的主进程通知可能更新了进度或任务状态，优先采用通知。
				if (state === previous) sync(result);
			} catch (error) {
				actionError = report(error);
			} finally {
				pending = false;
				render();
			}
		}

		panel.addEventListener("managemententer", () => {
			actionError = "";
			render();
			if (!state) void run(() => ui.desktopUpdateState());
		});
		badge.addEventListener("click", () => window.flowerManagement.show("update", badge));
		check.addEventListener("click", () => void run(() => ui.checkDesktopUpdate()));
		restart.addEventListener("click", () => void run(() => ui.restartDesktopUpdate()));
		schedule.addEventListener("click", () => void run(() => ui.scheduleDesktopUpdate(!state?.scheduled)));
		return sync;
	}
	return { mount };
})();
