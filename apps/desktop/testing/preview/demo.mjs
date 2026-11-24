import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createAssistantMessageEventStream, PI_AI_VERSION } from "@earendil-works/pi-ai";
import { createAgentRuntime } from "@flower-ai/agent-runtime";

import { samples, tasks } from "./catalog.mjs";

const subject = Object.freeze({ kind: "service", id: "local-desktop-demo" });
const host = "flower-desktop-preview";
const toolName = "read_demo_file";
const model = Object.freeze({
	api: "openai-completions",
	id: "desktop-demo",
	name: "本地演示模型",
	provider: "local-preview",
	baseUrl: "http://127.0.0.1",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 512,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

/** 读取包内固定样例。文件标识不参与任意路径拼接。
 * @param sampleId 样例标识
 * @param signal 当前任务取消信号
 * @returns 已核对完整性的 UTF-8 文件内容
 */
export async function readSample(sampleId, signal) {
	const sample = samples.get(sampleId);
	if (!sample) throw new Error("请选择内置样例文件");
	const bytes = await readFile(new URL(`./samples/${sample.file}`, import.meta.url), { signal });
	if (createHash("sha256").update(bytes).digest("hex") !== sample.digest) throw new Error("内置样例内容校验失败");
	return bytes.toString("utf8");
}

function describeRecords(csv, showRows) {
	const [header, ...rows] = csv.trim().split(/\r?\n/);
	if (showRows) return [header, ...rows].join("\n");
	const label = header.split(",")[1];
	const groups = new Map();
	let total = 0;
	for (const row of rows) {
		const [group, value] = row.split(",");
		const count = Number(value);
		groups.set(group, (groups.get(group) ?? 0) + count);
		total += count;
	}
	return [
		`${rows.length} 条记录，${label}合计 ${total}。`,
		...[...groups].map(([group, count]) => `${group}：${count}`),
	].join("\n");
}

function makeStream(currentModel, context, options) {
	const stream = createAssistantMessageEventStream();
	const signal = options?.signal;
	const last = context.messages.at(-1);
	const base = {
		role: "assistant",
		api: currentModel.api,
		provider: currentModel.provider,
		model: currentModel.id,
		timestamp: Date.now(),
		content: [],
		stopReason: "pending",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	void (async () => {
		try {
			signal?.throwIfAborted();
			stream.push({ type: "start", partial: base });
			if (last?.role === "user") {
				const toolCall = { type: "toolCall", id: randomUUID(), name: toolName, arguments: {} };
				const message = { ...base, content: [toolCall], stopReason: "toolUse" };
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				return;
			}
			const records =
				last?.role === "toolResult" && !last.isError ? last.content.find((item) => item.type === "text")?.text : undefined;
			if (!records) throw new Error("未获得可读样例");
			const content = context.messages.findLast((message) => message.role === "user")?.content;
			const input = typeof content === "string" ? content : content?.find((item) => item.type === "text")?.text;
			const report = describeRecords(records, input === tasks.get("preview"));
			let text = "";
			stream.push({ type: "text_start", contentIndex: 0, partial: base });
			for (const line of report.split("\n")) {
				// 留出可观察的增量和取消窗口。
				await setTimeout(300, undefined, { signal });
				const delta = text ? `\n${line}` : line;
				text += delta;
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta,
					partial: { ...base, content: [{ type: "text", text }] },
				});
			}
			const message = { ...base, content: [{ type: "text", text }], stopReason: "stop" };
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
		} catch {
			const reason = signal?.aborted ? "aborted" : "error";
			stream.push({
				type: "error",
				reason,
				error: { ...base, stopReason: reason, errorMessage: reason === "aborted" ? "任务已取消" : "样例读取失败" },
			});
		} finally {
			stream.end();
		}
	})();
	return stream;
}

function fileStore(directory) {
	const path = (scope) =>
		join(
			directory,
			`${createHash("sha256")
				.update(JSON.stringify([scope.host, scope.subject.kind, scope.subject.id, scope.sessionId]))
				.digest("hex")}.json`,
		);
	return {
		async load(scope) {
			try {
				return JSON.parse(await readFile(path(scope), "utf8"));
			} catch (error) {
				if (error.code === "ENOENT") return undefined;
				throw error;
			}
		},
		async save(scope, snapshot) {
			await mkdir(directory, { recursive: true });
			const target = path(scope);
			const temporary = `${target}.${randomUUID()}.tmp`;
			try {
				const file = await open(temporary, "wx", 0o600);
				try {
					await file.writeFile(JSON.stringify(snapshot));
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temporary, target);
			} finally {
				await rm(temporary, { force: true });
			}
		},
	};
}

/** 创建仅支持内置样例的运行入口。
 * @param directory Host 决定的演示快照目录
 * @param onEvent 向 Host 报告的运行事件回调
 * @returns 受控提交、取消及查询入口
 */
export function createDemo(directory, onEvent) {
	const runtime = createAgentRuntime({
		host,
		store: fileStore(directory),
		authorize(scope) {
			if (scope.subject.id !== subject.id || scope.subject.kind !== subject.kind || !samples.has(scope.sessionId))
				return undefined;
			const sampleId = scope.sessionId;
			return {
				workspaceId: `built-in:${sampleId}`,
				model,
				streamFn: makeStream,
				tools: [
					{
						name: toolName,
						label: "读取样例文件",
						description: "读取本次选定的内置样例",
						parameters: { type: "object", properties: {}, additionalProperties: false },
						async execute(_id, _input, signal) {
							await setTimeout(800, undefined, { signal });
							return { content: [{ type: "text", text: await readSample(sampleId, signal) }], details: {} };
						},
					},
				],
			};
		},
	});
	const client = runtime.bindSubject(subject, onEvent);
	return {
		submit(sample, task) {
			if (!samples.has(sample) || !tasks.has(task)) throw new Error("请选择内置样例和任务");
			return client.submit(sample, tasks.get(task));
		},
		async history(sample) {
			if (!samples.has(sample)) throw new Error("请选择内置样例");
			const snapshot = await client.getSession(sample);
			return snapshot.requests.map(({ input, requestId, runId, status, text }) => ({
				input,
				requestId,
				runId,
				status,
				text,
			}));
		},
		async cancel(sample, requestId, runId) {
			if (!samples.has(sample)) throw new Error("请选择内置样例");
			if (runId) return client.cancelRunning(sample, runId);
			const record = await client.cancelQueued(sample, requestId);
			return record.status === "running" && record.runId ? client.cancelRunning(sample, record.runId) : record;
		},
	};
}

/** 读取实际加载的共享包身份。
 * @returns 运行时版本、构建哈希和 pi 版本
 */
export async function runtimeIdentity() {
	const entry = import.meta.resolve("@flower-ai/agent-runtime");
	const manifest = JSON.parse(await readFile(new URL("../package.json", entry), "utf8"));
	const fingerprint = createHash("sha256")
		.update(await readFile(new URL(entry)))
		.digest("hex");
	return { runtime: manifest.version, fingerprint, pi: PI_AI_VERSION, node: process.versions.node, pid: process.pid };
}
