import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentRuntime } from "@flower-ai/agent-runtime";
import { historyReference, sentImage } from "../workbench/attachment-history.mjs";
import { compactionMark, createRequestHistory } from "../workbench/request-history.mjs";
import { readJson, writeJson } from "../workbench/storage.mjs";

test("并发提交原子保存原话与附件，恢复时完整保留旧文字与用户亲写的同形句", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "flower-request-history-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const session = "session";
	const path = join(directory, `${session}.json`);
	const literal = '\n\n已选择的工作区相对路径："用户输入.txt"';
	const legacy = {
		requestId: "legacy",
		workspaceId: "workspace",
		input: `原有记录${literal}`,
		status: "succeeded",
		text: "既有回复",
		toolResults: [],
	};
	await writeJson(path, {
		version: 1,
		workspaceId: "workspace",
		lastSequence: 0,
		requests: [legacy],
		messages: [],
		artifacts: [],
		operations: [],
	});

	const modelInputs = [];
	const finished = Promise.withResolvers();
	function createRuntime(history) {
		return createAgentRuntime({
			host: "desktop-test",
			store: history.store,
			authorize: () => ({
				workspaceId: "workspace",
				createExecution: () => ({
					subscribe: () => () => {},
					async prompt(input) {
						modelInputs.push(input);
					},
					async waitForIdle() {},
					getMessages: () => [],
					abort() {},
				}),
			}),
		}).bindSubject({ kind: "service", id: "local-test" }, (event) => {
			if (event.type === "terminal" && modelInputs.length === 2) finished.resolve();
		});
	}

	const history = createRequestHistory(directory);
	const runtime = createRuntime(history);
	const messages = [{ input: `原话${literal}\n` }, { input: ` 有附件${literal} `, file: "真实附件.xlsx" }];
	const queued = await Promise.all(
		messages.map((message) => history.submit(session, message, (prompt) => runtime.submit(session, prompt))),
	);
	await finished.promise;
	assert.deepEqual(modelInputs, [
		messages[0].input.trim(),
		`${messages[1].input.trim()}\n\n已选择的工作区相对路径："真实附件.xlsx"`,
	]);
	const persisted = await readJson(path);
	assert.deepEqual(persisted.desktopMessages, {
		[queued[0].requestId]: messages[0],
		[queued[1].requestId]: messages[1],
	});

	const reopened = createRequestHistory(directory);
	const { requests } = await createRuntime(reopened).getSession(session);
	assert.deepEqual(reopened.display(session, requests[0]), legacy);
	for (const [index, request] of requests.slice(1).entries()) {
		const { input, file } = reopened.display(session, request);
		assert.equal(input, messages[index].input);
		assert.equal(file, messages[index].file);
	}
});

test("历史截图按成功轮次和同名附件的位置恢复，文字与消息不匹配时放弃回读", () => {
	const first = { id: "clip:first", name: "截图 1.png" };
	const second = { id: "file:设计/截图 1.png", name: "截图 1.png" };
	const old = { requestId: "old", status: "succeeded", input: "旧问题" };
	const failed = { requestId: "failed", status: "failed", input: "中断" };
	const record = { requestId: "new", status: "succeeded", input: "比较两张图", attachments: [first, second] };
	const snapshot = {
		requests: [old, failed, record],
		messages: [
			{ role: "user", content: "旧问题" },
			{ role: "assistant", content: [] },
			{
				role: "user",
				content: [
					{ type: "text", text: record.input },
					...["a", "b"].flatMap((v) => [
						{ type: "text", text: "图片附件：截图 1.png" },
						{ type: "image", mimeType: "image/png", data: Buffer.from(v).toString("base64") },
					]),
				],
			},
		],
	};
	assert.throws(() => historyReference(snapshot, old.requestId, first.id), /不属于/);
	assert.deepEqual(historyReference(snapshot, record.requestId, second.id), { record, ref: second });
	assert.equal(Buffer.from(sentImage(snapshot, record, first).bytes).toString(), "a");
	assert.equal(Buffer.from(sentImage(snapshot, record, second).bytes).toString(), "b");
	snapshot.messages[2].content[0].text = "另一个问题";
	assert.equal(sentImage(snapshot, record, second), undefined);
});

test("失败回执不会挤占旧截图的位置，相同输入或图片名也按请求身份恢复", () => {
	const first = { id: "clip:older", name: "截图.png" };
	const second = { id: "file:截图.png", name: "截图.png" };
	const input = "读这张图";
	const old = { requestId: "a", status: "succeeded", input, attachments: [first] };
	const failed = { requestId: "b", status: "failed", toolResults: [{ toolCallId: "write" }] };
	const recent = { requestId: "c", status: "succeeded", input, attachments: [second] };
	const user = (value) => ({
		role: "user",
		content: [
			{ type: "text", text: input },
			{ type: "text", text: "图片附件：截图.png" },
			{ type: "image", mimeType: "image/png", data: Buffer.from(value).toString("base64") },
		],
	});
	const assistant = { role: "assistant", content: [] };
	const snapshot = { requests: [old, failed, recent], messages: [user("旧"), assistant, user("新"), assistant] };
	const read = (record, ref) => Buffer.from(sentImage(snapshot, record, ref).bytes).toString();
	assert.equal(read(old, first), "旧");
	// 回执文字故意与真实输入相同，恢复只按结构和索引决定归属。
	snapshot.messages.splice(2, 0, { role: "user", content: input });
	assert.equal(read(old, first), "旧");
	assert.equal(read(recent, second), "新");
	snapshot.requests = [failed, old, recent];
	assert.equal(sentImage(snapshot, recent, second), undefined);
	snapshot.requests = [old, failed, recent];
	snapshot.messages[2] = { role: "flowerToolReceipt", requestId: "b", content: input };
	recent.userMessageIndex = 3;
	snapshot.messages[3].flowerRequestId = recent.requestId;
	assert.equal(read(old, first), "旧");
	assert.equal(read(recent, second), "新");
	recent.userMessageIndex = 0;
	assert.equal(sentImage(snapshot, recent, second), undefined);
	assert.equal(sentImage(snapshot, old, second), undefined);
});

test("压缩分隔跳过缺位置的旧轮次，并带出压缩方式", () => {
	const user = (flowerRequestId) => ({ role: "user", content: "问", ...(flowerRequestId && { flowerRequestId }) });
	const reply = { role: "assistant", content: [] };
	const messages = [user(), reply, user("b"), reply, user("c"), reply];
	const requests = [
		{ requestId: "a", status: "succeeded" },
		{ requestId: "b", status: "succeeded", userMessageIndex: 2 },
		{ requestId: "c", status: "succeeded" },
	];
	// 第一轮由旧版本创建，既无 userMessageIndex 也无 flowerRequestId；全部已归纳时分隔在最后一轮之后。
	assert.deepEqual(
		compactionMark({ messages, requests, contextCheckpoint: { through: 6, summary: "摘要", trigger: "manual" } }),
		{
			after: "c",
			trigger: "manual",
		},
	);
	assert.deepEqual(
		compactionMark({ messages, requests, contextCheckpoint: { through: 3, summary: "摘要", trigger: "auto" } }),
		{
			before: "c",
			trigger: "auto",
		},
	);
	// 早期检查点没有压缩方式；没有检查点时不显示分隔。
	assert.deepEqual(compactionMark({ messages, requests, contextCheckpoint: { through: 2, summary: "摘要" } }), {
		before: "b",
		trigger: undefined,
	});
	assert.equal(compactionMark({ messages, requests }), undefined);
});
