/** 在首帧前应用工作台主题，并管理仅属于本机的外观偏好。 */
window.flowerTheme = (() => {
	const storageKey = "flower.desktop.appearance.v1";
	const presets = [
		["花瓣紫", "#6c54b4"],
		["深海蓝", "#2f6bd8"],
		["松石绿", "#0f9f8f"],
		["暮光橙", "#e2742b"],
		["玫瑰红", "#d64a7b"],
		["石墨", "#3d4352"],
	];
	const defaults = Object.freeze({
		mode: "system",
		accent: presets[0][1],
		success: "#237250",
		danger: "#a22e33",
		title: "你想完成什么？",
		prompt: "描述你想完成的工作…",
	});
	const system = window.matchMedia("(prefers-color-scheme: dark)");
	let saved = defaults;
	let active;
	let nativeScheme;

	function plainText(value, fallback, limit) {
		if (typeof value !== "string") return fallback;
		return value.trim().slice(0, limit) || fallback;
	}

	function validColor(value, fallback) {
		return typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
	}

	function normalize(value) {
		return {
			mode: ["system", "light", "dark"].includes(value?.mode) ? value.mode : defaults.mode,
			accent: validColor(value?.accent, defaults.accent),
			success: validColor(value?.success, defaults.success),
			danger: validColor(value?.danger, defaults.danger),
			title: plainText(value?.title, defaults.title, 64),
			prompt: plainText(value?.prompt, defaults.prompt, 120),
		};
	}

	function luminance(rgb) {
		const [r, g, b] = rgb.map((channel) => {
			const v = channel / 255;
			return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}

	function contrast(a, b) {
		return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	}

	function channels(color) {
		return color
			.slice(1)
			.match(/../g)
			.map((pair) => Number.parseInt(pair, 16));
	}

	function readableColor(color, dark) {
		const seed = channels(color);
		let rgb = seed;
		const surface = luminance(dark ? [42, 42, 42] : [234, 234, 231]);
		// 同一强调色同时出现在按钮和文字上。极亮及极暗种子须在对应背景上仍可读。
		for (let step = 1; contrast(luminance(rgb), surface) < 4.6 && step <= 20; step++) {
			rgb = seed.map((channel) => Math.round(channel + ((dark ? 255 : 0) - channel) * (step / 20)));
		}
		return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
	}

	function syncChrome(scheme) {
		if (document.readyState === "loading" || !window.flower?.setTitlebarTheme || scheme === nativeScheme) return;
		nativeScheme = scheme;
		Promise.resolve(window.flower.setTitlebarTheme(scheme)).catch(() => {
			if (nativeScheme === scheme) nativeScheme = undefined;
		});
	}

	/** 即时预览外观和首页内容。@param {object} value 外观设置 @returns {void} */
	function apply(value) {
		active = normalize(value);
		const scheme = active.mode === "system" ? (system.matches ? "dark" : "light") : active.mode;
		const dark = scheme === "dark";
		const root = document.documentElement;
		root.dataset.scheme = scheme;
		const hex = readableColor(active.accent, dark);
		root.style.setProperty("--good", readableColor(active.success, dark));
		root.style.setProperty("--danger", readableColor(active.danger, dark));
		const brightness = luminance(channels(hex));
		const foreground = contrast(1, brightness) >= contrast(0, brightness) ? "#ffffff" : "#000000";
		root.style.setProperty("--accent", hex);
		root.style.setProperty("--on-accent", foreground);
		root.style.setProperty(
			"--accent-hover",
			`color-mix(in srgb, ${hex} 88%, ${foreground === "#ffffff" ? "black" : "white"})`,
		);
		root.style.setProperty("--accent-tint", `color-mix(in srgb, ${hex} 13%, var(--surface))`);
		root.style.setProperty("--focus", hex);
		const title = document.querySelector("[data-theme-home-title], #empty-title");
		const prompt = document.querySelector("[data-theme-prompt], #prompt");
		if (title) {
			title.textContent = active.title;
			title.hidden = active.title === defaults.title;
		}
		if (prompt) prompt.placeholder = active.prompt;
		syncChrome(scheme);
	}

	/** 将当前偏好写入此桌面应用的本机存储。@param {object} value 外观设置 @returns {void} */
	function save(value) {
		const next = normalize(value);
		window.localStorage.setItem(storageKey, JSON.stringify(next));
		saved = next;
		apply(saved);
	}

	try {
		saved = normalize(JSON.parse(window.localStorage.getItem(storageKey)));
	} catch {
		// 旧资料或不可读的本地存储使用默认外观，工作台照常打开。
	}
	apply(saved);
	document.addEventListener("DOMContentLoaded", () => apply(active), { once: true });
	system.addEventListener("change", () => {
		if (active.mode === "system") apply(active);
	});
	return Object.freeze({
		defaults,
		presets,
		apply,
		save,
		get saved() {
			return { ...saved };
		},
	});
})();
