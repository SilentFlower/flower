import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

const [productArg, evidenceArg, toolingArg, bookArg, captureArg] = process.argv.slice(2);
assert(
	process.platform === "win32" && bookArg,
	"用法：verify-windows.mjs <正式 EXE> <新证据目录> <Playwright> <orders.xlsx> [Windows 截图脚本]",
);
const evidence = resolve(evidenceArg);
const workspace = join(evidence, "订单分析");
const book = join(workspace, "orders.xlsx");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
await mkdir(workspace);
await copyFile(resolve(bookArg), book);
await writeFile(join(workspace, "notes.txt"), "行动项：核对库存清单。\n");
const longFilename = `地区和部门汇总${"季度订单核对记录".repeat(10)}.txt`;
await writeFile(join(workspace, longFilename), "窄窗长文件名验收\n");
const alternate = "local-alternate";
const fixture = await startMockModel({ alternatives: [alternate] });
const testKey = "local-test-key-only";
const manualModel = "local-manual-test";
const protectedFixture = await startMockModel({
	model: "local-key-test",
	alternatives: [manualModel],
	discover: false,
	apiKey: testKey,
});
const original = createHash("sha256")
	.update(await readFile(book))
	.digest("hex");
const results = [];
let current;
async function wait(test) {
	for (let i = 0; i < 160; i++) {
		const item = await test();
		if (item) return item;
		await setTimeout(100);
	}
	assert.fail("等待 Windows 状态超时");
}
async function boot(exe, profile) {
	current = await electron.launch({
		executablePath: resolve(exe),
		chromiumSandbox: true,
		timeout: 30000,
		// 首页对照图使用固定像素尺寸，独立于 Windows 显示缩放。
		args: [`--user-data-dir=${profile}`, "--force-device-scale-factor=1"],
	});
	const page = await current.firstWindow();
	await current.evaluate(({ app }, directory) => {
		if (app.getPath("userData").toLowerCase() !== directory.toLowerCase()) throw new Error("测试资料目录不匹配");
	}, profile);
	return page;
}
async function close() {
	await current?.close();
	current = undefined;
}
async function prepareDialogs() {
	await current.evaluate(
		({ dialog, shell }, input) => {
			globalThis.flowerQA = { artifacts: [], file: input.book, cancelDirectory: false, directoryPicks: 0 };
			shell.openPath = async (path) => {
				globalThis.flowerQA.artifacts.push(path);
				return "";
			};
			dialog.showOpenDialog = async (_window, options) => {
				if (options.properties.includes("openDirectory")) {
					globalThis.flowerQA.directoryPicks++;
					if (globalThis.flowerQA.cancelDirectory) return { canceled: true, filePaths: [] };
					return { canceled: false, filePaths: [input.root] };
				}
				return { canceled: false, filePaths: [globalThis.flowerQA.file] };
			};
		},
		{ root: dirname(book), book },
	);
}
async function ready(page) {
	await page.waitForFunction(() => !document.querySelector("#model-picker-open").disabled);
}

async function captureNative(name) {
	if (!captureArg) return;
	const pid = await current.evaluate(() => process.pid);
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			resolve(captureArg),
			resolve(productArg),
			join(evidence, name),
			"-ExistingProcessId",
			String(pid),
		],
		{ timeout: 15000 },
	);
}

async function fillModel(page, remote, key = "") {
	await page.locator("#base-url").fill(remote.baseUrl);
	await page.locator("#model-id").fill(remote.modelId);
	await page.locator("#api-key").fill(key);
	await page.locator("#save-settings").click();
	await page.locator("#model-form").waitFor({ state: "hidden" });
	if (await page.locator("#model-dialog").isVisible()) await page.locator("#settings-close-dialog").click();
	await page.locator("#model-dialog").waitFor({ state: "hidden" });
	await page.waitForFunction((id) => document.querySelector("#model").textContent === id, remote.modelId || "选择模型");
}

async function openPicker(page) {
	await page.locator("#model-picker-open").click();
	const picker = page.locator("#model-picker");
	await picker.waitFor();
	return picker;
}

try {
	const profile = join(evidence, "local-profile");
	// 同一个自定义 Electron 路径中预置旧版资料，确认工作台只读取新资料路径。
	const legacyCredential = join(profile, "credentials", "active-account.json");
	const legacyWorkspace = join(profile, "employees", "legacy", "workbench.json");
	for (const path of [legacyCredential, legacyWorkspace]) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "应保持原样的旧资料");
	}
	let page = await boot(productArg, profile);
	await current.context().setOffline(true);
	await current.evaluate(() => {
		globalThis.originalFetch = globalThis.fetch;
		globalThis.offlineRequests = 0;
		globalThis.fetch = async () => {
			globalThis.offlineRequests++;
			throw new Error("测试窗口暂时离线");
		};
	});
	await ready(page);
	assert.equal(await page.title(), "Flower Desktop");
	const chrome = await page.evaluate(() => {
		const overlay = navigator.windowControlsOverlay;
		const area = overlay?.getTitlebarAreaRect();
		const heading = document.querySelector(".chrome-content");
		const title = document.querySelector("#title");
		const conversation = document.querySelector(".conversation").getBoundingClientRect();
		return {
			visible: overlay?.visible,
			height: area?.height,
			reservedWidth: innerWidth - (area?.width ?? innerWidth),
			noOverflow: document.documentElement.scrollWidth === innerWidth,
			draggable: getComputedStyle(heading).getPropertyValue("-webkit-app-region").trim(),
			homeTitlebarClear: title.hidden,
			titlebarBottom: heading.getBoundingClientRect().bottom,
			conversationTop: conversation.top,
			modelInTitlebar: Boolean(heading.querySelector("#model-picker-open")),
		};
	});
	assert(chrome.visible && chrome.height >= 44 && chrome.height <= 46 && chrome.reservedWidth >= 120);
	assert(chrome.noOverflow && chrome.draggable === "drag" && chrome.homeTitlebarClear);
	assert.equal(chrome.modelInTitlebar, false);
	assert.equal(chrome.conversationTop, chrome.titlebarBottom);
	results.push("Windows 原生控制与会话标题同排，模型入口位于输入卡");
	assert(await page.locator("#workbench").isVisible());
	assert.equal(await page.locator("#sessions .session-row").count(), 0);
	assert.equal(await page.locator("#model").textContent(), "选择模型");
	const back = page.getByRole("button", { name: "后退", exact: true });
	const forward = page.getByRole("button", { name: "前进", exact: true });
	assert(await back.isDisabled());
	assert(await forward.isDisabled());
	assert.equal(await page.evaluate(() => typeof window.require), "undefined");
	assert.equal(await page.locator("#empty-title").textContent(), "你想完成什么？");
	assert(await page.locator("#empty-title").isHidden());
	await page.waitForFunction(() =>
		[...document.querySelectorAll(".home-identity img, .assistant-home img")].every(
			(image) => image.complete && image.naturalWidth > 0,
		),
	);
	assert(await page.locator("#prompt").isVisible());
	assert(await page.locator("#file").isHidden());
	assert.equal(await page.locator("#composer-add").getAttribute("aria-label"), "添加到对话");
	const add = page.locator("#composer-add");
	await add.press("ArrowDown");
	await page.waitForFunction(() => document.activeElement === document.getElementById("file"));
	await page.keyboard.press("End");
	assert(await page.locator("#composer-workspace").evaluate((node) => node === document.activeElement));
	await page.keyboard.press("Escape");
	assert(await add.evaluate((node) => node === document.activeElement));
	const send = page.locator("#send");
	const arrow = send.locator("use");
	const chooseLabel = "提交任务（先选择工作区）";
	const modelLabel = "提交任务（先配置模型）";
	assert(await send.isDisabled());
	assert.equal(await arrow.getAttribute("href"), "#icon-up");
	assert.equal(await send.getAttribute("title"), chooseLabel);
	const composer = page.locator("#composer");
	const homeLayout = await composer.evaluate((node) => {
		const rect = node.getBoundingClientRect();
		const left = document.getElementById("composer-add").getBoundingClientRect();
		const right = document.getElementById("send").getBoundingClientRect();
		const model = document.getElementById("model-picker-open").getBoundingClientRect();
		const input = document.getElementById("prompt").getBoundingClientRect();
		const brand = document.getElementById("empty").getBoundingClientRect();
		const sidebar = document.querySelector(".sidebar");
		return {
			height: rect.height,
			width: rect.width,
			x: rect.x,
			y: rect.y,
			brandY: brand.y,
			viewport: [innerWidth, innerHeight],
			sidebarWidth: sidebar.getBoundingClientRect().width,
			canvas: getComputedStyle(document.querySelector(".conversation")).backgroundColor,
			sidebar: getComputedStyle(sidebar).backgroundColor,
			card: getComputedStyle(node).backgroundColor,
			radius: getComputedStyle(node).borderRadius,
			ordered: input.bottom < left.top && input.bottom < right.top && left.right <= model.left && model.right < right.left,
		};
	});
	assert.deepEqual(homeLayout.viewport, [1282, 801]);
	assert(Math.abs(homeLayout.sidebarWidth - 260) <= 1);
	assert(
		Math.abs(homeLayout.x - 304) <= 2 && Math.abs(homeLayout.y - 367) <= 3 && Math.abs(homeLayout.brandY - 302) <= 2,
	);
	assert(
		Math.abs(homeLayout.height - 140) <= 2 && Math.abs(homeLayout.width - 932) <= 2 && homeLayout.ordered,
		JSON.stringify(homeLayout),
	);
	assert.equal(homeLayout.radius, "12px");
	const sidebarWidths = () =>
		page
			.locator("#sidebar-scroll, #sessions")
			.evaluateAll((nodes) => nodes.map(({ id, scrollWidth, clientWidth }) => ({ id, scrollWidth, clientWidth })));
	const wideSidebar = await sidebarWidths();
	assert(wideSidebar.every(({ scrollWidth, clientWidth }) => scrollWidth <= clientWidth));
	assert.deepEqual(
		[homeLayout.canvas, homeLayout.sidebar, homeLayout.card],
		["rgb(242, 242, 237)", "rgb(234, 234, 229)", "rgb(253, 253, 248)"],
	);
	await page.locator("#prompt").fill("第一行\n第二行\n第三行\n第四行\n第五行");
	assert((await composer.boundingBox()).height > homeLayout.height + 20);
	await page.locator("#prompt").fill("");
	assert.equal((await composer.boundingBox()).height, homeLayout.height);
	results.push("1282×801 首页的品牌、浅灰双层布局和约 932×140 的输入卡与新基准对齐");
	await page.screenshot({ path: join(evidence, "首次启动.png") });
	await captureNative("首次启动-含系统标题栏.png");
	const suggestions = page.locator("#home-suggestions");
	assert.equal(await suggestions.getByRole("button").count(), 4);
	await page.locator("#prompt").fill("保留这份草稿。");
	const suggestion = suggestions.getByRole("button", { name: "浏览工作区" });
	const addition = await suggestion.getAttribute("data-suggestion");
	await suggestion.press("Enter");
	assert.equal(await page.locator("#prompt").inputValue(), `保留这份草稿。\n${addition}`);
	assert.equal(await page.evaluate(() => document.activeElement.id), "prompt");
	assert.equal(fixture.observations.model.length, 0);
	assert.equal((await page.evaluate(() => window.flower.state())).selected, "");
	await page.screenshot({ path: join(evidence, "首页建议填入.png") });
	await page.locator("#prompt").fill("");
	await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(660, 615));
	await page.waitForFunction(() => innerWidth === 660);
	assert(await suggestions.getByRole("button").last().isVisible());
	assert(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth));
	const narrowSidebar = await sidebarWidths();
	assert(narrowSidebar.every(({ scrollWidth, clientWidth }) => scrollWidth <= clientWidth));
	results.push(`侧栏实际宽度校验 ${JSON.stringify({ wide: wideSidebar, narrow: narrowSidebar })}`);
	await page.screenshot({ path: join(evidence, "首页窄窗.png") });
	await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1282, 801));
	await page.waitForFunction(() => innerWidth === 1282);
	const unconfigured = await openPicker(page);
	await unconfigured.getByText("请先配置模型服务。").waitFor();
	assert.equal(await current.evaluate(() => globalThis.offlineRequests), 0);
	await page.keyboard.press("Escape");
	await unconfigured.waitFor({ state: "hidden" });
	const initialScheme = await page.evaluate(() => {
		const scheme = document.documentElement.dataset.scheme;
		if (scheme !== (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"))
			throw new Error("首启外观与系统不一致");
		if (window.flowerTheme.saved.mode !== "system") throw new Error("首启应跟随系统");
		return scheme;
	});
	await assert.rejects(
		page.evaluate(() => window.flower.setTitlebarTheme("purple")),
		/无效的窗口外观/,
	);
	await assert.rejects(
		page.evaluate(() => window.flower.setTitlebarTheme({ color: "#ff0000" })),
		/无效的窗口外观/,
	);
	await current.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0];
		const original = window.setTitleBarOverlay.bind(window);
		window.setTitleBarOverlay = (palette) => {
			globalThis.lastOverlay = palette;
			return original(palette);
		};
	});
	const themeButton = page.locator("#theme-open");
	const themeDialog = page.locator(".theme-settings");
	const darkMode = themeDialog.getByText("深色", { exact: true });
	const lightMode = themeDialog.getByText("浅色", { exact: true });
	const titleText = "我的工作台";
	const promptText = "从这里描述你的任务…";
	await themeButton.focus();
	await themeButton.press("Enter");
	await page.locator("#settings-appearance").press("Enter");
	await themeDialog.waitFor();
	const desktopVersion = await page.evaluate(() => window.flower.state().then(({ version }) => version));
	assert.match(desktopVersion, /^\d+\.\d+\.\d+/);
	assert.equal(await page.locator("#desktop-version").textContent(), `版本 ${desktopVersion}`);
	assert.equal(await themeButton.getAttribute("aria-label"), `本机工作台，版本 ${desktopVersion}，应用设置`);
	assert.equal(
		await themeButton.locator("img").getAttribute("src"),
		await page.locator(".home-avatar").first().getAttribute("src"),
	);
	await lightMode.click();
	const settingsLayout = await themeDialog.evaluate((dialog) => {
		const layout = dialog.querySelector(".theme-layout");
		const preview = dialog.querySelector(".theme-preview");
		const previewCard = preview.querySelector(".composer");
		const previewPrompt = previewCard.querySelector(".theme-preview-prompt").getBoundingClientRect();
		const previewToolbar = previewCard.querySelector(".composer-toolbar").getBoundingClientRect();
		const swatches = Array.from(dialog.querySelectorAll(".theme-swatch"));
		return {
			width: dialog.getBoundingClientRect().width,
			columns: getComputedStyle(layout).gridTemplateColumns.split(" ").length,
			scrolls: layout.scrollHeight > layout.clientHeight,
			paletteRows: new Set(swatches.map((button) => button.getBoundingClientRect().top)).size,
			swatches: swatches.length,
			previewTwoRows: previewPrompt.bottom < previewToolbar.top,
			previewStatic: !previewCard.querySelector("button, input, [tabindex], [popovertarget]"),
			previewBrand: preview.querySelector(".home-wordmark").textContent,
			previewAvatar: preview.querySelector(".home-avatar").getAttribute("src"),
			previewPrompt: previewCard.querySelector(".theme-preview-prompt").textContent,
			previewSuggestions: preview.querySelectorAll(".theme-preview-suggestions .icon").length,
			previewAndFooterFit:
				preview.getBoundingClientRect().bottom <= layout.getBoundingClientRect().bottom &&
				dialog.querySelector(".settings-actions").getBoundingClientRect().bottom <= dialog.getBoundingClientRect().bottom,
		};
	});
	assert(settingsLayout.width >= 740 && settingsLayout.width <= 760 && settingsLayout.columns === 2);
	assert(!settingsLayout.scrolls && settingsLayout.previewAndFooterFit);
	assert(settingsLayout.previewTwoRows && settingsLayout.previewStatic);
	assert.equal(settingsLayout.previewBrand, "FLOWER");
	assert.equal(settingsLayout.previewAvatar, "./ui/flower-avatar.webp");
	assert.equal(settingsLayout.previewPrompt, await page.locator("#prompt").getAttribute("placeholder"));
	assert.equal(settingsLayout.previewSuggestions, 4);
	assert.equal(settingsLayout.swatches, 6);
	assert.equal(settingsLayout.paletteRows, 1);
	const blue = themeDialog.getByRole("button", { name: "深海蓝", exact: true });
	assert.equal(await blue.getAttribute("title"), "深海蓝");
	await blue.focus();
	await blue.press("Space");
	assert.equal(await blue.getAttribute("aria-pressed"), "true");
	assert.equal(await themeDialog.getByRole("button", { name: "花瓣紫" }).getAttribute("aria-pressed"), "false");
	await page.screenshot({ path: join(evidence, "主题设置-浅色.png") });
	assert.equal(
		await page.locator("#empty-title").evaluate((heading) => getComputedStyle(heading).color),
		"rgb(34, 34, 31)",
	);
	assert.equal(
		await page.locator(".desktop-chrome").evaluate((heading) => getComputedStyle(heading).backgroundColor),
		"rgb(242, 242, 237)",
	);
	await darkMode.click();
	await themeDialog.locator('input[name="title"]').fill("不保存的标题");
	assert.equal(await page.locator("#empty-title").textContent(), "不保存的标题");
	assert(await page.locator("#empty-title").isVisible());
	assert.deepEqual(
		await wait(() => current.evaluate(() => globalThis.lastOverlay?.symbolColor === "#eeeeec" && globalThis.lastOverlay)),
		{
			height: 45,
			color: "#00000000",
			symbolColor: "#eeeeec",
		},
	);
	await themeDialog.locator(".theme-cancel").click();
	await page.waitForFunction((scheme) => {
		return document.activeElement?.id === "theme-open" && document.documentElement.dataset.scheme === scheme;
	}, initialScheme);
	assert.equal(await page.locator("#empty-title").textContent(), "你想完成什么？");
	assert(await page.locator("#empty-title").isHidden());
	await themeButton.click();
	await page.locator("#settings-appearance").click();
	await darkMode.click();
	const tones = themeDialog.locator(".theme-preview-states .status");
	const stateColors = () => tones.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
	const before = await stateColors();
	await themeDialog.locator("#theme-picker").fill("#24a98a");
	await themeDialog.locator('input[name="success"]').fill("#35ae6c");
	await themeDialog.locator('input[name="danger"]').fill("#eb7280");
	const after = await stateColors();
	assert(after.every((color, index) => color !== before[index]));
	await themeDialog.locator('input[name="title"]').fill(titleText);
	await themeDialog.locator('input[name="prompt"]').fill(promptText);
	assert.equal(await themeDialog.locator(".theme-preview-heading").textContent(), titleText);
	assert.equal(await themeDialog.locator(".theme-preview-prompt").textContent(), promptText);
	await page.screenshot({ path: join(evidence, "主题设置-深色.png") });
	await themeDialog.locator(".theme-save").click();
	await themeDialog.waitFor({ state: "hidden" });
	assert.equal(await page.locator("#empty-title").textContent(), titleText);
	assert.equal(await page.locator("#prompt").getAttribute("placeholder"), promptText);
	assert(await page.locator("#home-wordmark").isVisible());
	assert(await page.locator("#title").isHidden());
	assert.equal(
		await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()),
		"#24a98a",
	);
	await page.screenshot({ path: join(evidence, "深色工作台.png") });
	await captureNative("深色工作台-含系统标题栏.png");
	assert.equal(await page.locator("#model").textContent(), "选择模型");
	results.push(
		"离线首启跟随系统，键盘打开主题设置，深浅预览驱动 Windows 原生控件，取消撤销预览，自定义强调色和首页文案可保存",
	);
	await prepareDialogs();
	await page.locator("#new-session").press("Enter");
	await page.waitForFunction(() => document.activeElement.id === "prompt");
	assert.equal(await current.evaluate(() => globalThis.flowerQA.directoryPicks), 0);
	assert.equal(await page.locator("#sessions .session-row").count(), 0);
	assert(await suggestions.isVisible());
	const task = "请读取 notes.txt 并列出后续事项";
	await page.locator("#prompt").fill("   ");
	assert(await send.isDisabled());
	assert.equal(await current.evaluate(() => globalThis.flowerQA.directoryPicks), 0);
	await current.evaluate(() => {
		globalThis.flowerQA.cancelDirectory = true;
	});
	await page.locator("#prompt").fill(task);
	assert.equal(await send.getAttribute("aria-label"), chooseLabel);
	await page.locator("#model-picker-open").press("Tab");
	assert(
		await send.evaluate((button) => button.matches(":focus-visible") && getComputedStyle(button).outlineStyle !== "none"),
	);
	await send.press("Enter");
	await wait(() => current.evaluate(() => globalThis.flowerQA.directoryPicks === 1));
	assert.equal(await page.locator("#prompt").inputValue(), task);
	assert.equal(await page.locator("#sessions .session-row").count(), 0);
	await current.evaluate(() => {
		globalThis.flowerQA.cancelDirectory = false;
	});
	await send.click();
	await page.waitForFunction(
		(label) => document.querySelector("#send").getAttribute("aria-label") === label,
		modelLabel,
	);
	assert.equal(await arrow.getAttribute("href"), "#icon-up");
	assert.equal(await send.getAttribute("title"), modelLabel);
	assert.equal(await page.locator("#prompt").inputValue(), task);
	const session = await page.evaluate(async () => (await window.flower.state()).selected);
	assert(await suggestions.isVisible());
	assert(await page.locator("#empty").isVisible());
	assert(await page.locator("#title").isVisible());
	await page.locator("#new-session").click();
	await page.waitForFunction(() => document.querySelectorAll("#sessions .session-row").length === 2);
	const otherSession = await page.evaluate(async () => (await window.flower.state()).selected);
	assert.notEqual(otherSession, session);
	assert.equal(await page.locator("#prompt").inputValue(), "");
	for (let press = 0; press < 2; press++) {
		await page.locator("#new-session").press("Enter");
		await page.waitForFunction(() => document.activeElement.id === "prompt");
		const { selected, sessions } = await page.evaluate(() => window.flower.state());
		assert.equal(selected, otherSession);
		assert.equal(sessions.length, 2);
	}
	assert.equal(await current.evaluate(() => globalThis.flowerQA.directoryPicks), 2);
	results.push("新建会话保留原草稿，同一个空白会话重复新建只聚焦输入框");
	assert(await page.locator("#empty").isVisible());
	await suggestion.press("Enter");
	assert.equal(await page.locator("#prompt").inputValue(), addition);
	assert.equal(fixture.observations.model.length, 0);
	await page.locator("#prompt").fill("第二条会话草稿");
	await page.locator("#assistant-home").click();
	await suggestions.waitFor();
	await page.locator("#prompt").fill("独立的首页草稿");
	const expectVisit = async (id, draft) => {
		await page.waitForFunction((id) => window.flower.state().then(({ selected }) => selected === id), id);
		await page.waitForFunction((draft) => document.querySelector("#prompt").value === draft, draft);
		assert.equal(await page.locator("#sessions .session-row").count(), 2);
	};
	assert(await forward.isDisabled());
	await back.press("Enter");
	await expectVisit(otherSession, "第二条会话草稿");
	await page.screenshot({ path: join(evidence, "新建空会话与导航.png") });
	await back.press("Enter");
	await expectVisit(session, task);
	await back.press("Enter");
	await expectVisit("", "独立的首页草稿");
	assert(await back.isDisabled());
	await forward.press("Enter");
	await expectVisit(session, task);
	await forward.press("Enter");
	await expectVisit(otherSession, "第二条会话草稿");
	await forward.press("Enter");
	await expectVisit("", "独立的首页草稿");
	assert(await forward.isDisabled());
	await back.press("Enter");
	await expectVisit(otherSession, "第二条会话草稿");
	await page.locator("#sessions .session-row").last().click();
	await expectVisit(session, task);
	assert(await forward.isDisabled());
	await page.locator("#assistant-home").click();
	await expectVisit("", "独立的首页草稿");
	results.push("键盘前进和后退恢复真实访问与独立草稿，边界停用，另行访问截断旧的前进记录");
	await page.locator("#sidebar-toggle").press("Enter");
	assert.equal(await page.locator("#sidebar-toggle").getAttribute("aria-expanded"), "false");
	assert(await page.locator("#assistant-home").isHidden());
	assert(await page.locator("#sidebar-back").isHidden());
	assert(await page.locator("#theme-open").isVisible());
	await page.screenshot({ path: join(evidence, "首页折叠侧栏.png") });
	await page.locator("#theme-open").click();
	await page.locator("#settings-appearance").click();
	await themeDialog.waitFor();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Control+k");
	const search = page.locator("#session-search");
	await search.waitFor();
	assert.equal(await page.evaluate(() => document.activeElement.id), "session-search");
	await search.fill("无匹配的测试字串");
	await page.locator("#session-search-empty").waitFor();
	await search.fill("新会话");
	assert.equal(await page.locator("#sessions .session-row").count(), 1);
	await page.screenshot({ path: join(evidence, "会话搜索.png") });
	await search.press("Enter");
	await page.waitForFunction((id) => window.flower.state().then((value) => value.selected === id), otherSession);
	await page.waitForFunction(() => document.querySelector("#prompt").value === "第二条会话草稿");
	await search.press("Escape");
	await page.locator("#assistant-home").click();
	await suggestions.waitFor();
	assert.equal(await page.locator("#prompt").inputValue(), "独立的首页草稿");
	await page.locator("#sessions .session-row").last().click();
	await page.waitForFunction((id) => window.flower.state().then((state) => state.selected === id), session);
	await page.waitForFunction((text) => document.querySelector("#prompt").value === text, task);
	results.push("建议追加草稿并聚焦，首页和已有会话草稿分开。侧栏折叠保留设置，键盘搜索可打开真实会话");
	assert.deepEqual(await page.evaluate((id) => window.flower.history(id), session), []);
	assert.equal(await current.evaluate(() => globalThis.offlineRequests), 0);
	for (const path of [legacyCredential, legacyWorkspace]) {
		assert.equal(await readFile(path, "utf8"), "应保持原样的旧资料");
	}
	results.push("全新本机资料离线进入正式工作台，选目录、建会话、读空历史，无出站请求，旧资料原样保留");
	assert.equal(fixture.observations.model.length, 0);
	assert(await page.locator("#model-dialog").isHidden());
	results.push("发送箭头的键盘焦点可见，空任务停用；取消或确认目录都保留草稿，选择后仍需再次确认");
	await page.locator("#send").click();
	await page.locator("#model-dialog").waitFor();
	assert.equal(await page.locator("#base-url").inputValue(), "");
	await page.locator("#base-url").fill(fixture.baseUrl);
	await page.screenshot({ path: join(evidence, "模型设置.png") });
	await fillModel(page, { ...fixture, modelId: "" });
	assert.equal(await page.locator("#prompt").inputValue(), task);
	assert.equal(await current.evaluate(() => globalThis.offlineRequests), 0);
	assert.equal(fixture.observations.discovery.length, 0);
	await current.evaluate(() => {
		globalThis.fetch = globalThis.originalFetch;
	});
	await current.context().setOffline(false);
	assert.equal(fixture.observations.model.length, 0);
	const picker = await openPicker(page);
	const defaultChoice = picker.getByRole("button", { name: fixture.modelId, exact: true });
	await defaultChoice.waitFor();
	await page.screenshot({ path: join(evidence, "模型选择-深色.png") });
	await defaultChoice.press("Enter");
	await picker.waitFor({ state: "hidden" });
	const input = page.locator("#prompt");
	assert.equal(await input.inputValue(), task);
	assert.deepEqual(fixture.observations.discovery, [{ hasAuthorization: false, tokenMatches: true }]);
	await input.press("End");
	await input.press("Shift+Enter");
	assert.equal(await input.inputValue(), `${task}\n`);
	await input.dispatchEvent("compositionstart", { data: "清" });
	await input.press("Enter");
	await input.dispatchEvent("compositionend", { data: "清" });
	assert.equal(await page.locator(".task").count(), 0);
	assert.equal(fixture.observations.model.length, 0);
	const enteredText = await input.inputValue();
	await input.press("Enter");
	const firstTask = page.locator('.task[data-status="succeeded"]').filter({ hasText: "行动项：核对库存清单" });
	await firstTask.waitFor();
	assert(await suggestions.isHidden());
	assert(await page.locator("#empty").isHidden());
	assert((await composer.boundingBox()).height < homeLayout.height - 20);
	assert.equal(await firstTask.locator(".user-message-text").textContent(), enteredText);
	assert(await firstTask.locator(".message-file").isHidden());
	await page.locator("#prompt").fill("延续刚才的会话，提醒我第一个行动项");
	await page.locator("#send").click();
	await page.locator('.task[data-status="succeeded"]').filter({ hasText: "沿用上一轮：核对库存清单" }).waitFor();
	await page.locator("#prompt").fill("这个草稿留在原会话");
	await page.locator("#new-session").click();
	await page.waitForFunction(() => document.querySelectorAll("#sessions .session-row").length === 3);
	assert.equal(await page.locator("#prompt").inputValue(), "");
	await page.locator("#sessions .session-row").last().click();
	await page.waitForFunction(() => document.querySelector("#prompt").value === "这个草稿留在原会话");
	assert(await firstTask.isVisible());
	assert(await suggestions.isHidden());
	results.push("有工作区的空会话保留品牌和建议，第一次提交切换到消息流，返回已有会话直接显示历史");
	await openPicker(page);
	await picker.getByRole("button", { name: alternate, exact: true }).click();
	await page.waitForFunction((id) => document.querySelector("#model").textContent === id, alternate);
	assert.equal(await input.inputValue(), "这个草稿留在原会话");
	results.push("首页先输入自由任务，授权工作区时保留草稿，非 Excel 工具与连续会话通过");
	await current.evaluate(
		({ BrowserWindow }, path) => {
			const window = BrowserWindow.getAllWindows()[0];
			window.setSize(660, 615);
			globalThis.flowerQA.file = path;
		},
		join(workspace, longFilename),
	);
	await page.locator("#composer-add").click();
	await page.locator("#file").click();
	await page.waitForFunction((name) => document.querySelector("#attachment .file-chip")?.title === name, longFilename);
	assert(await input.isVisible());
	assert(await page.locator("#send").isVisible());
	assert(
		await page.evaluate(() => {
			const file = document.querySelector("#attachment .chip-name");
			return (
				innerWidth <= 660 && document.documentElement.scrollWidth === innerWidth && file.scrollWidth > file.clientWidth
			);
		}),
	);
	await page.screenshot({ path: join(evidence, "窄窗口.png") });
	await openPicker(page);
	const selectedModel = picker.getByRole("button", { name: alternate, exact: true });
	await selectedModel.waitFor();
	assert.equal(await selectedModel.getAttribute("aria-label"), alternate);
	assert.equal(await selectedModel.getAttribute("aria-current"), "true");
	assert.equal(
		await picker.getByRole("button", { name: fixture.modelId, exact: true }).getAttribute("aria-label"),
		fixture.modelId,
	);
	const pickerBox = await picker.boundingBox();
	assert(pickerBox.x >= 0 && pickerBox.y >= 0 && pickerBox.x + pickerBox.width <= 660);
	await page.screenshot({ path: join(evidence, "模型选择-窄窗.png") });
	await page.keyboard.press("Escape");
	await picker.waitFor({ state: "hidden" });
	await themeButton.click();
	await page.locator("#settings-appearance").click();
	await themeDialog.waitFor();
	assert(
		await themeDialog.evaluate((element) => {
			const { width, height } = element.getBoundingClientRect();
			const layout = element.querySelector(".theme-layout");
			const footer = element.querySelector(".settings-actions");
			return (
				width < innerWidth &&
				height < innerHeight &&
				element.clientWidth === element.scrollWidth &&
				getComputedStyle(layout).gridTemplateColumns.split(" ").length === 1 &&
				footer.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom
			);
		}),
	);
	await themeDialog.locator(".theme-preview").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(evidence, "主题设置-窄窗.png") });
	await themeDialog.press("Escape");
	await themeDialog.waitFor({ state: "hidden" });
	await current.evaluate(({ BrowserWindow }, path) => {
		BrowserWindow.getAllWindows()[0].setSize(1180, 790);
		globalThis.flowerQA.file = path;
	}, book);
	await page.locator("#attachment .chip-remove").click();
	await page.locator("#attachment").waitFor({ state: "hidden" });
	await page.locator("#composer-add").click();
	await page.locator("#file").click();
	await page.waitForFunction(() => document.querySelector("#attachment").textContent === "orders.xlsx");
	const externalNote = join(evidence, "外部备注.txt");
	await writeFile(externalNote, "用户主动选择的外部测试资料");
	await current.evaluate((_electron, path) => {
		globalThis.flowerQA.file = path;
	}, externalNote);
	await page.locator("#composer-add").click();
	await page.locator("#file").click();
	await page.locator("#attachment .chip-name").getByText("外部备注.txt", { exact: true }).waitFor();
	await page.getByRole("button", { name: "移除 外部备注.txt", exact: true }).click();

	// 只计实际发起的历史读取。缓存命中和复用在途读取会保留原有标记。
	await page.evaluate(`(() => {
		const load = reloadHistory;
		const counts = new Map();
		window.flowerQAHistoryReads = counts;
		reloadHistory = (id) => {
			const previous = timelines.get(id)?.reading;
			const result = load(id);
			const reading = timelines.get(id)?.reading;
			if (reading && reading !== previous) counts.set(id, (counts.get(id) ?? 0) + 1);
			return result;
		};
	})()`);
	await page.locator("#prompt").fill("取消用例");
	await page.locator("#send").click();
	await page.waitForFunction(() => document.querySelector("#timeline").textContent.includes("准备处理"));
	assert.equal(fixture.observations.model.at(-1).model, alternate);
	await page.locator("#prompt").fill("运行期间留在会话内的草稿");
	await page.locator("#sessions .session-row").nth(1).click();
	await page.waitForFunction(() => document.querySelector("#prompt").value === "第二条会话草稿");
	assert(!(await page.locator("#timeline").textContent()).includes("准备处理"));
	await back.press("Enter");
	await page.waitForFunction(() => document.querySelector("#prompt").value === "运行期间留在会话内的草稿");
	assert(await page.locator('.task[data-status="running"]').filter({ hasText: "准备处理" }).isVisible());
	await page.screenshot({ path: join(evidence, "返回运行中的会话.png") });
	results.push("切到其他会话再后退时，恢复运行状态、已流出的消息和原草稿");
	await input.fill("排队取消验证");
	await send.click();
	const queued = page.locator(".task").filter({ hasText: "排队取消验证" });
	await queued.waitFor();
	await openPicker(page);
	await picker.getByText("运行和排队任务结束后可切换模型。").waitFor();
	assert(await picker.getByRole("button", { name: fixture.modelId, exact: true }).isDisabled());
	assert(await picker.locator("#model-manual-save").isDisabled());
	await assert.rejects(
		page.evaluate(async (id) => {
			const { modelRevision } = await window.flower.state();
			return window.flower.chooseModel(id, modelRevision);
		}, fixture.modelId),
		/运行和排队/,
	);
	await page.keyboard.press("Escape");
	await queued.getByRole("button", { name: "取消任务", exact: true }).click();
	await page
		.locator(".task")
		.filter({ hasText: "取消用例" })
		.getByRole("button", { name: "取消任务", exact: true })
		.click();
	await page.waitForFunction(() => document.querySelectorAll('.task[data-status="cancelled"]').length === 2);
	await wait(() => fixture.observations.interrupted > 0);
	results.push("无 Key 的服务仅在主动打开时列出实际模型，切换保留草稿并驱动后续 SSE，运行和排队阻止切换");

	const readCount = () => page.evaluate(`window.flowerQAHistoryReads.get(${JSON.stringify(session)}) ?? 0`);
	const cachedSessions = () => page.evaluate("[...timelines.keys()]");
	const select = async (id) => {
		await page.evaluate((id) => window.flower.selectSession(id), id);
		await page.waitForFunction((id) => window.flower.state().then(({ selected }) => selected === id), id);
	};
	const newest = await page.evaluate(() => window.flower.state().then(({ sessions }) => sessions[0].id));
	const backgroundPrompt = "取消用例后台终态";
	await input.fill(backgroundPrompt);
	await send.click();
	const backgroundTask = page.locator(".task").filter({ hasText: backgroundPrompt });
	await backgroundTask.getByText("准备处理").waitFor();
	const backgroundId = await backgroundTask.getAttribute("data-request");
	await input.fill("等待读取历史时保留的草稿");
	await wait(() => page.evaluate("!timelines.get(session)?.reading"));
	const readsBeforeBackground = await readCount();
	assert(readsBeforeBackground >= 1);
	await select(otherSession);
	await select(newest);
	assert((await cachedSessions()).includes(session));
	await page.evaluate(({ session, backgroundId }) => window.flower.cancel(session, backgroundId), {
		session,
		backgroundId,
	});
	await wait(async () => !(await cachedSessions()).includes(session));
	assert.equal(await readCount(), readsBeforeBackground);
	assert.equal((await cachedSessions()).length, 2);
	await back.press("Enter");
	await page.waitForFunction(() => document.querySelector("#prompt").value === "第二条会话草稿");
	await back.press("Enter");
	await backgroundTask.and(page.locator('[data-status="cancelled"]')).waitFor();
	assert.equal(await input.inputValue(), "等待读取历史时保留的草稿");
	assert.equal(await readCount(), readsBeforeBackground + 1);
	for (let i = 0; i < 3; i++) {
		await forward.press("Enter");
		await page.waitForFunction(() => document.querySelector("#prompt").value === "第二条会话草稿");
		await back.press("Enter");
		await backgroundTask.and(page.locator('[data-status="cancelled"]')).waitFor();
	}
	assert.equal(await readCount(), readsBeforeBackground + 1);
	assert.equal((await cachedSessions()).length, 2);
	results.push("后台在途会话跨两次导航仍保留，终态后释放且后台零回读，重新打开只读一次，三轮前进后退复用缓存");

	// 附件属于本次消息，取消任务后新消息需要重新选择。
	await current.evaluate((_electron, path) => {
		globalThis.flowerQA.file = path;
	}, book);
	await page.locator("#composer-add").click();
	await page.locator("#file").click();
	await page.locator("#attachment .chip-name").getByText("orders.xlsx").waitFor();
	const workbookPrompt = "按部门汇总订单金额，生成分析报告和汇总工作簿";
	await page.locator("#prompt").fill(workbookPrompt);
	await page.locator("#send").click();
	const running = page.locator('.task[data-status="running"]').filter({ hasText: "正在整理汇总结果" });
	await running.waitFor();
	const steps = running.locator("summary");
	await steps.focus();
	await steps.press("Enter");
	assert(await steps.evaluate((node) => node.parentElement.open));
	await page.locator("#thread-scroll").evaluate((node) => {
		node.scrollTop = node.scrollHeight;
	});
	await page.screenshot({ path: join(evidence, "执行中.png") });
	await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 580));
	await page.waitForFunction(() => innerHeight <= 580);
	const position = await page.locator("#thread-scroll").evaluate((node) => {
		node.scrollTop = 0;
		return { offset: node.scrollTop, overflow: node.scrollHeight - node.clientHeight };
	});
	assert(position.overflow >= 65);
	const completedWorkbook = page.locator('.task[data-status="succeeded"]').filter({ hasText: "合计 500" });
	await completedWorkbook.waitFor();
	const finalSteps = completedWorkbook.locator("summary");
	assert(await finalSteps.evaluate((node) => node.parentElement.open && document.activeElement === node));
	const finalOffset = await page.locator("#thread-scroll").evaluate((node) => node.scrollTop);
	assert.equal(finalOffset, position.offset, `流式期间阅读位置改变，初始溢出 ${position.overflow}`);
	await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 790));
	results.push("Enter 提交、Shift+Enter 换行、中文组合事件、660px 长文件名及流式阶段的展开、焦点和滚动均通过");
	await page.getByRole("button", { name: "打开分析报告" }).waitFor();
	const previewReport = page.getByRole("button", { name: "预览分析报告" });
	await previewReport.click();
	await page.locator("#panel-content .markdown-reply h1").waitFor();
	assert.match(await page.locator("#panel-location").textContent(), /分析报告\.md/);
	await page.locator("#workspace-panel-close").click();
	assert(await previewReport.evaluate((node) => node === document.activeElement));
	assert.match(await completedWorkbook.textContent(), /合计 500/);
	assert.equal(await completedWorkbook.locator(".message-file").textContent(), "orders.xlsx");
	assert.equal(await completedWorkbook.locator(".user-message-text").textContent(), workbookPrompt);
	await page.getByRole("button", { name: "打开汇总工作簿" }).click();
	const result = await wait(() => current.evaluate(() => globalThis.flowerQA.artifacts.at(-1)));
	assert(result.endsWith("\\汇总.xlsx"));
	const report = await readFile(join(dirname(result), "分析报告.md"), "utf8");
	assert.match(report, /合计：500/);
	assert.match(report, /A：250/);
	assert.match(report, /B：250/);
	assert.equal(
		createHash("sha256")
			.update(await readFile(book))
			.digest("hex"),
		original,
	);
	await page.screenshot({ path: join(evidence, "交付物.png") });
	await captureNative("会话-含系统标题栏.png");
	// 在另一个会话验证用户原话，保证交付截图只展示常规任务。
	const separate = await page.evaluate((id) => window.flower.newSession(id), session);
	await page.waitForFunction((id) => window.flower.state().then((state) => state.selected === id), separate);
	const originalText = `${task}\n\n已选择的工作区相对路径："notes.txt"\n`;
	await page.locator("#prompt").fill(originalText);
	await page.locator("#send").click();
	await firstTask.waitFor();
	assert.equal(await firstTask.locator(".user-message-text").textContent(), originalText);
	assert(await firstTask.locator(".message-file").isHidden());
	await page.evaluate((id) => window.flower.selectSession(id), session);
	assert(fixture.observations.model.every(({ hasAuthorization }) => !hasAuthorization));
	const previousRevision = await page.evaluate(async () => (await window.flower.state()).modelRevision);
	await openPicker(page);
	await page.locator("#settings").click();
	await page.locator("#settings-service").click();
	await page.locator("#settings-service-options").getByRole("option", { name: "添加服务", exact: true }).click();
	await fillModel(page, protectedFixture, testKey);
	await assert.rejects(
		page.evaluate(({ alternate, previousRevision }) => window.flower.chooseModel(alternate, previousRevision), {
			alternate,
			previousRevision,
		}),
		/设置已变化/,
	);
	await openPicker(page);
	await picker.getByText("服务未提供模型列表，可手动输入模型名。").waitFor();
	assert.deepEqual(await picker.locator("#model-options button").allTextContents(), [protectedFixture.modelId]);
	await picker.locator("#model-manual").fill(manualModel);
	await page.screenshot({ path: join(evidence, "模型选择-手动输入.png") });
	await picker.locator("#model-manual-save").click();
	await page.waitForFunction((id) => document.querySelector("#model").textContent === id, manualModel);
	const modelSettingsPath = join(profile, "local-workbench", "model.json");
	const diskModel = await readFile(modelSettingsPath, "utf8");
	assert.doesNotMatch(diskModel, new RegExp(testKey));
	assert(JSON.parse(diskModel).services.some(({ encryptedKey }) => encryptedKey));
	assert(!JSON.stringify(await page.evaluate(() => window.flower.state())).includes(testKey));
	results.push("无 Key 回环模型、作用域拒绝、真 pi 工具和取消通过，双产物生成且源表不变，设置保存使用 Windows DPAPI");
	await close();

	page = await boot(productArg, profile);
	await prepareDialogs();
	await ready(page);
	assert.equal(await page.locator("#model").textContent(), manualModel);
	assert.equal(await page.evaluate(() => document.documentElement.dataset.scheme), "dark");
	assert.equal(await page.locator("#empty-title").textContent(), titleText);
	assert.equal(await page.locator("#prompt").getAttribute("placeholder"), promptText);
	assert.equal(await page.evaluate(() => window.flowerTheme.saved.accent), "#24a98a");
	assert.equal(await page.evaluate(() => window.flowerTheme.saved.success), "#35ae6c");
	assert.equal(await page.evaluate(() => window.flowerTheme.saved.danger), "#eb7280");
	await page.locator("#theme-open").click();
	await page.locator("#settings-appearance").click();
	await page.locator(".theme-default").click();
	await page.locator(".theme-save").click();
	assert.equal(await page.locator("#empty-title").textContent(), "你想完成什么？");
	assert.equal(await page.locator("#prompt").getAttribute("placeholder"), "描述你想完成的工作…");
	assert.equal(await page.evaluate(() => window.flowerTheme.saved.mode), "system");
	assert.equal(await page.locator("#model").textContent(), manualModel);
	results.push("真机重启恢复深色、自定义强调色和首页文案，恢复默认后模型与工作台历史继续可用");
	const restoredWorkbook = page.locator('.task[data-status="succeeded"]').filter({ hasText: "合计 500" });
	await restoredWorkbook.waitFor();
	assert.equal(await restoredWorkbook.locator(".user-message-text").textContent(), workbookPrompt);
	assert.equal(await restoredWorkbook.locator(".message-file").textContent(), "orders.xlsx");
	assert.match(await page.locator("#timeline").textContent(), /合计 500/);
	assert.match(await page.locator("#timeline").textContent(), /沿用上一轮：核对库存清单/);
	await page.getByRole("button", { name: "打开分析报告" }).waitFor();
	assert.equal(await page.locator('.task[data-status="cancelled"]').count(), 3);
	await page.evaluate((id) => window.flower.selectSession(id), separate);
	const restoredFirst = page.locator('.task[data-status="succeeded"]').filter({ hasText: "行动项：核对库存清单" });
	await page.waitForFunction(
		(text) => document.querySelector("#timeline .user-message-text")?.textContent === text,
		originalText,
	);
	assert(await restoredFirst.locator(".message-file").isHidden());
	results.push("用户亲写的附件同形句及末尾换行完整保留，真实附件独立显示，重启回读一致");
	await openPicker(page);
	await page.locator("#settings").click();
	await page.locator("#settings-edit-service").click();
	assert.equal(await page.locator("#api-key").inputValue(), "");
	await page.locator("#settings-close-dialog").click();
	await page.locator("#prompt").fill("请读取 notes.txt 并列出 Windows 行动项");
	await page.locator("#send").click();
	await restoredFirst.nth(1).waitFor();
	assert(
		protectedFixture.observations.model.every(({ tokenMatches, hasAuthorization }) => tokenMatches && hasAuthorization),
	);
	assert(protectedFixture.observations.model.length > 0);
	assert(protectedFixture.observations.model.every(({ model }) => model === manualModel));
	assert(
		protectedFixture.observations.discovery.every(
			({ tokenMatches, hasAuthorization }) => tokenMatches && hasAuthorization,
		),
	);
	results.push("服务缺列表时保留当前值并允许手填，重启恢复手填模型并发出实际流请求，Key 只在 Host 使用");
	const proof = {
		results,
		chrome,
		homeLayout,
		settingsLayout,
		keyless: fixture.observations,
		keyed: protectedFixture.observations,
		original,
		workbook: result,
	};
	await writeFile(join(evidence, "result.json"), JSON.stringify(proof, null, 2));
	console.log(JSON.stringify(proof));
} finally {
	await close();
	await fixture.close();
	await protectedFixture.close();
}
