(() => {
	const by = (id) => document.getElementById(id);
	const root = by("management-page");
	const workbench = by("workbench");
	const conversation = workbench.querySelector(".conversation");
	const settings = by("settings-page");
	window.flowerUI.softScroll(root);
	const panes = {
		models: by("model-dialog"),
		appearance: by("appearance-page"),
		instructions: by("instructions-dialog"),
		update: by("desktop-update"),
		automation: by("automation-settings"),
		extensions: by("extension-settings"),
	};
	const settingsTabs = [...settings.querySelectorAll("[data-setting]")];
	const primaryNav = {
		automation: by("sidebar-automation"),
		extensions: by("sidebar-extensions"),
	};
	const toolToggle = by("sidebar-tools");
	const toolLinks = by("sidebar-tool-links");
	const toolsPreference = "flower.desktop.tools-expanded";
	let active;
	let opener;

	function setToolsExpanded(expanded) {
		toolLinks.hidden = !expanded;
		toolToggle.setAttribute("aria-expanded", String(expanded));
	}

	try {
		setToolsExpanded(localStorage.getItem(toolsPreference) === "true");
	} catch {
		setToolsExpanded(false);
	}
	toolToggle.onclick = () => {
		const expanded = toolLinks.hidden;
		setToolsExpanded(expanded);
		try {
			localStorage.setItem(toolsPreference, String(expanded));
		} catch {
			// 存储不可用时保留当前窗口的展开状态。
		}
	};
	toolLinks.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		toolToggle.click();
		toolToggle.focus();
	});

	function updateNavigation(section) {
		const tab = settingsTabs.find(({ dataset }) => dataset.setting === section);
		settings.hidden = !tab;
		toolToggle.toggleAttribute("data-current", Object.hasOwn(primaryNav, section));
		for (const control of settingsTabs) control.setAttribute("aria-current", control === tab ? "page" : "false");
		by("theme-open").setAttribute("aria-current", tab ? "page" : "false");
		for (const [key, control] of Object.entries(primaryNav))
			control.setAttribute("aria-current", key === section ? "page" : "false");
	}

	function notify(type, view) {
		panes[view]?.dispatchEvent(new CustomEvent(type, { detail: view }));
	}

	function setActive() {
		root.hidden = !active;
		if (active) workbench.dataset.management = active;
		else delete workbench.dataset.management;
		conversation.hidden = Boolean(active);
		workbench.dispatchEvent(new CustomEvent("managementchange", { detail: active }));
		updateNavigation(active);
	}

	/** 打开主区管理页面，保留第一次进入时的工作台焦点。@param {string} section 目标页面或设置栏目 @param {HTMLElement} trigger 入口 @returns {void} */
	function show(section, trigger = document.activeElement) {
		if (!Object.hasOwn(panes, section) || active === section) return;
		if (!active) opener = trigger;
		else {
			notify("managementleave", active);
			panes[active].hidden = true;
		}
		for (const popover of document.querySelectorAll(":popover-open")) popover.hidePopover();
		active = section;
		const pane = panes[section];
		pane.hidden = false;
		setActive();
		root.scrollTop = 0;
		notify("managemententer", section);
		by(pane.getAttribute("aria-labelledby"))?.focus({ preventScroll: true });
	}

	/** 返回原工作台，按需交由调用者移动焦点。@param {boolean} restore 是否恢复入口焦点 @returns {void} */
	function leave(restore = true) {
		if (!active) return;
		notify("managementleave", active);
		panes[active].hidden = true;
		active = undefined;
		setActive();
		if (restore) {
			const target =
				opener?.getClientRects().length && !opener.disabled
					? opener
					: toolLinks.contains(opener)
						? toolToggle
						: by("prompt");
			target.focus({ preventScroll: true });
		}
		opener = undefined;
	}

	for (const tab of settingsTabs) tab.onclick = () => show(tab.dataset.setting, tab);
	for (const [key, control] of Object.entries(primaryNav)) control.onclick = () => show(key, control);
	by("settings-close-dialog").onclick = () => leave();
	root.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
		if (document.querySelector("dialog[open], :popover-open")) return;
		event.preventDefault();
		leave();
	});

	window.flowerManagement = { show, leave, current: () => active };
})();
