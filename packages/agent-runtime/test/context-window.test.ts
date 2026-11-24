import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	createAgentRuntime,
	type RuntimeEvent,
	type SessionGrant,
	type SessionScope,
	type SessionSnapshot,
	type SessionStore,
} from "@flower-ai/agent-runtime";
import { describe, expect, it } from "vitest";

const model: Model<Api> = {
	id: "controlled",
	provider: "controlled",
	api: "openai-completions",
	name: "controlled",
	baseUrl: "http://127.0.0.1",
	contextWindow: 2048,
	maxTokens: 512,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const subject = { kind: "service", id: "enterprise" } as const;
const session = "long-session";
const padding = "old_record ".repeat(156);
const fact = "报价 537（报价.pdf 第 2 页），预算 500（预算.xlsx 明细!B7），差额 37。";

function response(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
) {
	const result: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		content,
		stopReason,
		errorMessage,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const output = createAssistantMessageEventStream();
	if (stopReason === "error" || stopReason === "aborted")
		output.push({ type: "error", reason: stopReason, error: result });
	else {
		output.push({ type: "start", partial: { ...result, content: [] } });
		output.push({ type: "done", reason: stopReason, message: result });
	}
	output.end(result);
	return output;
}

function memory(): SessionStore {
	const records = new Map<string, SessionSnapshot>();
	const key = ({ host, subject, sessionId }: SessionScope) =>
		JSON.stringify([host, subject.kind, subject.id, sessionId]);
	return {
		async load(scope) {
			return structuredClone(records.get(key(scope)));
		},
		async save(scope, snapshot) {
			records.set(key(scope), structuredClone(snapshot));
		},
	};
}

function fixture(
	store: SessionStore,
	streamFn: StreamFn,
	tools: AgentTool[] = [],
	overrides: Partial<Pick<Extract<SessionGrant, { model: unknown }>, "model" | "readAttachments">> = {},
) {
	const events: RuntimeEvent[] = [];
	const terminal = new Map<string, (event: RuntimeEvent) => void>();
	const runtime = createAgentRuntime({
		host: "enterprise-node",
		store,
		authorize: ({ subject: owner }) =>
			owner.id === subject.id
				? {
						workspaceId: "workspace-a",
						model,
						tools,
						streamFn,
						readAttachments: async () => [{ type: "text", text: fact }],
						...overrides,
					}
				: undefined,
	});
	const client = runtime.bindSubject(subject, (event) => {
		events.push(event);
		if (event.type === "terminal") terminal.get(event.requestId)?.(event);
	});
	async function result(id: string) {
		return (
			events.find((event) => event.type === "terminal" && event.requestId === id) ??
			new Promise<RuntimeEvent>((resolve) => terminal.set(id, resolve))
		);
	}
	return {
		client,
		runtime,
		events,
		result,
		async submit(input: string) {
			return result((await client.submit(session, input)).requestId);
		},
	};
}

function summary(messages: readonly { role: string; content: unknown }[]): boolean {
	return messages[0]?.role === "system" && JSON.stringify(messages[0].content).includes("生成 Flower 会话检查点");
}

describe("共享运行时长会话", () => {
	it("检查点跨重启复用，完整历史和已发送附件保留，并按当前主体授权", async () => {
		const store = memory();
		const requests: { aggregate: string; summary: boolean; max?: number }[] = [];
		const stream: StreamFn = (_model, { messages }, options) => {
			const aggregate = JSON.stringify(messages);
			requests.push({ aggregate, summary: summary(messages), max: options?.maxTokens });
			return response([{ type: "text", text: summary(messages) || aggregate.includes("报价 537") ? fact : "记录完成。" }]);
		};
		const host = fixture(store, stream);
		const refs = [
			{ id: "asset:pdf", name: "报价.pdf" },
			{ id: "asset:xlsx", name: "预算.xlsx" },
		];
		const initial = await host.client.submit(session, "按附件核对预算", refs);
		expect(await host.result(initial.requestId)).toMatchObject({ status: "succeeded" });
		for (let i = 0; i < 5; i++) expect(await host.submit(`${i} ${padding}`)).toMatchObject({ status: "succeeded" });
		const saved = await host.client.getSession(session);
		expect(saved.contextCheckpoint?.summary).toContain("明细!B7");
		expect(saved.requests[0]?.attachments).toEqual(refs);
		const firstPosition = saved.requests[0]?.userMessageIndex;
		if (firstPosition === undefined) throw new Error("缺少归档消息索引");
		expect(saved.messages[firstPosition]).toMatchObject({ role: "user", flowerRequestId: initial.requestId });
		expect(JSON.stringify(saved.messages)).toContain("按附件核对预算");
		expect(requests.some((row) => row.summary && row.max && row.max < model.maxTokens)).toBe(true);
		const count = requests.length;
		const restarted = fixture(store, stream);
		expect(await restarted.client.getContextUsage(session)).toMatchObject({ limit: 2048, estimated: true });
		expect(await restarted.submit("重启后复核差额和出处")).toMatchObject({ status: "succeeded" });
		const resumed = requests.slice(count).filter((record) => !record.summary);
		expect(resumed).toHaveLength(1);
		expect(resumed[0]?.aggregate).toContain("此前会话的检查点");
		expect(resumed[0]?.aggregate).toContain(fact);
		const outsider = restarted.runtime.bindSubject({ kind: "employee", id: "outsider" }, () => {});
		await expect(outsider.getContextUsage(session)).rejects.toMatchObject({ code: "denied" });
	});

	it("8192 窗口可一次接续 16000 次重复的旧记录，分批覆盖原文并保留最近一轮", async () => {
		const store = memory();
		const long = "useful old context ".repeat(16000);
		const read = await response([{ type: "text", text: "已读旧资料" }]).result();
		const recent = await response([{ type: "text", text: "刚确认预算出处" }]).result();
		const scope = { host: "enterprise-node", subject, sessionId: session };
		await store.save(scope, {
			version: 1,
			workspaceId: "workspace-a",
			lastSequence: 0,
			requests: [],
			artifacts: [],
			operations: [],
			messages: [
				{ role: "user", timestamp: 1, content: long },
				read,
				{ role: "user", timestamp: 2, content: "请先保留这一轮" },
				recent,
			],
		});
		const batches: string[] = [];
		const model8192 = { ...model, contextWindow: 8192, maxTokens: 4096 };
		const outgoing: string[] = [];
		const host = fixture(
			store,
			(_model, { messages }, options) => {
				if (summary(messages)) {
					const text = messages.at(-1)?.content;
					if (typeof text !== "string") throw new Error("摘要没有历史片段");
					const fragment = text.split("有序会话记录片段\n")[1];
					if (fragment === undefined) throw new Error("摘要没有批次内容");
					batches.push(fragment);
					const estimated = messages.reduce((total, message) => total + estimateMessageTokens(message) + 6, 0);
					expect(estimated + (options?.maxTokens ?? 0)).toBeLessThan(8192);
					return response([{ type: "text", text: "旧资料已读，目标是比较报价与预算。" }]);
				}
				outgoing.push(JSON.stringify(messages));
				return response([{ type: "text", text: "继续核对。" }]);
			},
			[],
			{ model: model8192 },
		);
		expect(await host.client.getContextUsage(session)).toMatchObject({ limit: 8192, tokens: expect.any(Number) });
		expect(await host.submit("继续")).toMatchObject({ status: "succeeded" });
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.length).toBeLessThanOrEqual(20);
		expect(batches.join("")).toContain(long);
		expect(batches.join("")).toContain("已读旧资料");
		expect(outgoing).toHaveLength(1);
		expect(outgoing[0]).toContain("请先保留这一轮");
		expect(outgoing[0]).toContain("刚确认预算出处");
		expect(outgoing[0]).toContain("此前会话的检查点");
		const archived = await host.client.getSession(session);
		expect(archived.messages[0]).toMatchObject({ role: "user", content: long });
		expect(archived.contextCheckpoint?.through).toBe(2);
	});

	it("摘要失败和取消都保留原检查点及归档，允许后续重试", async () => {
		const store = memory();
		let mode = "ok";
		let go: (() => void) | undefined;
		let onStarted: (() => void) | undefined;
		const stream: StreamFn = async (_model, { messages }, options) => {
			if (!summary(messages) || mode === "ok") return response([{ type: "text", text: fact }]);
			if (mode === "fail") return response([{ type: "text", text: "摘要只有一半" }], "length");
			await new Promise<void>((resolve) => {
				go = resolve;
				options?.signal?.addEventListener("abort", resolve, { once: true });
				onStarted?.();
			});
			return response([], "aborted");
		};
		const host = fixture(store, stream);
		await host.submit(padding);
		await host.submit(padding);
		const before = await host.client.getSession(session);
		mode = "fail";
		expect(await host.submit(padding)).toMatchObject({
			status: "failed",
			failure: { message: expect.stringContaining("摘要未完成") },
		});
		mode = "wait";
		const started = new Promise<void>((resolve) => {
			onStarted = resolve;
		});
		const pending = await host.client.submit(session, padding);
		await started;
		try {
			const running = (await host.client.getSession(session)).requests.find(
				({ requestId }) => requestId === pending.requestId,
			);
			if (!running?.runId) throw new Error("摘要等待期间缺少运行编号");
			await host.client.cancelRunning(session, running.runId);
			expect(await host.result(pending.requestId)).toMatchObject({ status: "cancelled" });
		} finally {
			go?.();
		}
		const after = await host.client.getSession(session);
		expect(after.messages).toEqual(before.messages);
		expect(after.contextCheckpoint).toEqual(before.contextCheckpoint);
		mode = "ok";
		expect(await host.submit(padding)).toMatchObject({ status: "succeeded" });
		expect((await host.client.getSession(session)).contextCheckpoint?.summary).toBe(fact);
	});

	it("同轮大工具结果归纳时保留当前输入，调用和结果同进退", async () => {
		const store = memory();
		const calls: string[] = [];
		let executed = 0;
		const tools = ["read_first", "read_second"].map((name) => ({
			name,
			label: name,
			description: name,
			parameters: { type: "object", properties: {} },
			async execute() {
				executed++;
				return { content: [{ type: "text", text: `${name} ${padding.repeat(3)}` }], details: {} };
			},
		}));
		const host = fixture(
			store,
			(_model, { messages }) => {
				const aggregate = JSON.stringify(messages);
				calls.push(aggregate);
				if (summary(messages)) return response([{ type: "text", text: fact }]);
				if (!aggregate.includes("此前会话的检查点"))
					return response(
						tools.map(({ name }) => ({ type: "toolCall", id: `call_${name}`, name, arguments: {} })),
						"toolUse",
					);
				return response([{ type: "text", text: fact }]);
			},
			tools,
		);
		expect(await host.submit("本轮核对目标")).toMatchObject({ status: "succeeded" });
		expect(executed).toBe(2);
		const resumed = calls.at(-1);
		expect(resumed).toContain("本轮核对目标");
		expect(resumed).not.toContain('"role":"toolResult"');
		const persisted = await host.client.getSession(session);
		expect(persisted.messages.filter(({ role }) => role === "toolResult")).toHaveLength(2);
		expect(persisted.requests[0]?.toolResults).toHaveLength(2);
	});

	it("切换模型使用新窗口，历史图片仍在，当前纯文本模型收到明确的占位说明", async () => {
		const store = memory();
		const attachment = { id: "asset:image", name: "截图.png" };
		const image = { type: "image", mimeType: "image/png", data: "c3ludGhldGlj" } as const;
		const readAttachments = async () => [image];
		const vision = fixture(
			store,
			(_model, { messages }) => {
				expect(JSON.stringify(messages)).toContain(image.data);
				return response([{ type: "text", text: "图片里的信息已整理。" }]);
			},
			[],
			{ model: { ...model, input: ["text", "image"] }, readAttachments },
		);
		const original = await vision.client.submit(session, "看截图", [attachment]);
		expect(await vision.result(original.requestId)).toMatchObject({ status: "succeeded" });
		let calls = 0;
		const text = fixture(
			store,
			(_model, { messages }) => {
				calls++;
				const wire = JSON.stringify(messages);
				expect(wire).not.toContain(image.data);
				expect(wire).toContain("原图仍可在历史中打开");
				return response([{ type: "text", text: "续接成功。" }]);
			},
			[],
			{ model: { ...model, id: "other", contextWindow: 4096 }, readAttachments },
		);
		expect(await text.client.getContextUsage(session)).toMatchObject({ limit: 4096 });
		expect(await text.submit("改用文字模型继续")).toMatchObject({ status: "succeeded" });
		expect(JSON.stringify((await text.client.getSession(session)).messages)).toContain(image.data);
		const rejected = await text.client.submit(session, "重新读取图片", [attachment]);
		expect(await text.result(rejected.requestId)).toMatchObject({ status: "failed", failure: { code: "invalid-input" } });
		expect(calls).toBe(1);
	});

	it("服务报告溢出时只重试当前模型调用，过大的本轮输入保留并给出提示", async () => {
		const store = memory();
		let providerOverflow = 0;
		let calls = 0;
		const host = fixture(store, (_model, { messages }) => {
			calls++;
			const wire = JSON.stringify(messages);
			if (!summary(messages) && wire.includes("服务实际窗口") && !wire.includes("此前会话的检查点")) {
				providerOverflow++;
				return response([], "error", "Request exceeds the context window");
			}
			return response([{ type: "text", text: fact }]);
		});
		await host.submit(padding);
		await host.submit(padding);
		expect(await host.submit("服务实际窗口较小，继续核对")).toMatchObject({ status: "succeeded" });
		expect(providerOverflow).toBe(1);
		const before = calls;
		const tooLarge = "大".repeat(3000);
		expect(await host.submit(tooLarge)).toMatchObject({
			status: "failed",
			failure: { message: expect.stringContaining("减少附件") },
		});
		expect(calls).toBe(before);
		expect((await host.client.getSession(session)).requests.at(-1)?.input).toBe(tooLarge);
	});

	it("已完成写入后的摘要失败会保留回执，重启追问不自动重做", async () => {
		const store = memory();
		let writes = 0;
		const artifact = "Flower-分析-测试/核对报告.md";
		const tools: AgentTool[] = [
			{
				name: "write_report",
				label: "写报告",
				description: "记录一次写入",
				parameters: { type: "object", properties: {} },
				async execute() {
					writes++;
					return { content: [{ type: "text", text: `${artifact}\n${padding.repeat(4)}` }], details: {} };
				},
			},
		];
		const first = fixture(
			store,
			(_model, { messages }) =>
				summary(messages)
					? response([], "error", "摘要夹具故障")
					: response([{ type: "toolCall", id: "write_once", name: "write_report", arguments: {} }], "toolUse"),
			tools,
		);
		expect(await first.submit("生成核对报告")).toMatchObject({ status: "failed" });
		expect(writes).toBe(1);
		const saved = await first.client.getSession(session);
		expect(saved.messages.at(-1)).toMatchObject({ role: "flowerToolReceipt", requestId: saved.requests[0]?.requestId });
		const restarted = fixture(
			store,
			(_model, { messages }) => {
				const wire = JSON.stringify(messages);
				expect(wire).toContain(artifact);
				expect(wire).toContain("避免直接重复外部写入");
				return response([{ type: "text", text: artifact }]);
			},
			tools,
		);
		expect(await restarted.submit("核对已经写出的报告")).toMatchObject({ status: "succeeded" });
		expect(writes).toBe(1);
	});
});
