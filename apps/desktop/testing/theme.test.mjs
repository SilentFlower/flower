import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../workbench/ui/theme-preload.js", import.meta.url), "utf8");

/** 加载首帧外观入口，模拟系统深浅变化和跨启动的偏好。@param {string} stored 已存值 @returns {object} 首帧样式和操作入口 */
function start(stored) {
	const style = new Map();
	const root = { dataset: {}, style: { setProperty: (key, value) => style.set(key, value) } };
	const media = {
		matches: false,
		addEventListener: (_name, callback) => {
			media.changed = callback;
		},
	};
	const storage = {
		getItem: () => stored,
		setItem: (_key, value) => {
			stored = value;
		},
	};
	const document = { documentElement: root, readyState: "loading", querySelector: () => null, addEventListener() {} };
	const window = { matchMedia: () => media, localStorage: storage };
	runInNewContext(source, { document, window });
	return { theme: window.flowerTheme, style, root, media, storage };
}

test("主题草稿可还原；保存后首页文案与外观跨启动恢复", () => {
	const { theme, root, storage } = start("损坏的本地记录");
	assert.equal(root.dataset.scheme, "light");
	theme.apply({ ...theme.saved, mode: "dark", title: "草稿" });
	assert.equal(root.dataset.scheme, "dark");
	assert.equal(theme.saved.title, theme.defaults.title);
	theme.apply(theme.saved);
	assert.equal(root.dataset.scheme, "light");
	theme.save({ mode: "dark", accent: "#abcdef", success: "#237854", title: "我的工作台", prompt: "从这里开始" });
	const next = start(storage.getItem());
	assert.equal(next.root.dataset.scheme, "dark");
	assert.equal(next.theme.saved.prompt, "从这里开始");
	assert.equal(next.theme.saved.title, "我的工作台");
	assert.equal(next.theme.saved.accent, "#abcdef");
	assert.equal(next.theme.saved.success, "#237854");
});

test("跟随系统即时响应，极端配色保持可见，无效字段逐项恢复默认", () => {
	const { theme, style, media, root } = start();
	theme.apply({ ...theme.saved, accent: "#ffffff" });
	assert.notEqual(style.get("--accent"), "#ffffff");
	media.matches = true;
	media.changed();
	assert.equal(root.dataset.scheme, "dark");
	theme.save({ mode: "unknown", accent: "url(test)", title: " ", prompt: "保留" });
	assert.equal(theme.saved.accent, theme.defaults.accent);
	assert.equal(theme.saved.title, theme.defaults.title);
	assert.equal(theme.saved.prompt, "保留");
	theme.apply({ ...theme.saved, mode: "light" });
	media.changed();
	assert.equal(root.dataset.scheme, "light");
});
