import { randomUUID } from "node:crypto";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	parseArgs,
	resolveCliModel,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentRuntime,
	type RuntimeEvent,
	type RuntimeExecution,
	type RuntimeExecutionContext,
	type SessionSnapshot,
} from "@flower-ai/agent-runtime";
import extensionFactory from "./extension.js";
import { buildPrintTrustOptions } from "./project-trust.js";
import { configureReviewHttp } from "./review-network.js";

/** 兼容 pi print 的启动错误退出码。 */
export class ReviewStartupError extends Error {}

/** 整轮评审超过宿主软时限，且共享运行已收敛。 */
export class ReviewSoftTimeoutError extends Error {
	override readonly name = "ReviewSoftTimeoutError";

	/** @param timeoutMs 本次评审的软时限 */
	constructor(readonly timeoutMs: number) {
		super(`自动评审超时:${timeoutMs}ms 内评审未完成`);
	}
}

interface ReviewExecutionOptions {
	prompt: string;
	argv: string[];
	cwd: string;
	agentDir: string;
	workspaceId: string;
	dryRun: boolean;
	timeoutMs: number;
}

/**
 * 通过共享运行时提交一轮企业评审并等待已提交的终态。
 * @param options 经 reviewer 宿主解析的输入与运行边界
 * @returns 完整运行结束后兑现
 */
export async function executeReviewRuntime(options: ReviewExecutionOptions): Promise<void> {
	let snapshot: SessionSnapshot | undefined;
	let failure: unknown;
	let requestId: string | undefined;
	let runId: string | undefined;
	let timedOut = false;
	let cancellation: Promise<unknown> | undefined;
	type TerminalEvent = Extract<RuntimeEvent, { type: "terminal" }>;
	let resolveTerminal!: (event: TerminalEvent) => void;
	let rejectTerminal!: (error: unknown) => void;
	const terminal = new Promise<TerminalEvent>((resolve, reject) => {
		resolveTerminal = resolve;
		rejectTerminal = reject;
	});
	const sessionId = randomUUID();
	const runtime = createAgentRuntime({
		host: "flower-code-reviewer",
		store: {
			load: async () => snapshot,
			save: async (_scope, next) => {
				snapshot = next;
			},
		},
		authorize: () => ({
			workspaceId: options.workspaceId,
			async createExecution(context) {
				try {
					return await createReviewSession(options, context, (error) => {
						failure = error;
					});
				} catch (error) {
					failure = error;
					throw error;
				}
			},
		}),
	});
	const client = runtime.bindSubject({ kind: "service", id: "gitlab-reviewer" }, (event) => {
		if (event.type === "queued") {
			requestId = event.requestId;
			if (timedOut) cancel();
		} else if (event.type === "started") {
			runId = event.runId;
			console.log(`[code-reviewer] 共享运行已开始 ${runId}`);
		} else if (event.type === "terminal") {
			console.log(`[code-reviewer] 共享运行结束 ${event.status}`);
			resolveTerminal(event);
		}
	});

	function cancel() {
		if (!requestId || cancellation) return;
		cancellation = (async () => {
			if (runId) return client.cancelRunning(sessionId, runId);
			const request = await client.cancelQueued(sessionId, requestId);
			if (request.status === "running" && request.runId) return client.cancelRunning(sessionId, request.runId);
			return request;
		})();
		void cancellation.catch(rejectTerminal);
	}

	const timer =
		options.timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					cancel();
				}, options.timeoutMs)
			: undefined;
	try {
		await client.submit(sessionId, options.prompt);
		const result = await terminal;
		await cancellation;
		if (timedOut) throw new ReviewSoftTimeoutError(options.timeoutMs);
		if (result.status !== "succeeded") throw failure ?? new Error(`评审运行结束，状态 ${result.status}`);
	} finally {
		clearTimeout(timer);
	}
}

async function createReviewSession(
	options: ReviewExecutionOptions,
	context: RuntimeExecutionContext,
	onFailure: (error: unknown) => void,
): Promise<RuntimeExecution> {
	const { cwd, agentDir } = options;
	const parsed = parseArgs(options.argv);
	const runtime = await createAgentSessionRuntime(
		async ({ sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				...buildPrintTrustOptions(cwd, agentDir),
				modelRuntimeSignal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
				resourceLoaderOptions: {
					extensionFactories: [
						{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
						{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
						{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
						{ name: "flower-reviewer", factory: (pi) => extensionFactory(pi, { dryRun: options.dryRun }) },
					],
				},
			});
			context.signal.throwIfAborted();
			configureReviewHttp(services.settingsManager);
			for (const diagnostic of services.diagnostics) console.error(`[code-reviewer] ${diagnostic.message}`);
			const extensions = services.resourceLoader.getExtensions();
			for (const entry of extensions.errors) console.error(`[code-reviewer] 扩展加载失败 ${entry.path} ${entry.error}`);
			const reviewerError = extensions.errors.find(({ path }) => path === "<inline:flower-reviewer>");
			if (reviewerError) throw new ReviewStartupError(reviewerError.error);
			const selected = resolveCliModel({
				cliProvider: parsed.provider,
				cliModel: parsed.model,
				cliThinking: parsed.thinking,
				modelRuntime: services.modelRuntime,
			});
			if (!selected.model || selected.error) throw new ReviewStartupError(selected.error ?? "评审模型不可用");
			if (selected.warning) console.warn(`[code-reviewer] ${selected.warning}`);
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: selected.model,
				thinkingLevel: parsed.thinking ?? selected.thinkingLevel,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{
			cwd,
			agentDir,
			sessionManager: SessionManager.create(cwd, SettingsManager.create(cwd, agentDir).getSessionDir(), {
				id: context.providerSessionId,
			}),
		},
	);
	const { session } = runtime;
	try {
		await session.bindExtensions({
			mode: "print",
			onError: (error) => console.error(`[code-reviewer] 扩展错误 ${error.extensionPath} ${error.error}`),
		});
	} catch (error) {
		await runtime.dispose();
		throw error;
	}
	return {
		async prompt(input) {
			try {
				await session.prompt(input);
			} catch (error) {
				onFailure(error);
				throw error;
			}
		},
		subscribe: (listener) => session.agent.subscribe(listener),
		abort: () => session.abort(),
		waitForIdle: () => session.waitForIdle(),
		getMessages() {
			const { messages } = session.state;
			const last = messages.at(-1);
			if (last?.role === "assistant") {
				let failure: Error | undefined;
				if (last.stopReason === "error" || last.stopReason === "aborted") {
					failure = new Error(`LLM 流请求失败:${last.errorMessage ?? last.stopReason}`);
				} else if (last.stopReason === "length") {
					failure = new Error("评审引擎退出，输出已截断");
				}
				if (failure) {
					onFailure(failure);
					throw failure;
				}
				for (const content of last.content) {
					if (content.type === "text") console.log(content.text);
				}
			}
			return messages;
		},
		dispose: () => runtime.dispose(),
	};
}
