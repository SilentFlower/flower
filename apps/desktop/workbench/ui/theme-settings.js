(() => {
	const theme = window.flowerTheme;
	const trigger = document.getElementById("settings-appearance");
	if (!trigger) return;
	const dialog = document.createElement("dialog");
	dialog.className = "flower-settings theme-settings";
	dialog.setAttribute("aria-labelledby", "theme-title");
	// 固定模板只包含控件结构，用户填写的文案始终通过 value 或 textContent 渲染。
	dialog.innerHTML = `
		<form>
			<header class="settings-heading"><h2 id="theme-title">主题设置</h2><button class="button quiet settings-close" type="button" aria-label="关闭主题设置">×</button></header>
			<div class="settings-scroll theme-layout">
				<div class="theme-controls">
					<fieldset class="theme-group"><legend>外观模式</legend><div class="settings-segmented"></div></fieldset>
					<fieldset class="theme-group"><legend>强调色</legend>
						<div class="theme-palette"></div>
						<div class="theme-custom"><label for="theme-picker">自定义颜色</label><input type="color" id="theme-picker"><code id="theme-hex"></code></div>
					</fieldset>
					<fieldset class="theme-group"><legend>状态色</legend><div class="theme-tones">
						<label>成功<input type="color" name="success" aria-label="成功状态色"></label>
						<label>错误<input type="color" name="danger" aria-label="错误状态色"></label>
					</div></fieldset>
					<fieldset class="theme-group"><legend>首页内容</legend>
						<label class="settings-field">首页标题<input type="text" name="title" maxlength="64"></label>
						<label class="settings-field">输入框提示<input type="text" name="prompt" maxlength="120"></label>
					</fieldset>
				</div>
				<section class="theme-preview" aria-labelledby="theme-preview-title">
					<h3 id="theme-preview-title">实时预览</h3>
					<div class="theme-preview-workbench">
						<div class="theme-preview-brand" aria-hidden="true"><img src="./ui/flower-avatar.webp" class="home-avatar" width="23" height="23" alt=""><span class="home-wordmark">FLOWER</span></div>
						<div class="theme-preview-heading"></div>
						<div class="composer theme-preview-input">
							<p class="theme-preview-prompt"></p>
							<div class="composer-toolbar" aria-hidden="true">
								<div class="composer-start"><svg class="icon"><use href="#icon-plus"/></svg><svg class="icon"><use href="#icon-shield"/></svg></div>
								<div class="composer-end">
									<span class="theme-preview-model">选择模型<svg class="icon"><use href="#icon-chevron"/></svg></span>
									<span class="theme-preview-send"><svg class="icon"><use href="#icon-up"/></svg></span>
								</div>
							</div>
						</div>
						<div class="theme-preview-suggestions" aria-hidden="true">
							<svg class="icon"><use href="#icon-folder"/></svg>
							<svg class="icon"><use href="#icon-checklist"/></svg>
							<svg class="icon"><use href="#icon-table"/></svg>
							<svg class="icon"><use href="#icon-report"/></svg>
						</div>
						<ul class="theme-preview-states">
							<li class="status" data-state="queued">已排队</li>
							<li class="status" data-state="succeeded">已完成</li>
							<li class="status" data-state="failed">执行出错</li>
						</ul>
					</div>
					<p class="theme-font-credit">界面字体：HarmonyOS Sans SC，© Huawei Device Co., Ltd.</p>
				</section>
			</div>
			<footer class="settings-actions"><button class="button quiet theme-default" type="button">恢复默认</button><button class="button secondary theme-cancel" type="button">取消</button><button class="button primary theme-save" type="submit">保存</button></footer>
			<p class="theme-error" role="alert" hidden></p>
		</form>`;
	document.body.append(dialog);
	const one = (selector) => dialog.querySelector(selector);
	const form = one("form");
	const picker = one("#theme-picker");
	const title = form.elements.namedItem("title");
	const prompt = form.elements.namedItem("prompt");
	let draft;
	let committed = false;

	function paint() {
		theme.apply(draft);
		picker.value = draft.accent;
		form.elements.namedItem("success").value = draft.success;
		form.elements.namedItem("danger").value = draft.danger;
		one("#theme-hex").textContent = draft.accent.toUpperCase();
		for (const node of dialog.querySelectorAll("[data-mode]")) node.checked = node.value === draft.mode;
		for (const node of dialog.querySelectorAll("[data-swatch]"))
			node.setAttribute("aria-pressed", String(node.dataset.swatch === draft.accent));
		const title = draft.title.trim() || theme.defaults.title;
		const previewHeading = one(".theme-preview-heading");
		previewHeading.textContent = title;
		previewHeading.hidden = title === theme.defaults.title;
		one(".theme-preview-prompt").textContent = draft.prompt.trim() || theme.defaults.prompt;
	}

	function fill(value) {
		draft = { ...value };
		title.value = value.title;
		prompt.value = value.prompt;
		paint();
	}

	for (const [mode, name] of [
		["system", "跟随系统"],
		["light", "浅色"],
		["dark", "深色"],
	]) {
		const label = window.flowerUI.element("label");
		const input = document.createElement("input");
		input.type = "radio";
		input.name = "mode";
		input.value = mode;
		input.dataset.mode = mode;
		input.addEventListener("change", () => {
			draft.mode = mode;
			paint();
		});
		label.append(input, window.flowerUI.element("span", "", name));
		one(".settings-segmented").append(label);
	}
	for (const [name, color] of theme.presets) {
		const swatch = window.flowerUI.button(
			"",
			() => {
				draft.accent = color;
				paint();
			},
			"theme-swatch",
		);
		swatch.dataset.swatch = color;
		swatch.title = name;
		swatch.setAttribute("aria-label", name);
		const dot = window.flowerUI.element("i");
		dot.setAttribute("aria-hidden", "true");
		dot.style.setProperty("--swatch", color);
		swatch.append(dot);
		one(".theme-palette").append(swatch);
	}
	for (const key of ["success", "danger"]) {
		const field = form.elements.namedItem(key);
		field.addEventListener("input", () => {
			draft[key] = field.value;
			paint();
		});
	}
	picker.addEventListener("input", () => {
		draft.accent = picker.value;
		paint();
	});
	for (const field of [title, prompt])
		field.addEventListener("input", () => {
			draft[field.name] = field.value;
			paint();
		});
	trigger.addEventListener("click", () => {
		if (dialog.open) return;
		document.getElementById("model-dialog").close();
		committed = false;
		one(".theme-error").hidden = true;
		fill(theme.saved);
		dialog.showModal();
	});
	one(".theme-default").addEventListener("click", () => fill(theme.defaults));
	one(".settings-close").addEventListener("click", () => dialog.close());
	one(".theme-cancel").addEventListener("click", () => dialog.close());
	dialog.addEventListener("close", () => {
		if (!committed) theme.apply(theme.saved);
		const focused = document.activeElement;
		if (focused === document.body || dialog.contains(focused)) document.getElementById("theme-open").focus();
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		try {
			theme.save(draft);
			committed = true;
			dialog.close();
		} catch {
			const error = one(".theme-error");
			error.textContent = "本机外观设置保存失败，请检查当前用户的存储空间后重试。";
			error.hidden = false;
		}
	});
})();
