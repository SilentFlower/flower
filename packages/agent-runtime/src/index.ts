import { createHash, randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createContextWindow, estimateRuntimeUsage, modelMessages } from "./context-window.js";
import type {
	AgentRuntime,
	ContextCheckpoint,
	FailureCode,
	RequestRecord,
	RuntimeAttachment,
	RuntimeContextUsage,
	RuntimeEvent,
	RuntimeExecution,
	RuntimeExecutionContext,
	RuntimeOptions,
	SessionGrant,
	SessionScope,
	SessionSnapshot,
	SteerRecord,
	StoredSessionSnapshot,
	TerminalStatus,
	ToolStep,
} from "./types.js";

export type {
	AgentRuntime,
	ContextCheckpoint,
	ExternalOperation,
	FailureCode,
	RequestRecord,
	RequestStatus,
	RuntimeAttachment,
	RuntimeContextUsage,
	RuntimeEvent,
	RuntimeExecution,
	RuntimeExecutionContext,
	RuntimeFailure,
	RuntimeModelStream,
	RuntimeOptions,
	RuntimeSubject,
	SessionGrant,
	SessionScope,
	SessionSnapshot,
	SessionStore,
	SteerRecord,
	StoredSessionSnapshot,
	SubjectRuntime,
	TerminalStatus,
	ToolResult,
	ToolStep,
} from "./types.js";

type EventBody<T extends RuntimeEvent = RuntimeEvent> = T extends RuntimeEvent
	? Omit<T, "sessionId" | "requestId" | "runId" | "sequence" | "at">
	: never;
type Notification = readonly [RequestRecord, EventBody];
type Observer = (event: RuntimeEvent) => void;
type PendingSteer = Pick<SteerRecord, "steerId" | "input" | "attachments">;
/** 当前运行的取消、执行体与待送达插话。 */
interface ActiveRun {
	runId: string;
	controller: AbortController;
	execution?: RuntimeExecution;
	/** 已排入执行体、尚未送达的插话，顺序与执行体队列一致。 */
	steering: PendingSteer[];
	/** 插话按提交顺序逐条排入执行体，附件读取较慢的插话不会被后来者越过。 */
	steerTail: Promise<void>;
	/** 本轮请求自身的用户消息是否已开始。 */
	prompted: boolean;
}

/** 宿主可识别的运行时异常。 */
export class RuntimeError extends Error {
	/**
	 * 创建可展示的异常。
	 * @param code 稳定的错误类别
	 * @param message 排除凭据与底层异常细节的说明
	 */
	constructor(
		readonly code: FailureCode,
		message: string,
	) {
		super(message);
		this.name = "RuntimeError";
	}
}

/**
 * 创建一个由宿主管理授权和存储的运行时。
 * @param options 宿主分区、授权入口与持久化能力
 * @returns 可绑定宿主已核验主体的运行时
 */
export function createAgentRuntime(options: RuntimeOptions): AgentRuntime {
	assertPresent(options.host);
	const host = options.host;
	const sessions = new Map<string, SessionRunner>();

	return {
		bindSubject(subject, onEvent) {
			assertPresent(subject.id);
			if (subject.kind !== "service" && subject.kind !== "employee") {
				throw new RuntimeError("invalid-input", "主体类型无效");
			}
			const identity = Object.freeze({ id: subject.id, kind: subject.kind });
			const getRunner = (sessionId: string) => {
				assertPresent(sessionId);
				const key = JSON.stringify([host, identity.kind, identity.id, sessionId]);
				let runner = sessions.get(key);
				if (!runner) {
					runner = new SessionRunner(
						Object.freeze({ host, subject: identity, sessionId }),
						createHash("sha256").update(key).digest("hex"),
						options,
					);
					sessions.set(key, runner);
				}
				return runner;
			};
			return {
				submit: (sessionId, input, attachments) => getRunner(sessionId).submit(input, onEvent, attachments),
				cancelQueued: (sessionId, requestId) => getRunner(sessionId).cancelQueued(requestId),
				cancelRunning: (sessionId, runId) => getRunner(sessionId).cancelRunning(runId),
				getSession: (sessionId) => getRunner(sessionId).getSession(),
				getContextUsage: (sessionId) => getRunner(sessionId).getContextUsage(),
				steer: (sessionId, runId, steerId, input, attachments) =>
					getRunner(sessionId).steer(runId, steerId, input, attachments),
			};
		},
	};
}

/** 一个分区内串行提交快照，独立分区可以并行运行。 */
class SessionRunner {
	private tail = Promise.resolve();
	private snapshot?: SessionSnapshot;
	private fault?: RuntimeError;
	private readonly observers = new Map<string, Observer>();
	private active?: ActiveRun;

	constructor(
		private readonly scope: SessionScope,
		private readonly providerSessionId: string,
		private readonly options: RuntimeOptions,
	) {}

	submit(input: string, observer: Observer, attachments?: readonly RuntimeAttachment[]): Promise<RequestRecord> {
		const refs = attachments?.map(({ id, name }) => {
			assertPresent(id);
			assertPresent(name);
			return { id, name };
		});
		return this.withAccess(async (snapshot) => {
			assertPresent(input);
			const position = queued(snapshot.requests).length + 1;
			const request: RequestRecord = {
				requestId: randomUUID(),
				workspaceId: snapshot.workspaceId,
				input,
				...(refs?.length ? { attachments: refs } : {}),
				status: "queued",
				text: "",
				toolResults: [],
			};
			snapshot.requests.push(request);
			this.observers.set(request.requestId, observer);
			try {
				await this.commit(snapshot, [[request, { type: "queued", position }]]);
			} catch (error) {
				this.observers.delete(request.requestId);
				throw error;
			}
			this.schedule();
			return structuredClone(request);
		});
	}

	cancelQueued(requestId: string): Promise<RequestRecord> {
		assertPresent(requestId);
		return this.withAccess(async (snapshot) => {
			const request = requireRequest(snapshot.requests.find((entry) => entry.requestId === requestId));
			if (request.status !== "queued") return request;
			const index = queued(snapshot.requests).indexOf(request);
			request.status = "cancelled";
			await this.commit(snapshot, [[request, { type: "terminal", status: "cancelled" }], ...positions(snapshot, index)]);
			this.observers.delete(requestId);
			return structuredClone(request);
		});
	}

	cancelRunning(runId: string): Promise<RequestRecord> {
		assertPresent(runId);
		return this.withAccess(async (snapshot) => {
			const request = requireRequest(snapshot.requests.find((entry) => entry.runId === runId));
			if (request.status !== "running") return request;
			request.status = "cancelling";
			await this.commit(snapshot, [[request, { type: "cancelling" }]]);
			this.active?.controller.abort();
			return structuredClone(request);
		});
	}

	steer(runId: string, steerId: string, input: string, attachments?: readonly RuntimeAttachment[]): Promise<void> {
		assertPresent(runId);
		assertPresent(steerId);
		const refs = attachments?.map(({ id, name }) => {
			assertPresent(id);
			assertPresent(name);
			return { id, name };
		});
		return this.withAccess((snapshot) => {
			assertPresent(input);
			const request = requireRequest(snapshot.requests.find((entry) => entry.runId === runId));
			const active = this.active;
			if (request.status !== "running" || active?.runId !== runId) {
				throw new RuntimeError("invalid-input", "当前运行已结束，无法插话");
			}
			const execution = active.execution;
			if (!execution?.steer) throw new RuntimeError("invalid-input", "当前运行不支持插话");
			if (
				active.steering.some((entry) => entry.steerId === steerId) ||
				request.steers?.some((entry) => entry.steerId === steerId)
			) {
				throw new RuntimeError("invalid-input", "这条插话已经提交");
			}
			const pending: PendingSteer = { steerId, input, ...(refs?.length ? { attachments: refs } : {}) };
			active.steering.push(pending);
			// 附件读取可能较慢，放在串行区外，避免阻塞运行进度的提交。
			const queued = active.steerTail.then(() => execution.steer?.(input, pending.attachments));
			active.steerTail = queued.catch(() => undefined);
			return { active, pending, queued };
		}, false).then(async ({ active, pending, queued }) => {
			try {
				await queued;
			} catch (error) {
				const index = active.steering.indexOf(pending);
				if (index >= 0) active.steering.splice(index, 1);
				throw error instanceof RuntimeError ? error : new RuntimeError("invalid-input", "插话未能送入当前运行");
			}
		});
	}

	getSession(): Promise<SessionSnapshot> {
		return this.withAccess((snapshot) => snapshot);
	}

	getContextUsage(): Promise<RuntimeContextUsage | undefined> {
		return this.withAccess((snapshot, grant) => {
			if (!("model" in grant)) return undefined;
			return estimateRuntimeUsage(
				grant.model,
				snapshot.messages,
				snapshot.contextCheckpoint,
				grant.systemPrompt,
				grant.tools,
			);
		}, false);
	}

	private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
		const next = this.tail.then(() => {
			if (this.fault) throw this.fault;
			return operation();
		});
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private withAccess<T>(
		operation: (snapshot: SessionSnapshot, grant: SessionGrant) => Promise<T> | T,
		copy = true,
	): Promise<T> {
		return this.serialize(async () => {
			const grant = await this.getGrant();
			if (!grant) throw new RuntimeError("denied", "无会话或工作区权限");
			const { workspaceId } = grant;
			this.snapshot ??= await this.restore(workspaceId);
			if (this.snapshot) {
				assertWorkspace(this.snapshot.workspaceId, workspaceId);
				return operation(copy ? structuredClone(this.snapshot) : this.snapshot, grant);
			}
			// 空会话只在首条请求保存成功后绑定，查询本身不占用会话标识。
			return operation(
				{
					version: 1,
					workspaceId,
					lastSequence: 0,
					requests: [],
					messages: [],
					artifacts: [],
					operations: [],
				},
				grant,
			);
		});
	}

	private async getGrant(): Promise<SessionGrant | undefined> {
		try {
			const grant = await this.options.authorize(this.scope);
			return grant?.workspaceId ? grant : undefined;
		} catch {
			return undefined;
		}
	}

	private async restore(workspaceId: string): Promise<SessionSnapshot | undefined> {
		let stored: StoredSessionSnapshot | undefined;
		try {
			stored = await this.options.store.load(this.scope);
		} catch {
			throw new RuntimeError("storage", "无法读取会话记录");
		}
		if (!stored) return undefined;
		if (stored.version !== 1) throw new RuntimeError("storage", "会话记录版本不受支持");
		const boundWorkspace = stored.workspaceId ?? stored.requests[0]?.workspaceId;
		// 历史可能包含多个工作区的消息，只有全量请求归属一致时才允许恢复。
		if (!boundWorkspace || stored.requests.some((request) => request.workspaceId !== boundWorkspace)) {
			throw new RuntimeError("storage", "会话记录缺少一致的工作区绑定");
		}
		assertWorkspace(boundWorkspace, workspaceId);
		const snapshot = { ...stored, workspaceId: boundWorkspace };
		const pending = snapshot.requests.filter(
			({ status }) => status === "queued" || status === "running" || status === "cancelling",
		);
		for (const request of pending) {
			request.status = "interrupted";
			rememberToolReceipts(snapshot, request);
		}
		if (pending.length || stored.workspaceId === undefined) await this.commit(snapshot, []);
		return snapshot;
	}

	private async commit(snapshot: SessionSnapshot, notifications: readonly Notification[]): Promise<void> {
		const at = Date.now();
		for (const [request, body] of notifications) {
			// 起止时刻与对应事件同批落盘，宿主重启后仍可计算耗时，不额外增加写入。
			if (body.type === "started") request.startedAt = at;
			if (body.type === "terminal") request.endedAt = at;
		}
		const events: RuntimeEvent[] = notifications.map(([request, body]) => ({
			...body,
			sessionId: this.scope.sessionId,
			requestId: request.requestId,
			runId: request.runId,
			sequence: ++snapshot.lastSequence,
			at,
		}));
		try {
			await this.options.store.save(this.scope, structuredClone(snapshot));
		} catch {
			throw new RuntimeError("storage", "无法提交会话记录");
		}
		this.snapshot = snapshot;
		for (const event of events) {
			try {
				this.observers.get(event.requestId)?.(structuredClone(event));
			} catch {
				// 事件接收端故障时以已提交的会话记录为准。
			}
		}
	}

	private schedule(): void {
		this.background(
			this.serialize(async () => {
				if (this.active || !this.snapshot) return;
				const snapshot = structuredClone(this.snapshot);
				const request = queued(snapshot.requests)[0];
				if (!request) return;
				const grant = await this.getGrant();
				if (grant?.workspaceId !== snapshot.workspaceId) {
					request.status = "denied";
					request.failure = { code: "denied", message: "启动前会话或工作区授权已失效" };
					await this.commit(snapshot, [
						[request, { type: "terminal", status: "denied", failure: request.failure }],
						...positions(snapshot),
					]);
					this.observers.delete(request.requestId);
					this.schedule();
					return;
				}
				const runId = randomUUID();
				request.runId = runId;
				request.status = "running";
				await this.commit(snapshot, [[request, { type: "started" }], ...positions(snapshot)]);
				const controller = new AbortController();
				this.active = { controller, runId, steering: [], steerTail: Promise.resolve(), prompted: false };
				this.background(
					this.run(
						grant,
						request,
						runId,
						{
							messages: snapshot.messages,
							attachments: request.attachments,
							providerSessionId: this.providerSessionId,
							signal: controller.signal,
						},
						snapshot.contextCheckpoint,
					),
				);
			}),
		);
	}

	private async run(
		grant: SessionGrant,
		request: RequestRecord,
		runId: string,
		context: RuntimeExecutionContext,
		checkpoint?: ContextCheckpoint,
	): Promise<void> {
		let execution: RuntimeExecution | undefined;
		let unsubscribe: (() => void) | undefined;
		let aborting: Promise<void> | undefined;
		let messages: readonly AgentMessage[] = [];
		let status: TerminalStatus = "succeeded";
		let failure: RuntimeError | undefined;
		let projection: ReturnType<typeof createContextWindow> | undefined;
		const abort = () => {
			aborting = Promise.resolve()
				.then(() => execution?.abort())
				.catch(() => {
					status = "failed";
				});
		};
		try {
			if ("createExecution" in grant) execution = await grant.createExecution(context);
			else {
				projection = createContextWindow(grant.streamFn, checkpoint);
				execution = createNativeExecution(grant, context, projection.streamFn);
			}
			if (this.active?.runId === runId) this.active.execution = execution;
			if (context.signal.aborted) {
				status = "cancelled";
			} else {
				context.signal.addEventListener("abort", abort, { once: true });
				unsubscribe = execution.subscribe((event) =>
					this.recordProgress(runId, event, (toolName, args) => grant.describeTool?.(toolName, args)),
				);
				await execution.prompt(request.input);
				// agent_end 的监听器与 SDK 重试可能尚未结束。
				await execution.waitForIdle();
				messages = execution.getMessages();
				const last = messages.at(-1);
				if (last?.role === "assistant") {
					if (last.stopReason === "error") status = "failed";
					if (last.stopReason === "aborted") status = "cancelled";
				}
				const contextError = projection?.failure();
				if (status === "failed" && contextError) failure = new RuntimeError("agent-error", contextError);
			}
		} catch (error) {
			status = "failed";
			if (error instanceof RuntimeError) failure = error;
		} finally {
			context.signal.removeEventListener("abort", abort);
			try {
				await aborting;
				if (status === "failed") await execution?.waitForIdle();
			} catch {
				status = "failed";
			} finally {
				unsubscribe?.();
				try {
					await execution?.dispose?.();
				} catch {
					status = "failed";
				}
			}
		}

		await this.serialize(async () => {
			if (!this.snapshot || this.active?.runId !== runId) return;
			const snapshot = structuredClone(this.snapshot);
			const record = requireRequest(snapshot.requests.find((entry) => entry.runId === runId));
			record.status = record.status === "cancelling" ? "cancelled" : status;
			if (record.status === "failed")
				record.failure = { code: failure?.code ?? "agent-error", message: failure?.message ?? "模型运行失败" };
			if (record.status === "succeeded") {
				// 重新注入当前授权的系统提示与工具，避免从旧轮次恢复其工具定义。
				const firstNew = snapshot.messages.length;
				snapshot.messages = structuredClone(messages.filter((message) => message.role !== "system"));
				if (projection) {
					const message = snapshot.messages[firstNew];
					if (message?.role === "user") {
						const owned = { ...message, flowerRequestId: record.requestId };
						snapshot.messages[firstNew] = owned;
						record.userMessageIndex = firstNew;
					}
					snapshot.contextCheckpoint = projection.checkpoint();
				} else delete snapshot.contextCheckpoint;
			} else rememberToolReceipts(snapshot, record);
			await this.commit(snapshot, [[record, { type: "terminal", status: record.status, failure: record.failure }]]);
			this.observers.delete(record.requestId);
			this.active = undefined;
			this.schedule();
		});
	}

	private async recordProgress(
		runId: string,
		event: AgentEvent,
		describe: (toolName: string, args: unknown) => string | undefined,
	): Promise<void> {
		let body: EventBody;
		let steer: PendingSteer | undefined;
		if (event.type === "message_start" && event.message.role === "user") {
			const active = this.active;
			if (active?.runId !== runId) return;
			// 每轮第一条用户消息是请求本身，其后的用户消息按排入顺序对应插话。
			if (!active.prompted) {
				active.prompted = true;
				return;
			}
			// 取消后 pi 仍可能在工具失败后注入排队的插话，但这一轮不会进入上下文，不算送达。
			if (active.controller.signal.aborted) return;
			steer = active.steering.shift();
			if (!steer) return;
			body = { type: "steered", steerId: steer.steerId };
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			body = { type: "text_delta", delta: event.assistantMessageEvent.delta };
		} else if (event.type === "tool_execution_start") {
			const target = toolTarget(describe, event.toolName, event.args);
			body = { type: "tool_started", toolName: event.toolName, toolCallId: event.toolCallId, ...(target && { target }) };
		} else if (event.type === "tool_execution_end") {
			body = {
				type: "tool_result",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				text: getToolText(event.result),
				isError: event.isError,
			};
		} else {
			return;
		}

		await this.serialize(async () => {
			if (!this.snapshot || this.active?.runId !== runId) return;
			const snapshot = structuredClone(this.snapshot);
			const record = requireRequest(snapshot.requests.find((entry) => entry.runId === runId));
			if (body.type === "text_delta") record.text += body.delta;
			if (steer) {
				const delivered: SteerRecord = { ...steer, at: Date.now(), textOffset: record.text.length };
				record.steers = [...(record.steers ?? []), delivered];
			}
			if (body.type === "tool_started") {
				const step: ToolStep = { toolCallId: body.toolCallId, toolName: body.toolName, startedAt: Date.now() };
				if (body.target) step.target = body.target;
				record.steps = [...(record.steps ?? []), step];
			}
			if (body.type === "tool_result") {
				record.toolResults.push({
					toolName: body.toolName,
					toolCallId: body.toolCallId,
					text: body.text,
					isError: body.isError,
				});
				const step = record.steps?.find(({ toolCallId, endedAt }) => toolCallId === body.toolCallId && !endedAt);
				if (step) {
					step.endedAt = Date.now();
					step.isError = body.isError;
				}
			}
			await this.commit(snapshot, [[record, body]]);
		});
	}

	private background(operation: Promise<void>): void {
		void operation.catch(() => {
			// 持久化失败后停在上一个已提交状态，避免调度下一条。
			this.fault = new RuntimeError("storage", "会话执行状态未能提交");
			this.active?.controller.abort();
		});
	}
}

function createNativeExecution(
	grant: Extract<SessionGrant, { model: unknown }>,
	context: RuntimeExecutionContext,
	streamFn: StreamFn,
): RuntimeExecution {
	const agent = new Agent({
		initialState: {
			model: grant.model,
			systemPrompt: grant.systemPrompt,
			messages: [...context.messages],
			tools: [...grant.tools],
		},
		streamFn,
		convertToLlm: modelMessages,
		sessionId: context.providerSessionId,
	});
	return {
		async prompt(input) {
			if (!context.attachments?.length) return agent.prompt(input);
			if (!grant.readAttachments) throw new RuntimeError("invalid-input", "当前宿主未配置附件读取。");
			const evidence = await grant.readAttachments(context.attachments, context.signal);
			context.signal.throwIfAborted();
			if (!grant.model.input.includes("image") && evidence.some(({ type }) => type === "image")) {
				throw new RuntimeError("invalid-input", "当前模型不支持图片附件，请使用支持图片的模型。");
			}
			await agent.prompt({ role: "user", content: [{ type: "text", text: input }, ...evidence], timestamp: Date.now() });
		},
		async steer(input, attachments) {
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: input }];
			if (attachments?.length) {
				if (!grant.readAttachments) throw new RuntimeError("invalid-input", "当前宿主未配置附件读取。");
				const evidence = await grant.readAttachments(attachments, context.signal);
				context.signal.throwIfAborted();
				if (!grant.model.input.includes("image") && evidence.some(({ type }) => type === "image")) {
					throw new RuntimeError("invalid-input", "当前模型不支持图片附件，请使用支持图片的模型。");
				}
				content.push(...evidence);
			}
			agent.steer({ role: "user", content, timestamp: Date.now() });
		},
		subscribe: (listener) => agent.subscribe(listener),
		abort: () => agent.abort(),
		waitForIdle: () => agent.waitForIdle(),
		getMessages: () => agent.state.messages,
	};
}

function queued(requests: RequestRecord[]): RequestRecord[] {
	return requests.filter(({ status }) => status === "queued");
}

/**
 * 调用宿主钩子生成工具的展示目标。
 * @param describe 宿主提供的描述函数
 * @param toolName 工具名
 * @param args 模型给出的工具参数
 * @returns 截断后的目标；宿主异常或返回空值时为 undefined
 */
function toolTarget(
	describe: (toolName: string, args: unknown) => string | undefined,
	toolName: string,
	args: unknown,
): string | undefined {
	let target: unknown;
	try {
		target = describe(toolName, args);
	} catch {
		// 展示目标只是辅助信息，宿主描述失败不能中断工具执行记录。
		return undefined;
	}
	if (typeof target !== "string") return undefined;
	const trimmed = target.trim();
	return trimmed ? Array.from(trimmed).slice(0, 120).join("") : undefined;
}

function rememberToolReceipts(snapshot: SessionSnapshot, request: RequestRecord): void {
	if (!request.toolResults.length) return;
	// 失败或断开后的请求不重放。工具的原始结果留在请求记录，后续模型可看到已发生的操作。
	const receipts = request.toolResults.map(({ toolName, toolCallId, text, isError }) => {
		const result = text.join("\n");
		const sample = result.length > 2048 ? `${result.slice(0, 2048)}…（完整结果在请求记录中）` : result;
		return `${toolName} (${toolCallId}) ${isError ? "执行失败" : "已完成"}\n${sample}`;
	});
	snapshot.messages.push({
		role: "flowerToolReceipt",
		requestId: request.requestId,
		timestamp: Date.now(),
		content: `未完成请求 ${request.requestId} 的工具回执（会话记录，仅供核对）。续接时核对已发生的操作，避免直接重复外部写入。\n${receipts.join("\n\n")}`,
	});
}

function positions(snapshot: SessionSnapshot, from = 0): Notification[] {
	return queued(snapshot.requests)
		.slice(from)
		.map((request, index) => [request, { type: "queued", position: from + index + 1 }]);
}

function assertPresent(value: string): void {
	if (typeof value !== "string" || !value.trim()) throw new RuntimeError("invalid-input", "标识或输入不能为空");
}

function assertWorkspace(boundWorkspace: string, authorizedWorkspace: string): void {
	if (boundWorkspace !== authorizedWorkspace) throw new RuntimeError("denied", "当前授权不涵盖此会话的工作区");
}

function requireRequest(request: RequestRecord | undefined): RequestRecord {
	if (!request) throw new RuntimeError("not-found", "当前会话不存在此请求或运行");
	return request;
}

function getToolText(result: unknown): string[] {
	if (typeof result !== "object" || !result || !("content" in result) || !Array.isArray(result.content)) return [];
	return result.content.flatMap((item: unknown) => {
		if (
			typeof item === "object" &&
			item &&
			"type" in item &&
			item.type === "text" &&
			"text" in item &&
			typeof item.text === "string"
		) {
			return [item.text];
		}
		return [];
	});
}
