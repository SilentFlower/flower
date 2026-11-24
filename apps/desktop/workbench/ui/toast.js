window.flowerToast = (() => {
	const durations = { neutral: 4000, error: 8000, action: 8000 };

	/**
	 * Toast 队列的纯逻辑：最多保留 limit 条，同文案同色调去重，超出时先移除最早的非错误提示。
	 * @param {number} [limit] 同时显示的上限
	 * @returns {{push(entry: object): {item: object, added: boolean, evicted: object[]}, remove(item: object): boolean, items: object[]}} 队列操作
	 */
	function toastStack(limit = 3) {
		const items = [];
		return {
			items,
			push(entry) {
				const same = items.find((item) => item.text === entry.text && item.tone === entry.tone && !item.action);
				// 相同提示只保留一条并重新计时；带操作的提示各自独立，避免撤销对象被合并。
				if (same && !entry.action) return { item: same, added: false, evicted: [] };
				const item = { ...entry };
				items.push(item);
				const evicted = [];
				while (items.length > limit) {
					const index = items.findIndex((candidate) => candidate.tone !== "error");
					evicted.push(...items.splice(index >= 0 ? index : 0, 1));
				}
				return { item, added: true, evicted };
			},
			remove(item) {
				const index = items.indexOf(item);
				if (index < 0) return false;
				items.splice(index, 1);
				return true;
			},
		};
	}

	/**
	 * 在指定区域显示 Toast：悬停或焦点在区域内时暂停全部计时，可手动关闭，可带一个操作按钮。
	 * @param {HTMLElement} region 提示区域
	 * @returns {(text: string, options?: {tone?: string, action?: {label: string, run: Function}, duration?: number}) => void} 显示提示
	 */
	function mount(region) {
		const { element, button, icon } = window.flowerUI;
		const stack = toastStack();
		const nodes = new Map();
		let paused = false;

		function dismiss(item) {
			clearTimeout(item.timer);
			if (!stack.remove(item)) return;
			const node = nodes.get(item);
			nodes.delete(item);
			const focused = node?.contains(document.activeElement);
			node?.remove();
			// 焦点在被移除的提示内时交还给页面，避免落到 body 后丢失位置。
			if (focused) document.querySelector("#prompt")?.focus({ preventScroll: true });
			if (!stack.items.length) paused = false;
		}
		function start(item) {
			clearTimeout(item.timer);
			if (paused) return;
			item.startedAt = Date.now();
			item.timer = setTimeout(() => dismiss(item), item.remaining);
		}
		function pause(next) {
			if (paused === next) return;
			paused = next;
			for (const item of stack.items) {
				if (next) {
					clearTimeout(item.timer);
					item.remaining = Math.max(1000, item.remaining - (Date.now() - item.startedAt));
				} else start(item);
			}
		}
		region.addEventListener("pointerenter", () => pause(true));
		region.addEventListener("pointerleave", () => pause(region.contains(document.activeElement)));
		region.addEventListener("focusin", () => pause(true));
		region.addEventListener("focusout", ({ relatedTarget }) => {
			if (!region.contains(relatedTarget)) pause(region.matches(":hover"));
		});

		return (text, options = {}) => {
			if (!text) return;
			const tone = options.tone ?? "neutral";
			const total = options.duration ?? (options.action ? durations.action : (durations[tone] ?? durations.neutral));
			const { item, added, evicted } = stack.push({ text, tone, action: options.action });
			for (const old of evicted) {
				clearTimeout(old.timer);
				nodes.get(old)?.remove();
				nodes.delete(old);
			}
			item.remaining = total;
			if (!added) {
				// 重复提示重新计时并轻微提示一次，不再追加新条目。
				const node = nodes.get(item);
				node?.removeAttribute("data-repeat");
				void node?.offsetWidth;
				node?.toggleAttribute("data-repeat", true);
				start(item);
				return;
			}
			const node = element("div", "toast");
			node.dataset.tone = tone;
			// 区域本身礼貌播报普通提示；错误另设 alert 立即播报。
			if (tone === "error") node.setAttribute("role", "alert");
			node.append(element("p", "toast-text", text));
			if (options.action) {
				const run = button(options.action.label, () => {
					dismiss(item);
					options.action.run();
				});
				run.classList.add("toast-action");
				node.append(run);
			}
			const close = button("", () => dismiss(item), "quiet icon-button toast-close");
			close.setAttribute("aria-label", "关闭提示");
			close.title = "关闭提示";
			close.append(icon("panel-close"));
			node.append(close);
			nodes.set(item, node);
			region.append(node);
			start(item);
		};
	}

	return { toastStack, mount };
})();
