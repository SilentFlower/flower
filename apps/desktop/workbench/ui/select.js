(() => {
	/** 在设置页或浮层内创建使用当前主题的选择框。
	 * @param {HTMLElement} root 控件容器
	 * @param {string} id 触发按钮 ID
	 * @param {string} label 读屏名称
	 * @param {(value: string) => void} onChange 选择回调
	 * @returns {object} 控件的刷新与可用状态接口
	 */
	function createSelect(root, id, label, onChange) {
		const button = flowerUI.button("", undefined, "theme-select-trigger");
		button.id = id;
		const title = flowerUI.element("span", "theme-select-label");
		title.id = `${id}-value`;
		button.append(title, flowerUI.icon("chevron"));
		const menu = flowerUI.element("div", "theme-select-menu");
		menu.id = `${id}-options`;
		menu.popover = "auto";
		menu.setAttribute("role", "listbox");
		menu.setAttribute("aria-label", label);
		button.setAttribute("aria-label", label);
		button.setAttribute("aria-describedby", title.id);
		button.setAttribute("aria-haspopup", "listbox");
		button.setAttribute("aria-expanded", "false");
		button.setAttribute("aria-controls", menu.id);
		button.setAttribute("popovertarget", menu.id);
		root.append(button, menu);

		let selected = "";
		const buttons = () => [...menu.querySelectorAll("[role=option]")];
		const focusOption = (choice) => choice?.focus();
		function close() {
			if (menu.matches(":popover-open")) menu.hidePopover();
		}

		function render(options, value) {
			selected = value;
			title.textContent = options.find((option) => option.value === value)?.label ?? "请选择";
			menu.replaceChildren(
				...options.map((option) => {
					const item = flowerUI.button(
						option.label,
						() => {
							close();
							button.focus({ preventScroll: true });
							if (option.value !== selected) onChange(option.value);
						},
						"theme-select-option",
					);
					item.tabIndex = -1;
					item.dataset.value = option.value;
					item.setAttribute("role", "option");
					item.setAttribute("aria-label", option.label);
					item.setAttribute("aria-selected", String(option.value === value));
					item.append(flowerUI.icon("check"));
					if (option.title) item.title = option.title;
					return item;
				}),
			);
		}

		menu.addEventListener("beforetoggle", ({ newState }) => {
			button.setAttribute("aria-expanded", String(newState === "open"));
		});
		menu.addEventListener("toggle", ({ newState }) => {
			if (newState === "open" && document.activeElement === button) {
				const options = buttons();
				focusOption(options.find((option) => option.dataset.value === selected) ?? options[0]);
			}
		});
		button.addEventListener("keydown", (event) => {
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			menu.showPopover({ source: button });
			const options = buttons();
			if (event.key === "Home") focusOption(options[0]);
			else if (event.key === "End") focusOption(options.at(-1));
			else focusOption(options.find((option) => option.dataset.value === selected) ?? options[0]);
		});
		menu.addEventListener("keydown", (event) => {
			if (event.key === "Escape" || event.key === "Tab") {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
				}
				close();
				button.focus({ preventScroll: true });
				return;
			}
			const options = buttons();
			const index = options.indexOf(document.activeElement);
			const next = {
				ArrowDown: (index + 1) % options.length,
				ArrowUp: (index - 1 + options.length) % options.length,
				Home: 0,
				End: options.length - 1,
			}[event.key];
			if (next === undefined) return;
			event.preventDefault();
			focusOption(options[next]);
		});

		return {
			render,
			close,
			get value() {
				return selected;
			},
		};
	}

	window.flowerSelect = createSelect;
})();
