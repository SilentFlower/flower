import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { listAvailableModels, openModelStream } from "../workbench/gateway.mjs";
import {
	describeEffortPreset,
	findService,
	loadModelLibrary,
	publicService,
	rememberModelEffortCatalog,
	runtimeSelection,
	selectModel,
	setModelEffort,
	updateService,
	writeModelLibrary,
} from "../workbench/model-library.mjs";
import { startMockModel } from "./mock-model.mjs";

const safeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (value) => Buffer.from(`测试保护:${value}`),
	decryptString: (value) => value.toString().slice("测试保护:".length),
};
const empty = { activeId: "", services: [] };

test("上下文窗口按模型保存，可清除声明并回到 pi 目录或标识的兜底", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-model-context-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "model.json");
	const known = "claude-fable-5-1";
	const baseUrl = "http://localhost:4012/v1";
	const builtinLimit = getBuiltinModel("anthropic", known).contextWindow;
	let library = updateService(empty, { baseUrl, modelId: known }, safeStorage);
	assert.deepEqual(publicService(findService(library)).context, { limit: builtinLimit, source: "catalog" });
	library = updateService(library, { baseUrl, modelId: known, capability: { contextWindow: "4096" } }, safeStorage);
	await writeModelLibrary(path, library);
	library = await loadModelLibrary(path, safeStorage);
	assert.equal(runtimeSelection(findService(library)).model.contextWindow, 4096);
	assert.deepEqual(publicService(findService(library)).context, { limit: 4096, source: "custom" });
	library = selectModel(library, "unknown-model-local");
	assert.deepEqual(publicService(findService(library)).context, { limit: 32768, source: "fallback" });
	library = selectModel(library, known);
	library = updateService(library, { baseUrl, modelId: known, capability: { contextWindow: "" } }, safeStorage);
	await writeModelLibrary(path, library);
	library = await loadModelLibrary(path, safeStorage);
	assert.equal(runtimeSelection(findService(library)).model.contextWindow, builtinLimit);
	assert.throws(
		() => updateService(library, { baseUrl, modelId: known, capability: { contextWindow: 2.5 } }, safeStorage),
		/整数/,
	);
});

test("迁移旧 Key，服务与模型各自保存能力，改变地址不复用凭据", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-model-library-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "model.json");
	await writeFile(
		path,
		JSON.stringify({
			baseUrl: "http://localhost:4001/v1",
			modelId: "deepseek-arbitrary",
			encryptedKey: safeStorage.encryptString("key-alpha").toString("base64"),
		}),
	);
	let library = await loadModelLibrary(path, safeStorage);
	const a = findService(library);
	assert.equal(a.apiKey, "key-alpha");
	assert.deepEqual(publicService(a).available, []);
	library = updateService(
		library,
		{
			serviceId: a.id,
			baseUrl: a.baseUrl,
			modelId: a.modelId,
			capability: { mode: "standard", levels: ["low", "high"] },
		},
		safeStorage,
	);
	library = setModelEffort(library, "high");
	assert.throws(() => setModelEffort(library, "medium"), /不支持/);
	library = updateService(
		library,
		{
			serviceId: "",
			name: "另一服务",
			baseUrl: "http://localhost:4002/v1",
			modelId: a.modelId,
			apiKey: "key-beta",
		},
		safeStorage,
	);
	const b = findService(library);
	assert.notEqual(b.id, a.id);
	assert.deepEqual(publicService(b).available, []);
	await writeModelLibrary(path, library);
	assert.doesNotMatch(await readFile(path, "utf8"), /key-alpha|key-beta/);
	library = await loadModelLibrary(path, safeStorage);
	assert.equal(findService(library, a.id).apiKey, "key-alpha");
	assert.equal(findService(library).apiKey, "key-beta");
	assert.equal(publicService(findService(library, a.id)).effort, "high");
	assert.doesNotMatch(
		JSON.stringify(library.services.map((service) => publicService(service))),
		/key-alpha|key-beta|encryptedKey|apiKey/,
	);
	const edited = updateService(
		library,
		{
			serviceId: a.id,
			baseUrl: "http://localhost:5001/v1",
			modelId: a.modelId,
		},
		safeStorage,
	);
	assert.equal(findService(edited).apiKey, undefined);
	assert.deepEqual(publicService(findService(edited)).available, []);
	assert.equal(findService(edited, b.id).apiKey, "key-beta");
});

test("锁定的 pi 协议发出各自的实际字段，默认档和不支持模型略去覆写", async (t) => {
	const deepSeekIds = ["deepseek-v4-pro", "deepseek-flash"];
	const unknownId = "deepseek-other";
	const standardId = "gpt-5-mini";
	const extraSdkModel = "gpt-5.2";
	const nonReasoningModel = "gpt-4.1-mini";
	const sonnet = "claude-sonnet-5-5";
	const fable = "claude-fable-5-1";
	const remote = await startMockModel({
		model: deepSeekIds[0],
		alternatives: [deepSeekIds[1], unknownId, standardId, sonnet, fable, extraSdkModel, nonReasoningModel],
	});
	t.after(() => remote.close());
	const context = { messages: [{ role: "user", content: "延续刚才的会话", timestamp: Date.now() }] };
	async function run(library, catalog) {
		const settings = findService(library);
		let terminal;
		let fields;
		for await (const event of openModelStream({
			settings,
			...runtimeSelection(settings, catalog),
			context,
			signal: new AbortController().signal,
			fetcher(input, options) {
				assert.equal(input instanceof Request ? input.url : String(input), `${settings.baseUrl}/chat/completions`);
				const body = JSON.parse(options.body);
				assert.equal(body.model, settings.modelId);
				assert.equal(Object.hasOwn(body, "output_config"), false);
				assert.equal(settings.apiKey, undefined);
				assert.equal(new Headers(options.headers).get("authorization"), null);
				fields = Object.fromEntries(
					["reasoning_effort", "thinking"].filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]),
				);
				return fetch(`${remote.baseUrl}/chat/completions`, options);
			},
		}))
			terminal = event;
		assert.equal(terminal?.type, "done");
		return fields;
	}
	const cases = [
		["default", {}],
		["off", { thinking: { type: "disabled" } }],
		["low", { reasoning_effort: "low", thinking: { type: "enabled" } }],
		["max", { reasoning_effort: "max", thinking: { type: "enabled" } }],
	];
	let deep = updateService(empty, { baseUrl: "https://api.deepseek.com/v1", modelId: deepSeekIds[0] }, safeStorage);
	for (const id of deepSeekIds) {
		deep = selectModel(deep, id);
		const projected = id === "deepseek-flash" ? ["low", "high", "max"] : ["high", "max"];
		assert.deepEqual(publicService(findService(deep)).available, ["off", ...projected]);
		// 官方服务可用 /models 声明补齐锁定 SDK 的目录，例如 V4 Pro 的 low。
		const directCatalog = new Map([[id, ["low", "high", "max"]]]);
		for (const [effort, expected] of cases) {
			const fields = await run(setModelEffort(deep, effort, directCatalog), directCatalog);
			assert.deepEqual(fields, expected, `${id} ${effort}`);
			t.diagnostic(`${id} ${effort} ${JSON.stringify(fields)}`);
		}

		const gateway = updateService(empty, { baseUrl: remote.baseUrl, modelId: id }, safeStorage);
		assert.deepEqual(publicService(findService(gateway)).available, projected);
		assert.throws(() => setModelEffort(gateway, "off"), /不支持/);
		assert.deepEqual(await run(gateway), {});
		assert.deepEqual(await run(setModelEffort(gateway, "max")), { reasoning_effort: "max" });
		const declared = updateService(
			gateway,
			{ baseUrl: remote.baseUrl, modelId: id, capability: { mode: "standard", levels: ["off", "low"] } },
			safeStorage,
		);
		assert.deepEqual(publicService(findService(declared)).available, ["off", "low"]);
		assert.deepEqual(await run(setModelEffort(declared, "low")), { reasoning_effort: "low" });
		assert.deepEqual(await run(setModelEffort(declared, "off")), { reasoning_effort: "none" });
	}
	deep = selectModel(deep, unknownId);
	assert.deepEqual(publicService(findService(deep)).available, []);
	assert.deepEqual(await run(deep), {});
	const standard = updateService(
		empty,
		{
			baseUrl: remote.baseUrl,
			modelId: standardId,
			capability: { mode: "standard", levels: ["off", "low", "high"] },
		},
		safeStorage,
	);
	assert.deepEqual(await run(setModelEffort(standard, "low")), { reasoning_effort: "low" });
	assert.deepEqual(await run(setModelEffort(standard, "off")), { reasoning_effort: "none" });
	assert.deepEqual(await run(standard), {});
	const claude = updateService(empty, { baseUrl: remote.baseUrl, modelId: sonnet }, safeStorage);
	const sonnetLevels = ["low", "medium", "high", "xhigh", "max"];
	assert.deepEqual(describeEffortPreset(findService(claude), sonnet), { source: "builtin", levels: sonnetLevels });
	assert.deepEqual(describeEffortPreset(undefined, "anthropic/claude-sonnet-5.5"), {
		source: "builtin",
		levels: sonnetLevels,
	});
	assert.deepEqual(describeEffortPreset(undefined, "extra/claude-sonnet-5-5"), { source: "default", levels: [] });
	assert.deepEqual(describeEffortPreset(undefined, "deepseek-flash-preview"), { source: "default", levels: [] });
	assert.deepEqual(await run(claude), {});
	for (const effort of sonnetLevels) {
		assert.deepEqual(await run(setModelEffort(claude, effort)), { reasoning_effort: effort });
	}
	const declared = new Map([[sonnet, ["low", "medium", "high"]]]);
	assert.deepEqual(publicService(findService(claude), declared).available, ["low", "medium", "high"]);
	assert.throws(() => setModelEffort(claude, "max", declared), /不支持/);
	const fableLibrary = selectModel(claude, fable);
	const fableLevels = ["minimal", ...sonnetLevels];
	assert.deepEqual(publicService(findService(fableLibrary)).available, fableLevels);
	for (const effort of fableLevels) {
		assert.deepEqual(await run(setModelEffort(fableLibrary, effort)), { reasoning_effort: effort });
	}
	const sdk = selectModel(claude, extraSdkModel);
	assert.deepEqual(publicService(findService(sdk)).available, ["off", "low", "medium", "high", "xhigh"]);
	assert.deepEqual(await run(setModelEffort(sdk, "xhigh")), { reasoning_effort: "xhigh" });
	assert.deepEqual(await run(setModelEffort(sdk, "off")), { reasoning_effort: "none" });
	const nonReasoning = selectModel(sdk, nonReasoningModel);
	assert.deepEqual(publicService(findService(nonReasoning)).available, []);
	assert.deepEqual(await run(nonReasoning), {});
	assert.equal(remote.observations.discovery.length, 0);
});

test("模型列表只接纳精确模型声明，手动覆盖和禁用优先", async () => {
	const catalog = new Map();
	const id = "claude-sonnet-5-5";
	const baseUrl = "http://localhost:4001/v1";
	const received = await listAvailableModels(
		{ baseUrl },
		async () =>
			Response.json({
				data: [
					{ id, effort: { supported_levels: ["high"] } },
					{ id: "unsupported", effort: { supported_levels: [] } },
					{ id: "ambiguous", effort: { supported_levels: ["low"] } },
					{ id: "ambiguous" },
					{ id: "invalid", effort: { supported_levels: ["extreme"] } },
				],
			}),
		catalog,
	);
	assert.deepEqual(received, [id, "unsupported", "ambiguous", "invalid"]);
	assert.deepEqual(
		[...catalog],
		[
			[id, ["high"]],
			["unsupported", []],
		],
	);
	let library = updateService(empty, { baseUrl, modelId: id }, safeStorage);
	const service = () => findService(library);
	assert.deepEqual(describeEffortPreset(service(), id, catalog), { source: "service", levels: ["high"] });
	assert.deepEqual(describeEffortPreset(service(), "unsupported", catalog), { source: "service", levels: [] });
	assert.deepEqual(publicService(service(), catalog).available, ["high"]);
	assert.throws(() => setModelEffort(library, "max", catalog), /不支持/);
	library = updateService(
		library,
		{ baseUrl, modelId: id, capability: { mode: "standard", levels: ["low", "max"] } },
		safeStorage,
	);
	assert.deepEqual(publicService(service(), catalog).available, ["low", "max"]);
	library = updateService(library, { baseUrl, modelId: id, capability: { mode: "none" } }, safeStorage);
	assert.deepEqual(publicService(service(), catalog).available, []);
	assert.equal(runtimeSelection(service(), catalog).model.reasoning, false);
});

test("同一服务重启恢复已保存模型的声明，换 Key 或地址后重新确认", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-effort-catalog-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "model.json");
	const baseUrl = "http://localhost:4001/v1";
	const input = { baseUrl, modelId: "custom-model", apiKey: "old-credential" };
	let library = updateService(empty, input, safeStorage);
	const id = library.activeId;
	const catalog = new Map([
		[input.modelId, ["low", "high"]],
		["unsaved-model", ["max"]],
	]);
	library = rememberModelEffortCatalog(library, id, catalog);
	assert.equal(rememberModelEffortCatalog(library, id, catalog), library);
	library = setModelEffort(library, "high");
	await writeModelLibrary(path, library);
	const disk = await readFile(path, "utf8");
	assert.doesNotMatch(disk, /old-credential|unsaved-model/);
	library = await loadModelLibrary(path, safeStorage);
	assert.equal(runtimeSelection(findService(library)).reasoning, "high");
	assert.deepEqual(describeEffortPreset(findService(library), input.modelId), {
		source: "service",
		levels: ["low", "high"],
	});
	assert.equal(publicService(findService(library)).verifiedEffort, undefined);
	const renamed = updateService(library, { baseUrl, modelId: input.modelId, name: "另一个显示名称" }, safeStorage);
	assert.equal(runtimeSelection(findService(renamed)).reasoning, "high");

	const masked = rememberModelEffortCatalog(library, id, new Map([[input.modelId, []]]));
	assert.deepEqual(describeEffortPreset(findService(masked), input.modelId), { source: "service", levels: [] });
	assert.equal(runtimeSelection(findService(masked)).reasoning, undefined);
	const removed = rememberModelEffortCatalog(library, id, new Map());
	assert.deepEqual(describeEffortPreset(findService(removed), input.modelId), { source: "default", levels: [] });

	for (const connection of [{ apiKey: "new-credential" }, { clearKey: true }, { baseUrl: "http://localhost:4002/v1" }]) {
		const updated = updateService(library, { baseUrl, modelId: input.modelId, ...connection }, safeStorage);
		await writeModelLibrary(path, updated);
		const reloaded = await loadModelLibrary(path, safeStorage);
		assert.deepEqual(publicService(findService(reloaded)).available, []);
		const rediscovered = rememberModelEffortCatalog(reloaded, id, catalog);
		assert.equal(runtimeSelection(findService(rediscovered)).reasoning, undefined);
	}
	const changedOnDisk = JSON.parse(disk);
	changedOnDisk.services[0].baseUrl = "http://localhost:4003/v1";
	await writeFile(path, JSON.stringify(changedOnDisk));
	const invalidScope = await loadModelLibrary(path, safeStorage);
	assert.deepEqual(publicService(findService(invalidScope)).available, []);
});
