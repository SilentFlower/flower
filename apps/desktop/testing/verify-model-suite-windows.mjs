import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { startMockModel } from "./mock-model.mjs";

const [exeArg, evidenceArg, toolingArg] = process.argv.slice(2);
assert(
	process.platform === "win32" && toolingArg,
	"用法：verify-model-suite-windows.mjs <EXE> <新证据目录> <Playwright>",
);
const exe = resolve(exeArg);
const evidence = resolve(evidenceArg);
const profile = join(evidence, "profile");
const work = join(evidence, "工作区");
const local = join(profile, "local-workbench");
const modelFile = join(local, "model.json");
const notes = join(work, "notes.txt");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
const modelId = "deepseek-flash";
const geminiId = "gemini-2.5-flash";
const keyA = "test-key-service-alpha";
const keyB = "test-key-service-beta";
await mkdir(evidence);
await mkdir(work);
await writeFile(notes, "验收行动项：核对库存清单。");
const a = await startMockModel({ model: modelId, alternatives: ["basic-a"], apiKey: keyA });
const b = await startMockModel({ model: modelId, alternatives: ["manual-b", geminiId], apiKey: keyB });
const results = [];
let app;
let page;

async function boot() {
	app = await electron.launch({
		executablePath: exe,
		chromiumSandbox: true,
		timeout: 30_000,
		args: [`--user-data-dir=${profile}`],
	});
	page = await app.firstWindow();
	await app.evaluate(
		({ app, dialog }, expected) => {
			if (!app.isPackaged || app.getPath("userData").toLowerCase() !== expected.profile.toLowerCase())
				throw new Error("候选或隔离资料目录不匹配");
			dialog.showOpenDialog = async (_window, options) => ({
				canceled: false,
				filePaths: [options.properties.includes("openDirectory") ? expected.work : expected.notes],
			});
		},
		{ profile, work, notes },
	);
	await page.waitForFunction(() => !document.querySelector("#model-picker-open").disabled);
}

async function close() {
	await app.close();
	app = undefined;
}

const state = () => page.evaluate(() => window.flower.state());
const by = (id) => page.locator(`#${id}`);
async function waitState(predicate) {
	for (let attempt = 0; attempt < 180; attempt++) {
		const next = await state();
		if (predicate(next)) return next;
		await setTimeout(50);
	}
	assert.fail("等待桌面模型设置超时");
}

async function openSettings() {
	await by("theme-open").click();
	await by("model-dialog").waitFor();
}

async function saveSettings() {
	await by("save-settings").click();
	await by("model-form").waitFor({ state: "hidden" });
	if (await by("model-dialog").isVisible()) await by("settings-close-dialog").click();
	await by("model-dialog").waitFor({ state: "hidden" });
}

async function chooseOption(control, option) {
	await by(control).click();
	await by(`${control}-options`).getByRole("option", { name: option, exact: true }).click();
}

// 提交会清空草稿附件；核对「切换档位或服务保留草稿」前先重新附上 notes.txt。
async function attachNotes() {
	await by("composer-add").click();
	await by("file").click();
	await page.waitForFunction(() => document.getElementById("attachment").textContent === "notes.txt");
}

async function openPicker() {
	await by("model-picker-open").click();
	await by("model-picker").waitFor();
}

async function run(prompt) {
	await by("prompt").fill(prompt);
	await by("send").click();
	const task = page.locator(".task").filter({ hasText: prompt });
	await task.waitFor();
	return task;
}

async function completed(prompt) {
	const task = await run(prompt);
	await task.and(page.locator('[data-status="succeeded"]')).waitFor();
	await waitState(({ modelBusy }) => !modelBusy);
}

try {
	await boot();
	const oldEncryptedKey = await app.evaluate(
		({ safeStorage }, key) => safeStorage.encryptString(key).toString("base64"),
		keyA,
	);
	await close();
	await mkdir(local, { recursive: true });
	await writeFile(modelFile, JSON.stringify({ baseUrl: a.baseUrl, modelId, encryptedKey: oldEncryptedKey }));
	await boot();
	const legacy = await waitState((snapshot) => snapshot.model === modelId);
	assert.equal(legacy.modelServices.length, 1);
	assert(legacy.modelSettings.hasKey);
	assert.deepEqual(legacy.modelSettings.available, ["off", "low", "high", "max"]);
	const aId = legacy.modelSettings.id;
	await page.evaluate(() => window.flower.chooseWorkspace());
	await attachNotes();
	await completed("请读取 notes.txt，核对旧服务的 Key");
	assert.deepEqual(a.observations.attempts.at(-1), {
		model: modelId,
		hasAuthorization: true,
		tokenMatches: true,
		reasoning: null,
		thinking: "disabled",
	});
	await openSettings();
	assert(await by("model-overview").isVisible());
	assert(await by("base-url").isHidden());
	assert(await by("api-key").isHidden());
	assert(await by("model-capability").isHidden());
	const originalCard = by("settings-model-cards").getByRole("button", { name: modelId, exact: true });
	assert.equal(await originalCard.getAttribute("aria-pressed"), "true");
	assert.match(await originalCard.locator("img").getAttribute("src"), /deepseek-color\.svg$/);
	await by("settings-edit-service").click();
	assert(await by("base-url").isVisible());
	assert(await by("model-capability").isHidden());
	assert.equal(await by("api-key").inputValue(), "");
	await by("service-name").fill("服务甲");
	await saveSettings();
	await openSettings();
	await by("settings-add-model").click();
	assert(await by("base-url").isHidden());
	await by("settings-discover").click();
	await by("settings-models").getByRole("button", { name: "basic-a", exact: true }).waitFor();
	await by("model-id").fill(modelId);
	await by("model-recommendation-levels").getByText("关闭思考 · 低 · 高 · 最高", { exact: true }).waitFor();
	await by("model-capability").getByText("手动", { exact: true }).click();
	await by("model-levels").getByRole("button", { name: "中", exact: true }).click();
	await by("model-levels").getByRole("button", { name: "最高", exact: true }).click();
	await saveSettings();
	// 推荐档位含关闭思考，手动策略从推荐初始化，因此保留关闭思考并以它为默认档。
	assert.deepEqual((await state()).modelSettings.available, ["off", "low", "medium", "high"]);
	results.push("真实 Windows DPAPI 旧 Key 可迁移，旧设置未选档位时按关闭思考发送 thinking.type=disabled");

	await attachNotes();
	await by("prompt").fill("拖动时保留的草稿");
	await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
	await openPicker();
	const range = by("effort-range");
	const petal = by("effort-track").locator(".effort-petal").first();
	await range.waitFor();
	const compact = await by("model-picker").boundingBox();
	assert(compact.width >= 248 && compact.width <= 252);
	assert(compact.height >= 110 && compact.height <= 132);
	const rows = await by("effort-panel").evaluate((panel) => {
		const bounds = Object.fromEntries(
			["effort-label", "effort-model-icon", "effort-reset", "effort-models", "effort-track"].map((id) => [
				id,
				document.getElementById(id).getBoundingClientRect().toJSON(),
			]),
		);
		return { bounds, panel: panel.getBoundingClientRect().toJSON() };
	});
	const { bounds } = rows;
	assert(
		Math.abs(bounds["effort-label"].x + bounds["effort-label"].width / 2 - rows.panel.x - rows.panel.width / 2) < 1,
	);
	assert(bounds["effort-model-icon"].x < bounds["effort-label"].x);
	assert(bounds["effort-reset"].x >= bounds["effort-label"].right);
	assert(bounds["effort-label"].bottom <= bounds["effort-models"].top);
	assert(bounds["effort-models"].bottom <= bounds["effort-track"].top);
	assert(await by("settings").isHidden());
	for (const id of ["composer-model-icon", "effort-model-icon"]) {
		assert.match(await by(id).locator("img").getAttribute("src"), /deepseek-color\.svg$/);
		assert(
			await by(id)
				.locator("img")
				.evaluate((image) => image.complete && image.naturalWidth > 0),
		);
	}
	assert.equal(await range.getAttribute("aria-valuetext"), "关闭思考");
	assert.equal(await range.getAttribute("max"), "3");
	await range.evaluate((control) =>
		control.addEventListener(
			"input",
			() => {
				const avatar = document.getElementById("effort-avatar");
				const jump = avatar.getAnimations()[0];
				const travel = avatar.parentElement.getAnimations().find((animation) => animation.transitionProperty === "left");
				window.qaEffortFrames = jump?.effect.getKeyframes().map(({ transform }) => transform);
				window.qaEffortTravel = Boolean(travel);
				if (jump) {
					jump.pause();
					jump.currentTime = 92;
				}
				if (travel) {
					travel.pause();
					travel.currentTime = 75;
				}
			},
			{ once: true },
		),
	);
	await range.press("ArrowRight");
	await waitState(({ modelSettings }) => modelSettings.effort === "low");
	assert.equal(await range.getAttribute("aria-valuetext"), "低");
	assert.equal(await petal.evaluate((node) => getComputedStyle(node).animationName), "effort-petal-drift");
	const motion = await page.evaluate(() => ({ frames: window.qaEffortFrames, travel: window.qaEffortTravel }));
	assert(motion.travel);
	assert(motion.frames.some((frame) => frame.includes("translateY(-8px)")));
	assert(motion.frames.some((frame) => frame.includes("translateY(1px)")));
	await page.screenshot({ path: join(evidence, "切档小跳.png") });
	await by("effort-avatar").evaluate((avatar) => {
		for (const animation of [...avatar.getAnimations(), ...avatar.parentElement.getAnimations()]) animation.play();
	});
	const box = await range.boundingBox();
	await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 9 });
	await page.mouse.up();
	await waitState(({ modelSettings }) => modelSettings.effort === "high");
	assert.equal(await range.getAttribute("aria-valuetext"), "高");
	assert.equal(await by("prompt").inputValue(), "拖动时保留的草稿");
	assert.equal(await by("attachment").textContent(), "notes.txt");
	assert.equal(
		await by("effort-panel").evaluate((element) => getComputedStyle(element).animationName),
		"model-picker-page-in",
	);
	await page.screenshot({ path: join(evidence, "推理强度.png") });
	await by("effort-models").click();
	await by("model-list-panel").waitFor();
	assert(await by("settings").isVisible());
	assert(await by("model-options").locator('.model-mark[data-family="other"]').first().isVisible());
	await by("model-back-effort").click();
	await range.waitFor();
	await page.keyboard.press("Escape");
	await by("model-picker").waitFor({ state: "hidden" });
	await completed("延续刚才的会话：高强度");
	assert.equal(a.observations.attempts.at(-1).reasoning, "high");
	results.push("方向键和鼠标拖动让档位吸附并反馈，实际 SSE 请求使用高档，草稿和附件保持");

	await openPicker();
	await by("effort-reset").click();
	await waitState(({ modelSettings }) => modelSettings.effort === "off");
	assert(await petal.isHidden());
	await page.keyboard.press("Escape");
	await by("model-picker").waitFor({ state: "hidden" });
	await completed("延续刚才的会话：重置强度");
	assert.equal(a.observations.attempts.at(-1).reasoning, null);
	assert.equal(a.observations.attempts.at(-1).thinking, "disabled");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(660, 615));
	await page.waitForFunction(() => innerWidth === 660);
	await openPicker();
	assert.equal(await by("effort-panel").evaluate((element) => getComputedStyle(element).animationName), "none");
	assert.equal(await by("model-picker").evaluate((element) => getComputedStyle(element).transitionDuration), "0s");
	assert.equal(
		await by("effort-avatar").evaluate((element) => getComputedStyle(element.parentElement).transitionDuration),
		"0s",
	);
	const narrow = await by("model-picker").boundingBox();
	assert(narrow.x >= 0 && narrow.x + narrow.width <= 660);
	await range.press("Home");
	await range.press("ArrowRight");
	await waitState(({ modelSettings }) => modelSettings.effort === "low");
	assert(await petal.isHidden());
	assert.deepEqual(
		await by("effort-avatar").evaluate((element) => [
			element.getAnimations().length,
			element.parentElement.getAnimations().length,
		]),
		[0, 0],
	);
	await page.keyboard.press("Escape");
	await by("model-picker").waitFor({ state: "hidden" });
	await openSettings();
	assert(
		await by("model-dialog").evaluate((dialog) => {
			const bounds = dialog.getBoundingClientRect();
			return bounds.left >= 0 && bounds.right <= innerWidth && dialog.scrollWidth === dialog.clientWidth;
		}),
	);
	await by("settings-close-dialog").click();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1282, 801));
	await page.waitForFunction(() => innerWidth === 1282);
	results.push("重置回到关闭思考并发送 thinking.type=disabled，660 像素与减弱动效模式仍可键盘操作");

	await openSettings();
	await chooseOption("settings-service", "添加服务");
	await by("service-name").fill("服务乙");
	await by("base-url").fill(b.baseUrl);
	await by("model-id").fill(modelId);
	await by("api-key").fill(keyB);
	await by("model-capability").getByText("服务默认", { exact: true }).click();
	await saveSettings();
	const serviceB = (await state()).modelSettings;
	assert.notEqual(serviceB.id, aId);
	assert.deepEqual(serviceB.available, []);
	await openPicker();
	assert(await by("effort-panel").isHidden());
	await page.keyboard.press("Escape");
	await by("model-picker").waitFor({ state: "hidden" });
	await completed("延续刚才的会话：乙服务不同凭据");
	assert.equal(b.observations.attempts.at(-1).reasoning, null);

	await openSettings();
	await by("settings-add-model").click();
	await by("settings-discover").click();
	await by("settings-models").getByRole("button", { name: "manual-b", exact: true }).waitFor();
	await by("model-id").fill("manual-b");
	await saveSettings();
	await completed("延续刚才的会话：乙服务手动模型");
	assert.equal(b.observations.attempts.at(-1).model, "manual-b");
	await openSettings();
	await by("settings-add-model").click();
	await by("settings-discover").click();
	await by("settings-models").getByRole("button", { name: geminiId, exact: true }).click();
	await saveSettings();
	await openSettings();
	const catalog = by("settings-model-cards");
	const gemini = catalog.getByRole("button", { name: geminiId, exact: true });
	assert.equal(await gemini.getAttribute("aria-pressed"), "true");
	assert.match(await gemini.locator("img").getAttribute("src"), /gemini-color\.svg$/);
	const fallback = catalog.getByRole("button", { name: "manual-b", exact: true });
	assert.match(await fallback.locator("img").getAttribute("src"), /unknown\.svg$/);
	await page.waitForFunction(() =>
		[...document.querySelectorAll("#settings-model-cards img")].every(
			(image) => image.complete && image.naturalWidth > 0,
		),
	);
	assert(await by("base-url").isHidden());
	assert(await by("api-key").isHidden());
	assert(await by("model-capability").isHidden());
	assert((await by("model-dialog").boundingBox()).width >= 700);
	await page.screenshot({ path: join(evidence, "模型设置.png") });
	await fallback.click();
	await waitState(({ model }) => model === "manual-b");
	await catalog.locator('button[aria-label="manual-b"][aria-pressed="true"]').waitFor();
	await chooseOption("settings-service", "服务甲");
	await waitState(({ modelSettings }) => modelSettings.id === aId);
	await catalog.getByRole("button", { name: "编辑模型：deepseek-flash", exact: true }).waitFor();
	await chooseOption("settings-service", "服务乙");
	await waitState(({ modelSettings }) => modelSettings.id === serviceB.id);
	await catalog.locator('button[aria-label="manual-b"][aria-pressed="true"]').waitFor();
	await by("settings-close-dialog").click();
	const stored = JSON.parse(await readFile(modelFile, "utf8"));
	assert.equal(stored.version, 2);
	assert.equal(stored.services.length, 2);
	assert.equal(stored.services.find(({ id }) => id === aId).encryptedKey, oldEncryptedKey);
	assert.notEqual(stored.services.find(({ id }) => id === serviceB.id).encryptedKey, oldEncryptedKey);
	assert.doesNotMatch(JSON.stringify(stored) + JSON.stringify(await state()), /test-key-service/);
	results.push("同名模型能力按服务隔离，两个端点模型列表与任务只携带自己的凭据，手动模型与密钥均保存");
	results.push("已配置时默认为模型总览，服务编辑与模型添加分开；鲸形、星芒和通用图标本地加载，模型卡体现当前选择");

	await close();
	await boot();
	assert.equal((await state()).model, "manual-b");
	assert.equal((await state()).modelSettings.id, serviceB.id);
	await attachNotes();
	await by("prompt").fill("跨服务切换保留的草稿");
	await openPicker();
	await chooseOption("picker-service", "服务甲");
	await waitState(({ modelSettings }) => modelSettings.id === aId);
	assert.equal((await state()).modelSettings.effort, "low");
	assert.equal(await by("prompt").inputValue(), "跨服务切换保留的草稿");
	assert.equal(await by("attachment").textContent(), "notes.txt");
	await page.keyboard.press("Escape");
	await by("model-picker").waitFor({ state: "hidden" });
	await completed("延续刚才的会话：甲服务恢复推理");
	assert.equal(a.observations.attempts.at(-1).reasoning, "low");

	await close();
	await boot();
	assert.equal((await state()).modelSettings.id, aId);
	assert.equal((await state()).modelSettings.effort, "low");
	const running = await run("取消用例：模型与强度锁定");
	await running.getByText("准备处理").waitFor();
	const queued = await run("延续刚才的会话：等待排队约束验证");
	assert.equal(await queued.getAttribute("data-status"), "queued");
	await openPicker();
	assert(await by("effort-range").isDisabled());
	const busy = await state();
	await assert.rejects(
		page.evaluate((revision) => window.flower.setModelEffort("high", revision), busy.modelRevision),
		/运行和排队/,
	);
	await assert.rejects(
		page.evaluate(({ id, revision }) => window.flower.chooseModelService(id, revision), {
			id: serviceB.id,
			revision: busy.modelRevision,
		}),
		/运行和排队/,
	);
	await page.keyboard.press("Escape");
	await by("model-picker").waitFor({ state: "hidden" });
	await queued.getByRole("button", { name: "取消任务", exact: true }).click();
	await running.getByRole("button", { name: "取消任务", exact: true }).click();
	await waitState(({ modelBusy }) => !modelBusy);
	await openSettings();
	await by("settings-appearance").click();
	await page.locator(".theme-settings").waitFor();
	await page.screenshot({ path: join(evidence, "外观设置.png") });
	await page.keyboard.press("Escape");
	assert(
		[a, b].every(
			({ observations }) =>
				observations.attempts.length &&
				observations.attempts.every(({ tokenMatches, hasAuthorization }) => tokenMatches && hasAuthorization) &&
				observations.discovery.length &&
				observations.discovery.every(({ tokenMatches }) => tokenMatches),
		),
	);
	results.push("两次重启恢复服务与各自模型档位，执行和排队拒绝换服务或强度，统一设置可打开外观");
	results.push("紧凑面板顶行居中显示档位，列表层提供模型设置，头像切档时横移并小跳回弹");
	const report = { exe, profile, compact, motion, results, traffic: [a.observations, b.observations] };
	await writeFile(join(evidence, "result.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
} finally {
	await app?.close();
	await a.close();
	await b.close();
}
