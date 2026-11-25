import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQuestionTool } from "../workbench/ask-user.mjs";
import { launchDesktop } from "./desktop-harness.mjs";
import { startMockModel } from "./mock-model.mjs";

const questions = [
	{ question: "报告采用哪种口径？", options: ["保留原始口径", "采用调整后口径"] },
	{ question: "报告还应包含哪些章节？", options: ["差异说明", "数据来源", "后续计划"], multiple: true },
];

test("提问工具校验题目、选项和不可重复的索引", async () => {
	const tool = createQuestionTool(async () => [[1], [0, 2]]);
	const { content } = await tool.execute("tool-call", { questions }, undefined);
	assert.deepEqual(JSON.parse(content[0].text), {
		status: "answered",
		answers: [
			{ question: questions[0].question, selected: ["采用调整后口径"] },
			{ question: questions[1].question, selected: ["差异说明", "后续计划"] },
		],
	});
	await assert.rejects(tool.execute("tool-call", { questions: [] }, undefined), /一次可提出/);
	await assert.rejects(
		tool.execute("tool-call", { questions: [{ ...questions[0], options: ["同值", " 同值 "] }] }, undefined),
		/选项不能重复/,
	);
	await assert.rejects(
		createQuestionTool(async () => [[1], [0, 0]]).execute("tool-call", { questions }, undefined),
		/有效选项/,
	);
});

test("真实 pi 提问绑定当前运行，切换会话保留问题，取消和重启清理决议", { timeout: 25000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-question-"));
	const workspace = join(root, "合成工作区");
	await mkdir(workspace);
	const replies = [];
	const fixture = await startMockModel({
		attachmentReply(messages) {
			const last = messages.at(-1);
			if (last.role === "tool") {
				const reply = JSON.parse(last.content);
				replies.push(reply);
				return { text: reply.status === "skipped" ? "已按默认口径继续。" : "已使用你选择的口径。" };
			}
			return { toolCall: { name: "ask_user_question", args: { questions } } };
		},
	});
	let desktop;
	t.after(async () => {
		await desktop?.close();
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	});
	desktop = await launchDesktop(root);
	const { api } = desktop;
	await desktop.state((state) => state.ready);
	await api.saveModel({
		serviceId: "",
		name: "回环夹具",
		baseUrl: fixture.baseUrl,
		modelId: "local-test",
		apiKey: "",
		capability: { mode: "none", contextWindow: "65536", levels: [] },
	});
	desktop.choose(workspace);
	const first = await api.chooseWorkspace();
	const begin = async (session, input) => {
		const { requestId } = await api.submit(session, input);
		const { question } = await desktop.state((state) => state.question?.requestId === requestId);
		assert.equal(question.session, session);
		assert.equal(
			question.runId,
			(await desktop.event((event) => event.requestId === requestId && event.type === "started")).runId,
		);
		assert.deepEqual(
			question.questions,
			questions.map(({ multiple = false, ...entry }) => ({ ...entry, multiple })),
		);
		return question;
	};
	const terminal = (requestId) => desktop.event((event) => event.requestId === requestId && event.type === "terminal");
	const a = await begin(first, "请先核对报告口径");
	const second = await api.newSession(first);
	await desktop.state((state) => state.selected === second && !state.question);
	assert.equal(await api.answerQuestion(a.id, [[1], [0, 2]]), false);
	assert.equal((await api.state()).sessions.find(({ id }) => id === first).awaitingAnswer, true);
	const b = await begin(second, "另一份报告也需要确认");
	assert.notEqual(b.id, a.id);
	assert.equal(await api.answerQuestion(b.id, null), true);
	assert.equal((await terminal(b.requestId)).status, "succeeded");
	assert.equal(await api.answerQuestion(b.id, null), false);
	await api.selectSession(first);
	await desktop.state((state) => state.question?.id === a.id);
	await assert.rejects(api.answerQuestion(a.id, [[3], [0]]), /无效选项/);
	assert.equal((await api.state()).question.id, a.id);
	assert.equal(await api.answerQuestion(a.id, [[1], [0, 2]]), true);
	assert.equal((await terminal(a.requestId)).status, "succeeded");
	assert.deepEqual(replies, [
		{ status: "skipped" },
		{
			status: "answered",
			answers: [
				{ question: questions[0].question, selected: ["采用调整后口径"] },
				{ question: questions[1].question, selected: ["差异说明", "后续计划"] },
			],
		},
	]);
	assert.equal(
		(await api.history(first)).find(({ requestId }) => requestId === a.requestId).text,
		"已使用你选择的口径。",
	);

	const canceled = await begin(first, "请继续确认细节");
	await api.cancel(first, canceled.requestId, canceled.runId);
	assert.equal((await terminal(canceled.requestId)).status, "cancelled");
	assert.equal(await api.answerQuestion(canceled.id, null), false);
	assert.equal((await api.state()).question, undefined);

	const interrupted = await begin(first, "测试退出后清理提问");
	const beforeRestart = fixture.observations.model.length;
	await desktop.restart();
	await desktop.state((state) => state.ready && !state.question);
	assert.equal(await api.answerQuestion(interrupted.id, null), false);
	assert.equal(
		(await api.history(first)).find(({ requestId }) => requestId === interrupted.requestId).status,
		"interrupted",
	);
	assert.equal(fixture.observations.model.length, beforeRestart);
	assert.equal(replies.length, 2);
});
