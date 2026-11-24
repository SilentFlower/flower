import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentRuntime } from "@flower-ai/agent-runtime";
import Excel from "exceljs";
import { listAvailableModels, openModelStream } from "../workbench/gateway.mjs";
import { findService, loadModelLibrary, updateService, writeModelLibrary } from "../workbench/model-library.mjs";
import { describeModel, normalizeBaseUrl } from "../workbench/model-settings.mjs";
import { analysisFiles, approveWorkspace, resolveArtifact, workspaceTools } from "../workbench/workspace.mjs";
import { startMockModel } from "./mock-model.mjs";

test("模型设置限制传输地址并只保存加密 Key", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "flower-model-settings-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "model.json");
	const protectedStorage = {
		isEncryptionAvailable: () => true,
		encryptString: () => Buffer.from("encrypted-test"),
		decryptString: () => "key-do-not-leak",
	};
	assert.equal(normalizeBaseUrl("http://[::1]:9000/custom/v1/"), "http://[::1]:9000/custom/v1");
	for (const url of [
		"http://remote.example",
		"https://user:key@remote.example",
		"file:///tmp/model",
		"https://remote.example/v1?key=hidden",
	]) {
		assert.throws(() => normalizeBaseUrl(url));
	}
	const input = { baseUrl: "https://models.example/v1/", modelId: "local/model" };
	const empty = await loadModelLibrary(path, protectedStorage);
	assert.deepEqual(empty.services, []);
	const serviceOnly = findService(updateService(empty, { ...input, modelId: "" }, protectedStorage));
	assert.equal(describeModel(serviceOnly), undefined);
	assert.equal(serviceOnly.baseUrl, "https://models.example/v1");
	assert.equal(serviceOnly.modelId, "");
	const library = updateService(empty, { ...input, apiKey: "key-do-not-leak" }, protectedStorage);
	const first = findService(library);
	await writeModelLibrary(path, library);
	assert.doesNotMatch(await readFile(path, "utf8"), /key-do-not-leak/);
	assert.equal(findService(await loadModelLibrary(path, protectedStorage)).apiKey, first.apiKey);
	assert(!JSON.stringify(describeModel(first)).includes("key-do-not-leak"));
	assert.equal(findService(updateService(library, input, protectedStorage)).apiKey, first.apiKey);
	assert.equal(findService(updateService(library, { ...input, clearKey: true }, protectedStorage)).apiKey, undefined);
	assert.equal(
		findService(updateService(library, { ...input, baseUrl: "https://other.example/v1" }, protectedStorage)).apiKey,
		undefined,
	);
	assert.throws(
		() =>
			updateService(
				empty,
				{ ...input, apiKey: "test" },
				{
					...protectedStorage,
					getSelectedStorageBackend: () => "basic_text",
				},
			),
		/凭据保护/,
	);
});

test("模型发现限定用户配置的端点、鉴权与响应，拒绝重定向", async (t) => {
	const remote = await startMockModel({ apiKey: "test-key", alternatives: ["fast", "large", "fast"] });
	t.after(() => remote.close());
	const settings = { baseUrl: "https://custom-model.example/proxy/v1", apiKey: "test-key" };
	assert.deepEqual(
		await listAvailableModels(settings, (url, options) => {
			assert.equal(url, "https://custom-model.example/proxy/v1/models");
			assert.equal(options.redirect, "error");
			assert.equal(options.signal.aborted, false);
			return fetch(`${remote.baseUrl}/models`, options);
		}),
		["local-test", "fast", "large"],
	);
	assert.deepEqual(remote.observations.discovery, [{ hasAuthorization: true, tokenMatches: true }]);
	assert.deepEqual(await listAvailableModels(settings, async () => Response.json({ data: [{ id: "test-key" }] })), []);
	const local = { baseUrl: remote.baseUrl };
	assert.deepEqual(
		await listAvailableModels(local, async (_url, options) => {
			assert.equal(new Headers(options.headers).has("authorization"), false);
			return Response.json({ data: [{ id: " valid " }, { id: "bad\n" }, {}, null, { id: 1 }] });
		}),
		["valid"],
	);
	await assert.rejects(
		listAvailableModels(local, async () => Response.json({})),
		/列表无效/,
	);
	await assert.rejects(
		listAvailableModels(local, async () => new Response("a".repeat(1_048_577))),
		/列表无效、过大/,
	);
	await assert.rejects(
		listAvailableModels(local, async () => new Response(null, { status: 404 })),
		/未提供模型列表/,
	);
	await assert.rejects(listAvailableModels({ baseUrl: "http://remote.example/v1" }), /HTTPS/);
	let followed = false;
	const server = createServer((request, response) => {
		if (request.url === "/v1/models") response.writeHead(302, { location: "/unexpected" }).end();
		else {
			followed = true;
			response.end("{}");
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise((resolve) => server.close(resolve)));
	await assert.rejects(
		listAvailableModels({ ...settings, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }),
		/无法连接/,
	);
	assert.equal(followed, false);
});

test("有 Key 的 HTTPS 配置只向精确模型端点发送授权头", async (t) => {
	const remote = await startMockModel({ apiKey: "test-key" });
	t.after(() => remote.close());
	const settings = { baseUrl: "https://custom-model.example/proxy/v1", modelId: remote.modelId, apiKey: "test-key" };
	const model = describeModel(settings);
	const context = { messages: [{ role: "user", content: "延续刚才的会话", timestamp: Date.now() }] };
	let terminal;
	for await (const event of openModelStream({
		settings,
		model,
		context,
		signal: new AbortController().signal,
		fetcher(input, options) {
			assert.equal(String(input), "https://custom-model.example/proxy/v1/chat/completions");
			assert.equal(options.redirect, "error");
			return fetch(`${remote.baseUrl}/chat/completions`, options);
		},
	}))
		terminal = event;
	assert.equal(terminal?.type, "done");
	assert.deepEqual(
		remote.observations.model.map(({ hasAuthorization, tokenMatches }) => [hasAuthorization, tokenMatches]),
		[[true, true]],
	);
});

test("只读汇总跳过授权，拒绝和中止保证零产物，同意仅覆盖一次调用", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-write-permission-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = "orders.xlsx";
	const book = new Excel.Workbook();
	book.addWorksheet("订单").addRows([
		["部门", "金额"],
		["A", 10],
		["B", 20],
	]);
	await book.xlsx.writeFile(join(root, file));
	const workspace = await approveWorkspace(root);
	const input = { path: file, sheet: "订单", groupColumn: "部门", valueColumn: "金额", createOutputs: true };
	let decision = "read";
	const calls = [];
	const analyze = workspaceTools(workspace, async (plan) => {
		calls.push(plan);
		return decision;
	}).find(({ name }) => name === "analyze_excel");
	const summary = await analyze.execute("read", { ...input, createOutputs: false });
	assert.equal(JSON.parse(summary.content[0].text).total, 30);
	assert.equal(calls.length, 0);
	await assert.rejects(analyze.execute("write", input), /只读/);
	decision = "deny";
	await assert.rejects(analyze.execute("write", input), /未经批准/);
	const controller = new AbortController();
	const cancelled = workspaceTools(workspace, async () => {
		controller.abort();
		return "allow";
	}).find(({ name }) => name === "analyze_excel");
	await assert.rejects(cancelled.execute("cancelled", input, controller.signal), { name: "AbortError" });
	assert.deepEqual(await readdir(root), [file]);
	decision = "allow";
	const allowed = JSON.parse((await analyze.execute("allow", input)).content[0].text);
	const plan = calls.at(-1);
	assert.equal(plan.input, file);
	assert.deepEqual(
		allowed.artifacts,
		analysisFiles.map((name) => `${plan.directory}/${name}`),
	);
	assert.deepEqual((await readdir(join(root, plan.directory))).sort(), [...analysisFiles].sort());
	decision = "deny";
	await assert.rejects(analyze.execute("new-call", input), /未经批准/);
	assert.deepEqual((await readdir(root)).sort(), [plan.directory, file].sort());
});

test("真实 pi 经回环 SSE 分析工作簿，临时工作区逃逸被拒", { timeout: 20000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "flower-excel-test-"));
	const service = await startMockModel();
	t.after(async () => {
		await service.close();
		await rm(dir, { force: true, recursive: true });
	});
	const root = join(dir, "work");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(root);
	const book = new Excel.Workbook();
	book.addWorksheet("订单").addRows([
		["部门", "金额"],
		["A", 100],
		["B", 200],
		["A", 150],
		["B", 50],
	]);
	const input = join(root, "orders.xlsx");
	await book.xlsx.writeFile(input);
	const before = createHash("sha256")
		.update(await readFile(input))
		.digest("hex");
	await writeFile(join(dir, "outside.txt"), "边界样例");
	const workspace = await approveWorkspace(root);
	const tools = workspaceTools(workspace, async () => "allow");
	const read = tools.find(({ name }) => name === "read_text_file");
	for (const path of ["../outside.txt", "C:\\Windows\\win.ini", "orders.xlsx:secret"]) {
		await assert.rejects(read.execute("t", { path }));
	}
	await symlink(join(dir, "outside.txt"), join(root, "link.txt"));
	await assert.rejects(read.execute("t", { path: "link.txt" }), /拒绝/);
	const settings = { baseUrl: service.baseUrl, modelId: service.modelId };
	const model = describeModel(settings);
	const events = [];
	let snapshot;
	const runtime = createAgentRuntime({
		host: "desktop-test",
		store: {
			async load() {
				return snapshot;
			},
			async save(_scope, next) {
				snapshot = next;
			},
		},
		authorize: () => ({
			workspaceId: workspace.id,
			tools,
			model,
			streamFn: (current, context, options) =>
				openModelStream({
					settings,
					model: current,
					context,
					signal: options.signal,
				}),
		}),
	});
	const terminal = Promise.withResolvers();
	const client = runtime.bindSubject({ kind: "service", id: "local-test" }, (event) => {
		events.push(event);
		if (event.type === "terminal") terminal.resolve(event);
	});
	await client.submit("excel", "分析所选 Excel，生成分析报告和汇总工作簿");
	assert.equal((await terminal.promise).status, "succeeded");
	assert.equal(service.observations.model.length, 3);
	assert(service.observations.model.every(({ hasAuthorization }) => !hasAuthorization));
	assert(events.some(({ type }) => type === "text_delta"));
	const [{ toolResults }] = (await client.getSession("excel")).requests;
	const output = JSON.parse(toolResults.find(({ toolName }) => toolName === "analyze_excel").text[0]);
	assert.equal(output.total, 500);
	assert.deepEqual(
		output.groups.map(({ total }) => total),
		[250, 250],
	);
	assert.equal(output.artifacts.length, 2);
	const report = await resolveArtifact(workspace, output.artifacts[0]);
	const summary = await resolveArtifact(workspace, output.artifacts[1]);
	assert.match(await readFile(report, "utf8"), /合计：500/);
	assert.equal((await new Excel.Workbook().xlsx.readFile(summary)).getWorksheet("汇总").getCell("C4").value, 500);
	assert.equal(
		createHash("sha256")
			.update(await readFile(input))
			.digest("hex"),
		before,
	);
});
