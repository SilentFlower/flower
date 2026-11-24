import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, getCurrentTools, PI_AI_VERSION } from "@earendil-works/pi-ai";
import { createAgentRuntime } from "@flower-ai/agent-runtime";

export { Agent } from "@earendil-works/pi-agent-core";
export const protocolVersion = 1;
export const service = Object.freeze({ kind: "service", id: "review-service" });
export const employee = Object.freeze({ kind: "employee", id: "desktop-employee" });
export const operationProbeName = "fixture_external_write";
const fileTool = "gitlab_get_file_content";
export const partialReadText = "已开始读取。";
const model = {
	api: "openai-completions",
	id: "fixture-model",
	name: "本地受控模型",
	provider: "fixture",
	baseUrl: "http://127.0.0.1",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 512,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const readParameters = {
	type: "object",
	properties: {
		path: { type: "string" },
		ref: { type: "string" },
		startLine: { type: "integer", minimum: 1 },
		endLine: { type: "integer", minimum: 1 },
	},
	required: ["path"],
	additionalProperties: false,
};

/**
 * 从宿主实际解析的入口计算构建指纹。
 * @param entryUrl 宿主解析到的共享包入口
 * @returns 两端握手用的版本、路径及指纹
 */
export async function buildIdentity(entryUrl) {
	const entry = await realpath(fileURLToPath(entryUrl));
	const manifest = JSON.parse(await readFile(new URL("../package.json", entryUrl), "utf8"));
	const agentManifest = JSON.parse(
		await readFile(new URL("../package.json", import.meta.resolve("@earendil-works/pi-agent-core")), "utf8"),
	);
	return {
		protocolVersion,
		pid: process.pid,
		entry,
		fingerprint: createHash("sha256")
			.update(await readFile(entry))
			.digest("hex"),
		packageVersion: manifest.version,
		piAgentVersion: agentManifest.version,
		piAiVersion: PI_AI_VERSION,
	};
}

/**
 * 以私有临时目录原子提交测试快照。
 * @param directory 宿主拥有的存储目录
 * @returns 按宿主、主体、会话隔离的存储
 */
export function createFileStore(directory) {
	const pathFor = ({ host, subject, sessionId }) =>
		join(
			directory,
			`${createHash("sha256")
				.update(JSON.stringify([host, subject.kind, subject.id, sessionId]))
				.digest("hex")}.json`,
		);
	return {
		async load(scope) {
			try {
				return JSON.parse(await readFile(pathFor(scope), "utf8"));
			} catch (error) {
				if (error.code === "ENOENT") return undefined;
				throw error;
			}
		},
		async save(scope, snapshot) {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const finalPath = pathFor(scope);
			const temporary = `${finalPath}.${randomUUID()}.tmp`;
			try {
				const file = await open(temporary, "wx", 0o600);
				try {
					await file.writeFile(JSON.stringify(snapshot));
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temporary, finalPath);
			} finally {
				await rm(temporary, { force: true });
			}
		},
	};
}

/**
 * 创建受控模型、只读工具和权限变化夹具。
 * @param options 测试宿主的分区、目录和事件接收端
 * @returns 共享场景可使用的运行时和测试闸点
 */
export function createFixtureHost({
	directory,
	name,
	onEvent,
	onProbe,
	store = createFileStore(join(directory, "sessions")),
	probeOperations = false,
}) {
	const denied = new Set();
	const workspaces = new Map();
	const gates = new Map();
	const modelGates = new Map();
	const knownSubjects = new Map([service, employee].map((subject) => [subject.id, subject.kind]));
	const stats = { modelCalls: [], toolCalls: [], externalWrites: 0 };
	const localScope = ({ subject, sessionId }) => JSON.stringify([subject.id, sessionId]);

	const runtime = createAgentRuntime({
		host: name,
		store,
		authorize(scope) {
			const { subject, sessionId } = scope;
			if (knownSubjects.get(subject.id) !== subject.kind || denied.has(localScope(scope))) return undefined;
			if (sessionId.startsWith("service-only") && subject.kind !== "service") return undefined;
			if (sessionId.startsWith("employee-only") && subject.kind !== "employee") return undefined;
			const workspaceId = workspaces.get(localScope(scope)) ?? subject.kind;
			const workspace = join(directory, workspaceId);
			const credential = `private-model-fixture-${subject.id}`;
			return {
				workspaceId,
				systemPrompt: "读取获准工作区的文件行窗。",
				model,
				async streamFn(currentModel, context, options) {
					// 该标记只在宿主模型适配器内核对，不进入消息和事件。
					if (credential !== `private-model-fixture-${subject.id}`) throw new Error("模型主体不一致");
					stats.modelCalls.push({
						subject: subject.id,
						sessionId,
						providerSessionId: options?.sessionId,
						messages: structuredClone(context.messages),
						tools: getCurrentTools(context.messages).map(({ name }) => name),
					});
					const key = localScope(scope);
					const gate = modelGates.get(key);
					if (gate) {
						onProbe(subject, { type: "model_waiting", sessionId });
						try {
							await waitForRelease(gate.promise, options?.signal);
						} catch (error) {
							if (!options?.signal?.aborted) throw error;
							onProbe(subject, { type: "model_aborted", sessionId });
						} finally {
							modelGates.delete(key);
						}
					}
					return controlledStream(currentModel, context, options?.signal);
				},
				tools: [
					...[fileTool, `${subject.kind}_read_preview`].map((toolName) => ({
						name: toolName,
						label: "读取评审文件行窗",
						description: "从获准的本地评审工作区按行读取文件",
						parameters: readParameters,
						async execute(toolCallId, input, signal) {
							stats.toolCalls.push({ subject: subject.id, sessionId, toolCallId, toolName, input });
							const realRoot = await realpath(workspace);
							const requested = resolve(realRoot, input.path);
							if (isAbsolute(input.path) || !isInside(realRoot, requested)) {
								throw new Error("文件不在获准工作区");
							}
							const target = await realpath(requested).catch(() => {
								throw new Error("无法读取获准工作区中的文件");
							});
							if (!isInside(realRoot, target)) {
								throw new Error("文件不在获准工作区");
							}
							const stream = createReadStream(target, { signal, highWaterMark: 8 });
							const closed = new Promise((done) => stream.once("close", done));
							const key = localScope(scope);
							const gate = gates.get(key);
							const chunks = [];
							try {
								for await (const chunk of stream) {
									chunks.push(chunk);
									if (gate && chunks.length === 1) {
										onProbe(subject, { type: "read_chunk", sessionId, toolCallId });
										await waitForRelease(gate.promise, signal);
									}
								}
							} finally {
								stream.destroy();
								await closed;
								if (gate) {
									gates.delete(key);
									onProbe(subject, { type: "read_closed", sessionId, toolCallId });
								}
							}
							const lines = Buffer.concat(chunks).toString("utf8").split("\n");
							const start = input.startLine ?? 1;
							const end = Math.min(lines.length, input.endLine ?? start + 499, start + 999);
							const text =
								"<!-- 行窗: " +
								start +
								"-" +
								end +
								" / 共 " +
								lines.length +
								" 行 -->\n" +
								lines.slice(start - 1, end).join("\n");
							return { content: [{ type: "text", text }], details: {} };
						},
					})),
					...(probeOperations
						? [
								{
									name: operationProbeName,
									label: "外部操作计数替身",
									description: "仅记录测试调用次数",
									parameters: readParameters,
									async execute() {
										stats.externalWrites += 1;
										return { content: [{ type: "text", text: "测试替身已计数" }], details: {} };
									},
								},
							]
						: []),
				],
			};
		},
	});

	return {
		client(subject) {
			return runtime.bindSubject(subject, (event) => onEvent(subject, event));
		},
		holdRead(subject, sessionId) {
			const key = localScope({ subject, sessionId });
			if (gates.has(key)) throw new Error("此会话已有读取闸点");
			gates.set(key, Promise.withResolvers());
		},
		releaseRead(subject, sessionId) {
			gates.get(localScope({ subject, sessionId }))?.resolve();
		},
		holdModel(subject, sessionId) {
			modelGates.set(localScope({ subject, sessionId }), Promise.withResolvers());
		},
		setAllowed(subject, sessionId, allowed) {
			const key = localScope({ subject, sessionId });
			if (allowed) denied.delete(key);
			else denied.add(key);
		},
		setWorkspace(subject, sessionId, workspaceId) {
			workspaces.set(localScope({ subject, sessionId }), workspaceId);
		},
		stats() {
			return structuredClone(stats);
		},
	};
}

function isInside(root, target) {
	const path = relative(root, target);
	return !!path && !isAbsolute(path) && path.split(sep)[0] !== "..";
}

function waitForRelease(promise, signal) {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise((done, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(() => {
			signal.removeEventListener("abort", abort);
			done();
		});
	});
}

function controlledStream(currentModel, context, signal) {
	const stream = createAssistantMessageEventStream();
	const last = context.messages.at(-1);
	const base = {
		role: "assistant",
		api: currentModel.api,
		provider: currentModel.provider,
		model: currentModel.id,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [],
		stopReason: "pending",
	};
	queueMicrotask(() => {
		if (signal?.aborted) {
			stream.push({ type: "error", reason: "aborted", error: { ...base, stopReason: "aborted" } });
		} else {
			stream.push({ type: "start", partial: base });
			if (last?.role === "user") {
				const prompt =
					typeof last.content === "string" ? last.content : last.content.map((part) => part.text ?? "").join("");
				const name = /工具:(\S+)/.exec(prompt)?.[1] ?? fileTool;
				const path = /路径:(\S+)/.exec(prompt)?.[1] ?? "src/a.ts";
				const toolCall = {
					type: "toolCall",
					id: randomUUID(),
					name,
					arguments: { path, ref: "fixture", startLine: 1, endLine: 2 },
				};
				const content = [];
				if (prompt === "请求 A" || prompt === "断开时正在运行") {
					content.push({ type: "text", text: partialReadText });
					const partial = { ...base, content: [...content] };
					stream.push({ type: "text_start", contentIndex: 0, partial: base });
					stream.push({ type: "text_delta", contentIndex: 0, delta: partialReadText, partial });
					stream.push({ type: "text_end", contentIndex: 0, content: partialReadText, partial });
				}
				const contentIndex = content.length;
				const result = { ...base, content: [...content, toolCall], stopReason: "toolUse" };
				stream.push({ type: "toolcall_start", contentIndex, partial: result });
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: result });
				stream.push({ type: "done", reason: "toolUse", message: result });
			} else {
				// 第二轮依赖真实工具结果，收到预期回执后才生成文本。
				const toolText = last?.role === "toolResult" ? last.content.map((part) => part.text ?? "").join("") : "";
				if (!toolText) {
					stream.push({ type: "error", reason: "error", error: { ...base, stopReason: "error" } });
				} else {
					const prefix = last.isError ? "读取受限：" : "读取结果：";
					const text = prefix + toolText;
					const first = { ...base, content: [{ type: "text", text: prefix }] };
					const result = { ...base, content: [{ type: "text", text }], stopReason: "stop" };
					stream.push({ type: "text_start", contentIndex: 0, partial: base });
					stream.push({ type: "text_delta", contentIndex: 0, delta: prefix, partial: first });
					stream.push({ type: "text_delta", contentIndex: 0, delta: toolText, partial: result });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: result });
					stream.push({ type: "done", reason: "stop", message: result });
				}
			}
		}
		stream.end();
	});
	return stream;
}
