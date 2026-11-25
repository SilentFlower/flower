window.flowerTurnChanges = (() => {
	const { button, element, feedback, icon } = window.flowerUI;
	const ongoing = new Set(["queued", "running", "cancelling"]);
	const descriptions = {
		ready: "新建 · 可撤销",
		changed: "已变化 · 已保留",
		missing: "原位置已无此文件",
		undone: "已撤销",
		legacy: "旧记录 · 无撤销依据",
	};

	/** 展示请求的实际文件变更，并将预览和撤销交给 Main 校验。
	 * @param {object} actions 检查、撤销和工作区预览操作
	 * @returns {{node: HTMLDetailsElement, update(record: object): void}} 按消息更新的折叠卡
	 */
	function card({ inspect, undo, preview }) {
		const node = element("details", "turn-changes");
		node.hidden = true;
		const header = element("summary", "turn-changes-summary");
		const count = element("span", "turn-changes-count");
		header.append(icon("document"), element("span", "turn-changes-title", "本轮文件变更"), count);
		const content = element("div", "turn-changes-content");
		const list = element("ul", "turn-changes-files");
		const note = element("p", "turn-changes-note");
		note.setAttribute("role", "status");
		let record;
		let version;
		let generation = 0;
		let waiting = false;
		let ready = false;
		let authorized = false;
		const undoButton = button(
			"撤销本轮文件…",
			async () => {
				if (!record || waiting || !ready) return;
				const stamp = ++generation;
				waiting = true;
				sync();
				try {
					const result = await undo(record.requestId);
					if (stamp !== generation || !result) return;
					show(result.files);
					feedback(note, result.undone ? `已撤销 ${result.undone} 个文件。` : "没有可撤销的文件。");
				} catch (error) {
					if (stamp === generation) fail(error);
				} finally {
					if (stamp === generation) {
						waiting = false;
						sync();
						if (undoButton.hidden || undoButton.disabled) header.focus({ preventScroll: true });
					}
				}
			},
			"secondary",
		);
		undoButton.prepend(icon("reset"));
		content.append(list, element("div", "turn-changes-controls"));
		content.lastElementChild.append(undoButton, note);
		node.append(header, content);

		function sync() {
			undoButton.hidden = !ready || !authorized;
			undoButton.disabled = waiting || ongoing.has(record?.status);
		}
		function fail(error) {
			const message = error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "");
			feedback(note, message || "暂时无法处理这轮文件变更。", "error");
		}
		function show(files) {
			count.textContent = files.length ? `${files.length} 个文件` : "";
			ready = files.some(({ status }) => status === "ready");
			list.replaceChildren(
				...files.map(({ path, status, recoveryPath }) => {
					const row = element("li", "turn-changes-file");
					row.dataset.status = status;
					const label = path.slice(path.lastIndexOf("/") + 1);
					const open = typeof preview === "function" && (status === "ready" || status === "legacy");
					const name = open
						? button(label, () => preview(path, name), "quiet turn-changes-name")
						: element("span", "turn-changes-name", label);
					name.title = path;
					const state = element("span", "turn-changes-state", descriptions[status]);
					row.append(name, state);
					if (recoveryPath) {
						const backup = element("span", "turn-changes-recovery", `恢复位置：${recoveryPath}`);
						row.append(backup);
					}
					return row;
				}),
			);
			sync();
		}
		async function load() {
			if (!record || node.hidden || waiting) return;
			const stamp = ++generation;
			waiting = true;
			sync();
			feedback(note, "正在核对工作区…");
			try {
				const { files, canUndo } = await inspect(record.requestId);
				if (stamp !== generation) return;
				authorized = canUndo;
				show(files);
				feedback(note, files.length ? "" : "此轮没有已登记的文件变更。");
			} catch (error) {
				if (stamp === generation) fail(error);
			} finally {
				if (stamp === generation) {
					waiting = false;
					sync();
				}
			}
		}
		node.addEventListener("toggle", () => {
			if (node.open) void load();
		});
		return {
			node,
			/** 只在记录变更时刷新打开的预览。@param {object} next 最新请求记录 @returns {void} */
			update(next) {
				record = next;
				const paths = next.artifacts ?? [];
				node.hidden = !next.hasTurnChanges && !paths.length;
				const key = JSON.stringify([next.requestId, next.status, next.hasTurnChanges, paths]);
				if (key === version) return;
				version = key;
				if (!node.open) count.textContent = paths.length ? `${paths.length} 个文件` : "";
				sync();
				if (node.open) void load();
			},
		};
	}

	return { card };
})();
