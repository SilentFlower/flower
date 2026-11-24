import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { startMockModel } from "./mock-model.mjs";

const [exeArg, evidenceArg, toolingArg, mode] = process.argv.slice(2);
assert(
	process.platform === "win32" && toolingArg,
	"用法：verify-model-catalog-restart-windows.mjs <EXE> <证据目录> <Playwright> [baseline]",
);
const executablePath = resolve(exeArg);
const evidence = resolve(evidenceArg);
const profile = join(evidence, "profile");
const workspace = join(evidence, "受控工作区");
const modelFile = join(profile, "local-workbench", "model.json");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
const model = "local-team-reasoner";
const initialKey = "isolated-catalog-first";
const secondKey = "isolated-catalog-rotated";
let expectedKey = initialKey;
const declarations = new Map([[model, ["low", "high"]]]);
const origin = await startMockModel({ model, effortByModel: declarations, apiKey: () => expectedKey });
const other = await startMockModel({ model });
await mkdir(evidence);
await mkdir(workspace);
let app;
let page;
let serviceId;
const attempts = [];
const by = (id) => page.locator(`#${id}`);
const state = () => page.evaluate(() => window.flower.state());

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
}

async function restart() {
	await app.close();
	app = undefined;
	await boot();
}

async function save(settings) {
	const revision = (await state()).modelRevision;
	await page.evaluate((input) => window.flower.saveModel(input), {
		modelId: model,
		name: "本机回环测试",
		revision,
		...settings,
	});
}

async function discover() {
	const revision = (await state()).modelRevision;
	const ids = await page.evaluate(({ id, revision }) => window.flower.listModels(id, revision), {
		id: serviceId,
		revision,
	});
	assert.deepEqual(ids, [model]);
}

async function selectHigh() {
	const revision = (await state()).modelRevision;
	await page.evaluate((revision) => window.flower.setModelEffort("high", revision), revision);
}

async function send(label, remote, reasoning, hasAuthorization) {
	const prompt = `延续刚才的会话：${label}`;
	const before = remote.observations.attempts.length;
	await by("prompt").fill(prompt);
	await by("send").click();
	await page.locator('.task[data-status="succeeded"]').filter({ hasText: prompt }).waitFor();
	await page.waitForFunction(() => window.flower.state().then(({ modelBusy }) => !modelBusy));
	const requests = remote.observations.attempts.slice(before);
	assert.deepEqual(requests, [{ model, hasAuthorization, tokenMatches: true, reasoning, thinking: null }]);
	attempts.push({ label, ...requests[0] });
}

try {
	await boot();
	await save({ baseUrl: origin.baseUrl, apiKey: initialKey });
	serviceId = (await state()).modelSettings.id;
	assert.deepEqual((await state()).modelSettings.available, []);
	await by("workspace").click();
	await page.waitForFunction(() => window.flower.state().then(({ selected }) => Boolean(selected)));
	await discover();
	assert.deepEqual((await state()).modelSettings.available, ["low", "high"]);
	await selectHigh();
	await send("重启前已选高档", origin, "high", true);

	const beforeRestart = origin.observations.discovery.length;
	await restart();
	assert.equal(origin.observations.discovery.length, beforeRestart);
	await send("重启后直接发送首条任务", origin, mode === "baseline" ? null : "high", true);
	assert.equal(origin.observations.discovery.length, beforeRestart);

	if (mode !== "baseline") {
		assert.equal((await state()).modelSettings.effort, "high");
		assert.deepEqual((await state()).modelSettings.available, ["low", "high"]);
		expectedKey = secondKey;
		await save({ serviceId, baseUrl: origin.baseUrl, apiKey: secondKey });
		assert.deepEqual((await state()).modelSettings.available, []);
		assert.equal((await state()).modelSettings.effort, "default");
		await send("更换 Key 后直接发送", origin, null, true);
		await discover();
		assert.equal((await state()).modelSettings.effort, "default");
		await selectHigh();

		await save({ serviceId, baseUrl: other.baseUrl });
		assert.deepEqual((await state()).modelSettings.available, []);
		assert.equal((await state()).modelSettings.hasKey, false);
		await restart();
		assert.equal(other.observations.discovery.length, 0);
		await send("更换 URL 后重启直接发送", other, null, false);
		assert.equal(other.observations.discovery.length, 0);
		assert.doesNotMatch(await readFile(modelFile, "utf8"), /isolated-catalog-/);
	}
	await writeFile(
		join(evidence, "result.json"),
		JSON.stringify(
			{
				executablePath,
				profile,
				mode,
				attempts,
				discoveryBeforeRestart: beforeRestart,
				originalDiscovery: origin.observations.discovery.length,
				changedUrlDiscovery: other.observations.discovery.length,
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ mode, attempts }));
} finally {
	await app?.close();
	await origin.close();
	await other.close();
}
