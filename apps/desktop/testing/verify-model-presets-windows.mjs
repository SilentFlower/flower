import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { startMockModel } from "./mock-model.mjs";

const [exeArg, evidenceArg, toolingArg] = process.argv.slice(2);
assert(
	process.platform === "win32" && toolingArg,
	"用法：verify-model-presets-windows.mjs <EXE> <新证据目录> <Playwright>",
);
const executablePath = resolve(exeArg);
const evidence = resolve(evidenceArg);
const profile = join(evidence, "profile");
const workspace = join(evidence, "合成工作区");
const data = join(profile, "local-workbench");
const modelFile = join(data, "model.json");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
const claude = "claude-sonnet-5-5";
const deepseek = "deepseek-flash";
const sdkKnown = "gpt-5.2";
const unknown = "local-unknown-qa";
const declares = new Map();
const key = "flower-isolated-preset-qa";
await mkdir(evidence);
await mkdir(workspace);
const remote = await startMockModel({
	model: claude,
	alternatives: [deepseek, sdkKnown, unknown],
	apiKey: key,
	effortByModel: declares,
});
let app;
let page;
const cases = [];
const by = (id) => page.locator(`#${id}`);
const state = () => page.evaluate(() => window.flower.state());
const editButton = (model) =>
	by("settings-model-cards").getByRole("button", { name: `编辑模型：${model}`, exact: true });
const modelButton = (model) => by("settings-model-cards").getByRole("button", { name: model, exact: true });

const cardSurface = (button) =>
	button.evaluate((node) => {
		const card = node.closest(".catalog-model-card");
		const style = getComputedStyle(card);
		return {
			background: style.backgroundColor,
			border: style.borderTopColor,
			buttons: [...card.querySelectorAll("button")].map((control) => {
				const css = getComputedStyle(control);
				return {
					background: css.backgroundColor,
					border: css.borderTopColor,
					title: control.getAttribute("title"),
				};
			}),
		};
	});

async function size(width, height = 801) {
	await app.evaluate(
		({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0].setContentSize(...dimensions),
		[width, height],
	);
	await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
}

async function boot() {
	app = await electron.launch({
		executablePath,
		chromiumSandbox: true,
		timeout: 30_000,
		args: [`--user-data-dir=${profile}`],
	});
	page = await app.firstWindow();
	await app.evaluate(
		({ app, dialog }, paths) => {
			if (!app.isPackaged || app.getPath("userData").toLowerCase() !== paths.profile.toLowerCase()) {
				throw new Error("候选程序或隔离资料目录不匹配");
			}
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.workspace] });
		},
		{ profile, workspace },
	);
	await page.waitForFunction(() => !document.querySelector("#model-picker-open").disabled);
	await size(1282);
}

async function close() {
	await app.close();
	app = undefined;
}

async function screenshot(name) {
	await page.screenshot({ path: join(evidence, `${name}.png`) });
}

async function focusIs(id) {
	await page.waitForFunction((value) => document.activeElement.id === value, id);
}

async function openOverview() {
	await by("theme-open").click();
	await by("model-overview").waitFor();
	await focusIs("model-title");
}

async function edit(model) {
	await editButton(model).click();
	await by("model-editor-identity").getByText(model, { exact: true }).waitFor();
	assert(await by("model-id").isHidden());
}

async function finishEdit() {
	await by("save-settings").click();
	await by("model-overview").waitFor();
}

async function changeMode(mode) {
	await by("model-capability").getByText(mode, { exact: true }).click();
	assert(await by("model-capability").getByRole("radio", { name: mode, exact: true }).isChecked());
}

const effortChip = (name) => by("model-levels").getByRole("button", { name, exact: true });

async function closeSettings() {
	await by("settings-close-dialog").click();
	await focusIs("theme-open");
}

async function send(model, effort, label, thinking) {
	const before = remote.observations.requestFields.length;
	const prompt = `延续刚才的会话，验证配置 ${label}`;
	await by("prompt").fill(prompt);
	await by("send").click();
	await page.locator('.task[data-status="succeeded"]').filter({ hasText: prompt }).waitFor();
	const [wire, ...extra] = remote.observations.requestFields.slice(before);
	assert(wire && !extra.length);
	assert.equal(wire.path, "/compatible/v1/chat/completions");
	assert.equal(wire.model, model);
	assert(wire.tokenMatches && !wire.hasAnthropicHeaders);
	assert(!wire.keys.some((key) => ["output_config", "reasoning"].includes(key)));
	assert.equal(wire.keys.includes("reasoning_effort"), Boolean(effort));
	assert.equal(wire.reasoning, effort);
	assert.equal(wire.thinking, thinking);
	cases.push({ label, ...wire });
}

async function chooseModel(model) {
	const card = modelButton(model);
	await card.click();
	await page.waitForFunction((id) => document.querySelector("#model").textContent === id, model);
	await card.and(page.locator('[aria-pressed="true"]')).waitFor();
}

async function setEffort(effort) {
	const { modelRevision } = await state();
	await page.evaluate(({ effort, revision }) => window.flower.setModelEffort(effort, revision), {
		effort,
		revision: modelRevision,
	});
}

try {
	await boot();
	const encryptedKey = await app.evaluate(
		({ safeStorage }, value) => safeStorage.encryptString(value).toString("base64"),
		key,
	);
	await close();
	await mkdir(data, { recursive: true });
	const previous = [claude, deepseek].map((id) => ({
		id,
		mode: "standard",
		levels: ["low", "medium", "high"],
		effort: "high",
	}));
	await writeFile(
		modelFile,
		JSON.stringify({
			version: 2,
			activeId: "newapi-fixture",
			services: [
				{ id: "newapi-fixture", name: "newapi", baseUrl: remote.baseUrl, modelId: claude, models: previous, encryptedKey },
			],
		}),
	);
	await boot();
	assert.equal(remote.observations.discovery.length, 0);
	assert.deepEqual((await state()).modelSettings.models, previous);
	assert.equal((await state()).modelSettings.effort, "high");
	await by("prompt").fill("等待模型操作后保留的草稿");
	await openOverview();
	assert.match(await by("settings-service").textContent(), /newapi/);
	assert.equal(await by("model-title").evaluate((title) => getComputedStyle(title).outlineStyle), "none");
	const overview = await by("model-dialog").boundingBox();
	assert(
		overview.width > 550 && overview.x + overview.width <= (await page.evaluate(() => innerWidth)),
		JSON.stringify(overview),
	);
	await screenshot("浅色-模型总览");

	const selectClaude = modelButton(claude);
	const editClaude = editButton(claude);
	const neutral = await cardSurface(selectClaude);
	const pencilRest = await editClaude.evaluate((node) => getComputedStyle(node).color);
	await selectClaude.locator(".catalog-model-name").hover();
	const nameHover = await cardSurface(selectClaude);
	assert.notEqual(nameHover.background, neutral.background);
	assert.notEqual(nameHover.border, neutral.border);
	assert.deepEqual(
		nameHover.buttons,
		Array.from({ length: 2 }, () => ({ background: "rgba(0, 0, 0, 0)", border: "rgba(0, 0, 0, 0)", title: null })),
	);
	await screenshot("浅色-悬停模型名");
	await page.mouse.down();
	const pressed = await cardSurface(selectClaude);
	await page.mouse.up();
	assert.notEqual(pressed.background, nameHover.background);
	assert.deepEqual(pressed.buttons, nameHover.buttons);
	await editClaude.hover();
	assert.deepEqual(await cardSurface(editClaude), nameHover);
	assert.notEqual(await editClaude.evaluate((node) => getComputedStyle(node).color), pencilRest);
	await screenshot("浅色-悬停铅笔");

	await by("settings-add-model").focus();
	await page.keyboard.press("Tab");
	assert(
		await selectClaude.evaluate(
			(node) => node.matches(":focus-visible") && getComputedStyle(node).outlineWidth === "2px",
		),
	);
	await screenshot("键盘-模型名焦点");
	await page.keyboard.press("Tab");
	assert(
		await editClaude.evaluate((node) => node.matches(":focus-visible") && getComputedStyle(node).outlineWidth === "2px"),
	);
	await screenshot("键盘-铅笔焦点");
	await page.emulateMedia({ forcedColors: "active" });
	assert(await page.evaluate(() => matchMedia("(forced-colors: active)").matches));
	await screenshot("高对比-铅笔焦点");
	await page.emulateMedia({ forcedColors: "none" });

	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	assert(await editButton(deepseek).evaluate((node) => document.activeElement === node));
	await page.keyboard.press("Enter");
	assert.equal(await by("model-id").inputValue(), deepseek);
	assert.equal((await state()).model, claude);
	await by("close-settings").click();
	assert(await editButton(deepseek).evaluate((node) => document.activeElement === node));

	await by("settings-service").focus();
	await page.keyboard.press("ArrowDown");
	const providers = by("settings-service-options");
	await providers.waitFor();
	const serviceOption = providers.getByRole("option", { name: "newapi", exact: true });
	assert.equal(await serviceOption.getAttribute("aria-selected"), "true");
	await page.keyboard.press("End");
	await page.waitForFunction(() => document.activeElement.getAttribute("aria-label") === "添加服务");
	await screenshot("浅色-服务商菜单");
	await page.keyboard.press("Escape");
	await focusIs("settings-service");
	assert(await providers.isHidden());

	await edit(claude);
	const manual = by("model-capability").getByRole("radio", { name: "手动", exact: true });
	const recommended = by("model-capability").getByRole("radio", { name: "推荐", exact: true });
	assert(await manual.isChecked());
	assert(await by("model-recommendation").isHidden());
	assert(await by("settings-discover").isHidden());
	assert(await by("settings-appearance").isVisible());
	assert.deepEqual(await by("model-levels").locator('[aria-pressed="true"]').allTextContents(), ["低", "中", "高"]);
	const editor = await by("model-dialog").boundingBox();
	assert(editor.width === overview.width, JSON.stringify(editor));
	await screenshot("浅色-编辑模型-手动");
	await manual.focus();
	await page.keyboard.press("ArrowLeft");
	assert(await recommended.isChecked());
	assert(await recommended.evaluate((radio) => radio.matches(":focus-visible")));
	await by("model-recommendation-source").getByText("pi 本地目录", { exact: true }).waitFor();
	assert.equal(await by("model-recommendation-levels").textContent(), "低 · 中 · 高 · 很高 · 最高");
	assert(await by("model-levels").isHidden());
	await screenshot("浅色-编辑模型-推荐");
	await page.keyboard.press("Escape");
	await by("model-overview").waitFor();
	assert(await editButton(claude).evaluate((button) => button === document.activeElement));
	assert.deepEqual((await state()).modelSettings.models, previous);
	await edit(deepseek);
	await changeMode("推荐");
	await by("model-recommendation-source").getByText("pi 本地目录", { exact: true }).waitFor();
	assert.equal(await by("model-recommendation-levels").textContent(), "关闭思考 · 低 · 高 · 最高");
	await changeMode("手动");
	await finishEdit();
	assert.equal((await state()).model, claude);
	assert(await editButton(deepseek).evaluate((button) => button === document.activeElement));
	assert.equal(remote.observations.discovery.length, 0);

	await by("settings-appearance").click();
	await page.locator(".theme-settings").getByText("深色", { exact: true }).click();
	await by("theme-picker").fill("#bf6c35");
	await page.locator(".theme-save").click();
	await size(660, 710);
	await openOverview();
	assert(await by("model-dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth));
	await editClaude.hover();
	const darkPencil = await cardSurface(editClaude);
	await selectClaude.locator(".catalog-model-name").hover();
	assert.deepEqual(await cardSurface(selectClaude), darkPencil);
	await screenshot("深色窄窗-模型总览");
	await edit(deepseek);
	assert(
		await by("model-dialog").evaluate((dialog) => {
			const bounds = dialog.getBoundingClientRect();
			return bounds.left >= 0 && bounds.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
		}),
	);
	assert.equal(await page.evaluate(() => window.flowerTheme.saved.accent), "#bf6c35");
	await manual.focus();
	await page.keyboard.press("Tab");
	const off = effortChip("关闭思考");
	assert(await off.evaluate((chip) => chip.matches(":focus-visible") && getComputedStyle(chip).outlineWidth === "2px"));
	await page.keyboard.press("Space");
	assert.equal(await off.getAttribute("aria-pressed"), "true");
	await page.keyboard.press("Space");
	assert.equal(await off.getAttribute("aria-pressed"), "false");
	await screenshot("深色窄窗-编辑模型-手动");
	await by("close-settings").click();
	await closeSettings();
	assert.equal(await by("prompt").inputValue(), "等待模型操作后保留的草稿");

	await page.evaluate(() => window.flower.chooseWorkspace());
	await by("prompt").fill("取消用例：模型卡禁用态");
	await by("send").click();
	const busy = page.locator(".task").filter({ hasText: "取消用例：模型卡禁用态" });
	await busy.getByText("准备处理").waitFor();
	await openOverview();
	assert(await selectClaude.isDisabled());
	assert(await editClaude.isDisabled());
	const disabled = await cardSurface(selectClaude);
	await editClaude.hover();
	assert.deepEqual(await cardSurface(editClaude), disabled);
	await closeSettings();
	await busy.getByRole("button", { name: "取消任务", exact: true }).click();
	await busy.and(page.locator('[data-status="cancelled"]')).waitFor();
	await send(claude, "high", "旧 Claude 手动高");
	await openOverview();
	await chooseModel(deepseek);
	await closeSettings();
	await send(deepseek, "high", "旧 DeepSeek 手动高");
	await close();

	await boot();
	assert.equal((await state()).modelSettings.effort, "high");
	assert.deepEqual((await state()).modelSettings.models, previous);
	assert.equal(await page.locator("html").getAttribute("data-scheme"), "dark");
	await openOverview();
	await edit(deepseek);
	await changeMode("推荐");
	await finishEdit();
	assert(await editButton(deepseek).evaluate((button) => button === document.activeElement));
	assert.deepEqual((await state()).modelSettings.available, ["off", "low", "high", "max"]);
	await closeSettings();
	await setEffort("max");
	await send(deepseek, "max", "DeepSeek 内置最高");
	await assert.rejects(setEffort("default"), /不支持/);
	await setEffort("off");
	await send(deepseek, undefined, "DeepSeek 经网关关闭思考", "disabled");

	declares.set(deepseek, ["low"]);
	await openOverview();
	await by("settings-add-model").click();
	await by("settings-discover").click();
	await by("settings-models").getByRole("button", { name: deepseek, exact: true }).click();
	await by("model-recommendation-source").getByText("服务模型列表", { exact: true }).waitFor();
	assert.equal(await by("model-recommendation-levels").textContent(), "关闭思考 · 低");
	assert.deepEqual((await state()).modelSettings.available, ["off", "low"]);
	await by("close-settings").click();
	await closeSettings();
	await setEffort("low");
	await send(deepseek, "low", "DeepSeek 服务声明低");

	await openOverview();
	await chooseModel(claude);
	await edit(claude);
	await changeMode("推荐");
	await finishEdit();
	await closeSettings();
	assert.deepEqual((await state()).modelSettings.available, ["low", "medium", "high", "xhigh", "max"]);
	await setEffort("low");
	await send(claude, "low", "Claude 不可关闭时的最低档");
	await setEffort("xhigh");
	await send(claude, "xhigh", "Claude 目录很高");
	await setEffort("max");
	await send(claude, "max", "Claude 目录最高");

	declares.set(claude, ["low", "max"]);
	await openOverview();
	await by("settings-add-model").click();
	await by("settings-discover").click();
	await by("settings-models").getByRole("button", { name: claude, exact: true }).click();
	await by("model-recommendation-source").getByText("服务模型列表", { exact: true }).waitFor();
	assert.equal(await by("model-recommendation-levels").textContent(), "低 · 最高");
	await by("close-settings").click();
	await closeSettings();
	await assert.rejects(setEffort("xhigh"), /不支持/);
	await setEffort("max");
	await send(claude, "max", "Claude 服务声明最高");
	await close();

	const requestsBeforeRestart = remote.observations.discovery.length;
	await boot();
	assert.equal(remote.observations.discovery.length, requestsBeforeRestart);
	assert.equal((await state()).modelSettings.effort, "max");
	await send(claude, "max", "重启后保留 Claude 服务声明");
	await openOverview();
	await chooseModel(deepseek);
	assert.deepEqual((await state()).modelSettings.available, ["off", "low"]);
	assert.equal((await state()).modelSettings.effort, "low");
	await edit(deepseek);
	await changeMode("服务默认");
	assert(await by("model-default-effort").isVisible());
	assert(await by("model-recommendation").isHidden());
	assert(await by("model-levels").isHidden());
	await finishEdit();
	await closeSettings();
	await send(deepseek, undefined, "手动禁用推理参数");

	const discoveryBeforeManualEntry = remote.observations.discovery.length;
	await openOverview();
	await by("settings-add-model").click();
	await by("model-id").fill(sdkKnown);
	await by("model-recommendation-source").getByText("pi 本地目录", { exact: true }).waitFor();
	assert.equal(await by("model-recommendation-levels").textContent(), "关闭思考 · 低 · 中 · 高 · 很高");
	await finishEdit();
	await closeSettings();
	await setEffort("xhigh");
	await send(sdkKnown, "xhigh", "另一项 SDK 目录模型");

	await openOverview();
	await by("settings-add-model").click();
	await by("model-id").fill(unknown);
	await by("model-recommendation-levels").getByText("采用服务默认档位。", { exact: true }).waitFor();
	await finishEdit();
	await closeSettings();
	await send(unknown, undefined, "未知模型使用服务默认");
	await openOverview();
	await edit(unknown);
	await changeMode("手动");
	await effortChip("高").click();
	await finishEdit();
	await closeSettings();
	await setEffort("high");
	await send(unknown, "high", "未知模型手动覆盖");
	await close();
	await boot();
	assert.equal(remote.observations.discovery.length, discoveryBeforeManualEntry);
	await send(unknown, "high", "重启后直发保留显式覆盖");
	assert(!(await readFile(modelFile, "utf8")).includes(key));
	await writeFile(
		join(evidence, "evidence.json"),
		JSON.stringify(
			{
				executablePath,
				profile,
				overview,
				viewport: [1282, 801],
				narrow: [660, 710],
				restartsFromConfiguredProfile: 3,
				cases,
				cardSurfaces: { neutral, nameHover, pressed, darkPencil },
				discoveryRequests: remote.observations.discovery.length,
			},
			null,
			2,
		),
	);
	console.log(`模型预设 Windows 验收通过，捕获 ${cases.length} 次实际 Chat Completions 请求。`);
} catch (error) {
	await page?.screenshot({ path: join(evidence, "failure.png"), timeout: 2000 }).catch(() => {});
	throw error;
} finally {
	await app?.close();
	await remote.close();
}
