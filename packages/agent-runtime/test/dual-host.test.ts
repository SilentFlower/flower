import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "@earendil-works/pi-agent-core";
import type {
	RequestRecord,
	RuntimeEvent,
	RuntimeSubject,
	SessionSnapshot,
	SessionStore,
	SubjectRuntime,
} from "@flower-ai/agent-runtime";
import { createAgentRuntime } from "@flower-ai/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 交由 Node 原生加载 ESM 夹具，使握手证据来自实际包导出。
const require = createRequire(import.meta.url);
const { createEnterpriseHost } = require("./fixtures/enterprise.mjs") as typeof import("./fixtures/enterprise.mjs");
const {
	Agent: NativeAgent,
	createFileStore,
	employee,
	operationProbeName,
	partialReadText,
	protocolVersion,
	service,
} = require("./fixtures/host.mjs") as typeof import("./fixtures/host.mjs");

type Identity = {
	protocolVersion: number;
	entry: string;
	fingerprint: string;
	pid: number;
	packageVersion: string;
	piAgentVersion: string;
	piAiVersion: string;
};
type Probe = {
	type: "read_chunk" | "read_closed" | "model_waiting" | "model_aborted";
	sessionId: string;
	toolCallId?: string;
};
type Stats = {
	modelCalls: { subject: string; providerSessionId: string; sessionId: string; tools: string[]; messages: unknown[] }[];
	toolCalls: { subject: string; toolName: string; sessionId: string }[];
	externalWrites: number;
};
type Frame =
	| ({ kind: "ready" } & Identity)
	| { kind: "event"; subject?: string; event: RuntimeEvent }
	| { kind: "probe"; subject?: string; probe: Probe }
	| { kind: "response"; id: string; ok: boolean; value: unknown; failure?: { code: string; message: string } };
type EventFrame = Extract<Frame, { kind: "event" }>;
type ProbeFrame = Extract<Frame, { kind: "probe" }>;

type Adapter = {
	client: SubjectRuntime;
	trace: Trace;
	identity: Identity;
	holdRead(sessionId: string): unknown;
	releaseRead(sessionId: string): unknown;
	stats(): Stats | Promise<Stats>;
};

/** 采集实际 IPC 和进程内事件，测试通过事件闸点推进。 */
class Trace {
	readonly rows: Frame[] = [];
	private readonly listeners = new Set<(frame: Frame) => void>();

	push(frame: Frame): void {
		this.rows.push(frame);
		for (const listen of this.listeners) listen(frame);
	}

	wait<T extends Frame>(predicate: (frame: Frame) => frame is T): Promise<T> {
		const existing = this.rows.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(new Error(`等待宿主事件超时：${JSON.stringify(this.rows.slice(-8))}`));
			}, 5000);
			const listener = (frame: Frame) => {
				if (!predicate(frame)) return;
				clearTimeout(timer);
				this.listeners.delete(listener);
				resolve(frame);
			};
			this.listeners.add(listener);
		});
	}

	event(sessionId: string, kind: RuntimeEvent["type"], requestId?: string, subject?: string): Promise<EventFrame> {
		return this.wait(
			(row): row is EventFrame =>
				row.kind === "event" &&
				row.event.sessionId === sessionId &&
				row.event.type === kind &&
				(requestId === undefined || row.event.requestId === requestId) &&
				(subject === undefined || row.subject === subject),
		);
	}

	probe(sessionId: string, kind: Probe["type"], subject?: string): Promise<ProbeFrame> {
		return this.wait(
			(row): row is ProbeFrame =>
				row.kind === "probe" &&
				row.probe.sessionId === sessionId &&
				row.probe.type === kind &&
				(subject === undefined || row.subject === subject),
		);
	}

	events(sessionId: string, subject?: string): RuntimeEvent[] {
		return this.rows.flatMap((row) =>
			row.kind === "event" && row.event.sessionId === sessionId && (subject === undefined || row.subject === subject)
				? [row.event]
				: [],
		);
	}
}

let directory: string;
const children = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "flower-runtime-"));
	for (const [kind, marker] of [
		["service", "SERVICE-ONLY"],
		["employee", "EMPLOYEE-ONLY"],
	] as const) {
		await mkdir(join(directory, kind, "src"), { recursive: true });
		await writeFile(join(directory, kind, "src/a.ts"), `const scope = '${marker}';\nconst line = 2;\nconst tail = 3;`);
	}
	await symlink(join(directory, "employee/src/a.ts"), join(directory, "service/src/outside.ts"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const [child, exited] of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	}
	children.clear();
	await rm(directory, { recursive: true, force: true });
});

async function enterprise(store?: SessionStore) {
	const trace = new Trace();
	const host = await createEnterpriseHost({
		directory,
		store,
		onEvent: (subject: RuntimeSubject, event: RuntimeEvent) => trace.push({ kind: "event", subject: subject.id, event }),
		onProbe: (subject: RuntimeSubject, probe: Probe) => trace.push({ kind: "probe", subject: subject.id, probe }),
	});
	return {
		client: host.client as SubjectRuntime,
		trace,
		identity: host.identity as Identity,
		holdRead: (sessionId: string) => host.fixture.holdRead(service, sessionId),
		releaseRead: (sessionId: string) => host.fixture.releaseRead(service, sessionId),
		stats: () => host.fixture.stats() as Stats,
		fixture: host.fixture,
	};
}

async function desktop(probeOperations = false) {
	const trace = new Trace();
	const child = fork(
		fileURLToPath(new URL("../../../apps/desktop/verification/runtime-child.mjs", import.meta.url)),
		probeOperations ? [directory, "--operation-probe"] : [directory],
		{
			execArgv: [],
			env: {},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
		child.once("error", reject);
	});
	children.set(child, exited);
	child.on("message", (frame) => trace.push(frame as Frame));
	child.stdout?.resume();
	let stderr = "";
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});

	const identity = await Promise.race([
		trace.wait((frame): frame is Extract<Frame, { kind: "ready" }> => frame.kind === "ready"),
		exited.then(({ code, signal }) => {
			throw new Error(`桌面验证进程提前退出：${JSON.stringify({ code, signal, stderr })}`);
		}),
	]);
	expect(identity.protocolVersion).toBe(protocolVersion);
	expect(identity.pid).toBe(child.pid);

	async function command<T = void>(
		type: string,
		payload: Record<string, unknown> = {},
		version = protocolVersion,
	): Promise<T> {
		const id = randomUUID();
		const response = trace.wait(
			(frame): frame is Extract<Frame, { kind: "response" }> => frame.kind === "response" && frame.id === id,
		);
		await new Promise<void>((done, reject) => {
			child.send({ ...payload, type, id, protocolVersion: version }, (error) => (error ? reject(error) : done()));
		});
		const reply = await response;
		if (!reply.ok) throw Object.assign(new Error(reply.failure?.message), { code: reply.failure?.code });
		return reply.value as T;
	}

	const client: SubjectRuntime = {
		submit: (sessionId, input) => command<RequestRecord>("submit", { sessionId, input }),
		cancelQueued: (sessionId, requestId) => command<RequestRecord>("cancelQueued", { sessionId, requestId }),
		cancelRunning: (sessionId, runId) => command<RequestRecord>("cancelRunning", { sessionId, runId }),
		getSession: (sessionId) => command<SessionSnapshot>("query", { sessionId }),
	};
	return {
		client,
		trace,
		identity,
		command,
		holdRead: (sessionId: string) => command("holdRead", { sessionId }),
		releaseRead: (sessionId: string) => command("releaseRead", { sessionId }),
		stats: () => command<Stats>("stats"),
		async close() {
			await command("shutdown");
			expect(await exited).toEqual({ code: 0, signal: null });
		},
		async kill() {
			expect(child.kill("SIGKILL")).toBe(true);
			expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
		},
	};
}

function eventRunId(frame: EventFrame): string {
	expect(frame.event.runId).toEqual(expect.any(String));
	return frame.event.runId ?? "";
}

function expectSequence(events: RuntimeEvent[], first = 1): void {
	expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => first + index));
}

async function complete(adapter: Adapter, sessionId: string, input: string): Promise<RequestRecord> {
	const { requestId } = await adapter.client.submit(sessionId, input);
	const terminal = await adapter.trace.event(sessionId, "terminal", requestId);
	expect(terminal.event).toMatchObject({ type: "terminal", status: "succeeded" });
	const request = (await adapter.client.getSession(sessionId)).requests.find((entry) => entry.requestId === requestId);
	if (!request) throw new Error("缺少已提交的运行记录");
	return request;
}

describe("共享 pi 核心的双宿主验证", () => {
	it("两个真实宿主使用同一产物、相同只读输入和 pi 工具循环", async () => {
		const text = "const sample = '共同结果';\nconst line = 2;\nconst tail = 3;";
		await Promise.all([
			writeFile(join(directory, "service/src/a.ts"), text),
			writeFile(join(directory, "employee/src/a.ts"), text),
		]);
		const [nodeHost, childHost] = await Promise.all([enterprise(), desktop()]);
		const { pid: nodePid, ...nodeBuild } = nodeHost.identity;
		const { kind: _kind, pid: childPid, ...childBuild } = childHost.identity as Identity & { kind: "ready" };
		expect(nodePid).toBe(process.pid);
		expect(childPid).not.toBe(process.pid);
		expect(childBuild).toEqual(nodeBuild);
		expect(nodeBuild).toMatchObject({ packageVersion: "0.1.0", piAgentVersion: "1.6.0", piAiVersion: "1.6.0" });
		expect(nodeBuild.entry).toMatch(/packages\/agent-runtime\/dist\/index\.js$/);
		expect(nodeBuild.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		console.info("双宿主构建信息", { ...nodeBuild, enterprisePid: nodePid, desktopPid: childPid });

		const [left, right] = await Promise.all([
			complete(nodeHost, "review", "读取 src/a.ts"),
			complete(childHost, "review", "读取 src/a.ts"),
		]);
		expect(left.text).toBe(right.text);
		expect(left.text).toContain("共同结果");
		expect(left.text).toContain("行窗: 1-2");
		expect(left.text).not.toContain("const tail");
		for (const [host, result] of [
			[nodeHost, left],
			[childHost, right],
		] as const) {
			const stats = await host.stats();
			expect(stats.modelCalls).toHaveLength(2);
			expect(stats.toolCalls).toHaveLength(1);
			expect(stats.toolCalls[0]).toMatchObject({ toolName: "gitlab_get_file_content", sessionId: "review" });
			expect(JSON.stringify(stats.modelCalls[1]?.messages)).toContain("toolResult");
			expect(JSON.stringify(stats.modelCalls[1]?.messages)).toContain("共同结果");
			const events = host.trace.events("review");
			expect(events.map(({ type }) => type)).toEqual([
				"queued",
				"started",
				"tool_started",
				"tool_result",
				"text_delta",
				"text_delta",
				"terminal",
			]);
			expectSequence(events);
			expect(events[3]).toMatchObject({ isError: false, text: [expect.stringContaining("共同结果")] });
			expect(
				events.slice(1).every(({ runId, requestId }) => runId === result.runId && requestId === result.requestId),
			).toBe(true);
		}
		await expect(childHost.command("query", { sessionId: "review" }, protocolVersion + 1)).rejects.toMatchObject({
			code: "invalid-input",
		});
		await expect(childHost.command("query", { sessionId: "review", subject: service })).rejects.toMatchObject({
			code: "invalid-input",
		});
		await childHost.close();
	});

	for (const [name, createHost] of [
		["企业 Node", enterprise],
		["桌面 IPC", desktop],
	] as const) {
		it.each(["normal", "cancel-a", "cancel-b", "cancel-c"] as const)(`${name} 的三请求顺序 %s`, async (scenario) => {
			const host = await createHost();
			const session = "queue";
			await host.holdRead(session);
			const a = await host.client.submit(session, "请求 A");
			const started = await host.trace.event(session, "started", a.requestId);
			await host.trace.probe(session, "read_chunk");
			const b = await host.client.submit(session, "请求 B");
			const c = await host.client.submit(session, "请求 C");
			expect((await host.trace.event(session, "queued", b.requestId)).event).toMatchObject({ position: 1 });
			expect((await host.trace.event(session, "queued", c.requestId)).event).toMatchObject({ position: 2 });
			expect(await host.client.cancelQueued(session, a.requestId)).toMatchObject({
				status: "running",
				runId: started.event.runId,
			});

			if (scenario === "cancel-a") {
				expect(await host.client.cancelRunning(session, eventRunId(started))).toMatchObject({ status: "cancelling" });
				const closing = await host.trace.event(session, "cancelling", a.requestId);
				const closed = await host.trace.probe(session, "read_closed");
				const finalA = await host.trace.event(session, "terminal", a.requestId);
				expect(finalA.event).toMatchObject({ status: "cancelled" });
				expect(host.trace.rows.indexOf(closing)).toBeLessThan(host.trace.rows.indexOf(closed));
				expect(host.trace.rows.indexOf(closed)).toBeLessThan(host.trace.rows.indexOf(finalA));
			} else {
				if (scenario === "cancel-b") {
					expect(await host.client.cancelQueued(session, b.requestId)).toMatchObject({ status: "cancelled" });
					expect(
						host.trace
							.events(session)
							.filter(({ requestId, type }) => requestId === c.requestId && type === "queued")
							.at(-1),
					).toMatchObject({ position: 1 });
				} else if (scenario === "cancel-c") {
					expect(await host.client.cancelQueued(session, c.requestId)).toMatchObject({ status: "cancelled" });
					const positions = host.trace
						.events(session)
						.filter(({ requestId, type }) => requestId === b.requestId && type === "queued");
					expect(positions).toEqual([expect.objectContaining({ position: 1 })]);
				}
				await host.releaseRead(session);
			}
			await Promise.all([a, b, c].map(({ requestId }) => host.trace.event(session, "terminal", requestId)));
			const events = host.trace.events(session);
			const startedIds = events.filter(({ type }) => type === "started").map(({ requestId }) => requestId);
			const expected = scenario === "cancel-b" ? [a, c] : scenario === "cancel-c" ? [a, b] : [a, b, c];
			expect(startedIds).toEqual(expected.map(({ requestId }) => requestId));
			for (let index = 1; index < expected.length; index++) {
				const previous = expected[index - 1];
				const next = expected[index];
				expect(
					events.findIndex((event) => event.requestId === previous?.requestId && event.type === "terminal"),
				).toBeLessThan(events.findIndex((event) => event.requestId === next?.requestId && event.type === "started"));
			}
			expectSequence(events);
			const state = await host.client.getSession(session);
			const cancelled = { "cancel-a": a.requestId, "cancel-b": b.requestId, "cancel-c": c.requestId, normal: undefined }[
				scenario
			];
			for (const entry of state.requests) {
				expect(entry.status).toBe(entry.requestId === cancelled ? "cancelled" : "succeeded");
				expect(events.filter(({ requestId, type }) => requestId === entry.requestId && type === "terminal")).toHaveLength(
					1,
				);
			}
			expect(state.requests.map(({ input }) => input)).toEqual(["请求 A", "请求 B", "请求 C"]);
			if (scenario === "cancel-a") expect(state.requests[0]?.text).toBe(partialReadText);
			if (cancelled) expect(JSON.stringify(state.messages)).not.toContain(`请求 ${scenario.at(-1)?.toUpperCase()}`);
			if ("close" in host) await host.close();
		});
	}

	it("启动前重新授权，有效的下一条请求可以继续", async () => {
		const host = await enterprise();
		await host.holdRead("revoked");
		const a = await host.client.submit("revoked", "首条");
		await host.trace.probe("revoked", "read_chunk");
		const b = await host.client.submit("revoked", "待复核");
		host.fixture.setAllowed(service, "revoked", false);
		await host.releaseRead("revoked");
		expect((await host.trace.event("revoked", "terminal", b.requestId)).event).toMatchObject({
			status: "denied",
			failure: { code: "denied" },
		});
		expect((await host.trace.event("revoked", "terminal", a.requestId)).event).toMatchObject({ status: "succeeded" });
		expect(host.stats().toolCalls).toHaveLength(1);
		await expect(host.client.getSession("revoked")).rejects.toMatchObject({ code: "denied" });
		host.fixture.setAllowed(service, "revoked", true);
		expect((await complete(host, "revoked", "重新授权")).status).toBe("succeeded");
	});

	it("工作区改授阻止查询、取消和提交，队首仍复核，冷启动沿用原绑定", async () => {
		const session = "workspace-binding";
		const scope = { host: "enterprise-node", subject: service, sessionId: session };
		const store = createFileStore(join(directory, "sessions"));
		const original = await enterprise();
		const previous = await complete(original, session, "原工作区历史");
		await original.holdRead(session);
		const active = await original.client.submit(session, "原工作区当前请求");
		const runId = eventRunId(await original.trace.event(session, "started", active.requestId));
		await original.trace.probe(session, "read_chunk");
		const queued = await original.client.submit(session, "原工作区等待请求");
		try {
			const before = await store.load(scope);
			expect(before).toMatchObject({ workspaceId: "service" });
			expect(before?.requests.map(({ status }: RequestRecord) => status)).toEqual(["succeeded", "running", "queued"]);
			const calls = original.stats();
			original.fixture.setWorkspace(service, session, "employee");
			await expect(original.client.getSession(session)).rejects.toMatchObject({ code: "denied" });
			await expect(original.client.cancelRunning(session, runId)).rejects.toMatchObject({ code: "denied" });
			await expect(original.client.cancelQueued(session, queued.requestId)).rejects.toMatchObject({ code: "denied" });
			await expect(original.client.submit(session, "尝试从新工作区续问")).rejects.toMatchObject({ code: "denied" });
			expect(await store.load(scope)).toEqual(before);
			expect(original.stats()).toEqual(calls);
		} finally {
			await original.releaseRead(session);
		}
		expect((await original.trace.event(session, "terminal", queued.requestId)).event).toMatchObject({ status: "denied" });
		expect(
			original.trace.events(session).some(({ type, requestId }) => type === "started" && requestId === queued.requestId),
		).toBe(false);
		const saved = await store.load(scope);
		expect(saved?.requests.map(({ status }: RequestRecord) => status)).toEqual(["succeeded", "succeeded", "denied"]);
		expect(original.stats().modelCalls).toHaveLength(4);
		expect(original.stats().toolCalls).toHaveLength(2);

		const restarted = await enterprise();
		restarted.fixture.setWorkspace(service, session, "employee");
		await expect(restarted.client.getSession(session)).rejects.toMatchObject({ code: "denied" });
		await expect(restarted.client.cancelRunning(session, runId)).rejects.toMatchObject({ code: "denied" });
		await expect(restarted.client.cancelQueued(session, queued.requestId)).rejects.toMatchObject({ code: "denied" });
		await expect(restarted.client.submit(session, "重启后尝试从新工作区续问")).rejects.toMatchObject({ code: "denied" });
		expect(restarted.stats()).toEqual({ modelCalls: [], toolCalls: [], externalWrites: 0 });
		expect(await store.load(scope)).toEqual(saved);

		const newSession = "new-workspace";
		await restarted.client.getSession(newSession);
		restarted.fixture.setWorkspace(service, newSession, "employee");
		const newRequest = await complete(restarted, newSession, "新工作区新会话");
		expect(newRequest).toMatchObject({ workspaceId: "employee", text: expect.stringContaining("EMPLOYEE-ONLY") });
		expect(JSON.stringify(restarted.stats().modelCalls)).not.toContain("原工作区历史");
		restarted.fixture.setWorkspace(service, session, "service");
		expect(await restarted.client.getSession(session)).toEqual(saved);
		expect(saved?.requests[0]).toEqual(previous);
	});

	it("早期快照仅在所有请求归属一致且当前授权匹配时补写会话绑定", async () => {
		const session = "prior-binding";
		const scope = { host: "enterprise-node", subject: service, sessionId: session };
		const store = createFileStore(join(directory, "sessions"));
		const original = await enterprise();
		const previous = await complete(original, session, "早期的原工作区历史");
		const { workspaceId, ...legacy } = await original.client.getSession(session);
		await store.save(scope, legacy);
		const restarted = await enterprise();
		restarted.fixture.setWorkspace(service, session, "employee");
		await expect(restarted.client.getSession(session)).rejects.toMatchObject({ code: "denied" });
		expect(await store.load(scope)).toEqual(legacy);
		restarted.fixture.setWorkspace(service, session, "service");
		expect(await restarted.client.getSession(session)).toEqual({ ...legacy, workspaceId });
		expect(await store.load(scope)).toEqual({ ...legacy, workspaceId });

		const mixed = {
			...legacy,
			requests: [...legacy.requests, { ...previous, requestId: randomUUID(), workspaceId: "employee" }],
		};
		await store.save(scope, mixed);
		const mixedHost = await enterprise();
		await expect(mixedHost.client.getSession(session)).rejects.toMatchObject({ code: "storage" });
		mixedHost.fixture.setWorkspace(service, session, "employee");
		await expect(mixedHost.client.submit(session, "尝试继续混合历史")).rejects.toMatchObject({ code: "storage" });
		expect(mixedHost.stats()).toEqual({ modelCalls: [], toolCalls: [], externalWrites: 0 });
		expect(await store.load(scope)).toEqual(mixed);
	});

	it("模型等待期间收到取消信号，下一条仍可运行", async () => {
		const host = await enterprise();
		host.fixture.holdModel(service, "model");
		const a = await host.client.submit("model", "中止的模型请求");
		const started = await host.trace.event("model", "started", a.requestId);
		await host.trace.probe("model", "model_waiting");
		const b = await host.client.submit("model", "正常模型请求");
		await host.client.cancelRunning("model", eventRunId(started));
		const aborted = await host.trace.probe("model", "model_aborted");
		const terminal = await host.trace.event("model", "terminal", a.requestId);
		const next = await host.trace.event("model", "started", b.requestId);
		expect(terminal.event).toMatchObject({ status: "cancelled" });
		expect(host.trace.rows.indexOf(aborted)).toBeLessThan(host.trace.rows.indexOf(terminal));
		expect(host.trace.rows.indexOf(terminal)).toBeLessThan(host.trace.rows.indexOf(next));
		await host.trace.event("model", "terminal", b.requestId);
		expect(host.stats().toolCalls).toHaveLength(1);
		expect(JSON.stringify((await host.client.getSession("model")).messages)).not.toContain("中止的模型请求");
	});

	it("企业宿主运行中插话：工具读取期间排入，当前一步结束后送达并随请求记录保存", async () => {
		const host = await enterprise();
		host.holdRead("steer");
		const a = await host.client.submit("steer", "插话请求");
		const started = await host.trace.event("steer", "started", a.requestId);
		await host.trace.probe("steer", "read_chunk");
		await host.client.steer("steer", eventRunId(started), "steer-1", "补充：只看第一行");
		host.releaseRead("steer");
		const steered = await host.trace.event("steer", "steered", a.requestId);
		const terminal = await host.trace.event("steer", "terminal", a.requestId);
		expect(steered.event).toMatchObject({ type: "steered", steerId: "steer-1", runId: eventRunId(started) });
		expect(terminal.event).toMatchObject({ status: "succeeded" });
		const events = host.trace.rows
			.filter((frame): frame is EventFrame => frame.kind === "event" && frame.event.sessionId === "steer")
			.map(({ event }) => event);
		expectSequence(events);
		const [record] = (await host.client.getSession("steer")).requests;
		expect(record?.steers).toEqual([
			expect.objectContaining({ steerId: "steer-1", input: "补充：只看第一行", textOffset: expect.any(Number) }),
		]);
		expect(JSON.stringify(host.stats().modelCalls.at(-1)?.messages)).toContain("补充：只看第一行");
		await expect(host.client.steer("steer", eventRunId(started), "steer-2", "已结束")).rejects.toMatchObject({
			code: "invalid-input",
		});
	});

	it("真实 Agent 的 agent_end 监听器释放前，队首不会开始", async () => {
		const original = NativeAgent.prototype.subscribe;
		const seen = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let blocked = false;
		vi.spyOn(NativeAgent.prototype, "subscribe").mockImplementation(function (this: Agent, listener) {
			return original.call(this, async (event, signal) => {
				await listener(event, signal);
				if (event.type === "agent_end" && !blocked) {
					blocked = true;
					seen.resolve();
					await release.promise;
				}
			});
		});
		const host = await enterprise();
		const a = await host.client.submit("idle", "首条");
		try {
			await seen.promise;
			const b = await host.client.submit("idle", "次条");
			expect((await host.client.getSession("idle")).requests.map(({ status }) => status)).toEqual(["running", "queued"]);
			expect(host.trace.events("idle").filter(({ type }) => type === "started")).toHaveLength(1);
			release.resolve();
			await host.trace.event("idle", "terminal", b.requestId);
			const events = host.trace.events("idle");
			expect(events.findIndex(({ type, requestId }) => type === "terminal" && requestId === a.requestId)).toBeLessThan(
				events.findIndex(({ type, requestId }) => type === "started" && requestId === b.requestId),
			);
		} finally {
			release.resolve();
		}
	});

	it("同一进程中相同会话 ID 的主体具有各自的事件、缓存键、工具和文件范围", async () => {
		const host = await enterprise();
		const other = host.fixture.client(employee) as SubjectRuntime;
		const session = "shared";
		await host.holdRead(session);
		host.fixture.holdRead(employee, session);
		const [a, b] = await Promise.all([host.client.submit(session, "服务输入"), other.submit(session, "员工输入")]);
		await Promise.all([
			host.trace.probe(session, "read_chunk", service.id),
			host.trace.probe(session, "read_chunk", employee.id),
		]);
		const serviceStarted = await host.trace.event(session, "started", a.requestId, service.id);
		const employeeStarted = await host.trace.event(session, "started", b.requestId, employee.id);
		await expect(other.cancelRunning(session, eventRunId(serviceStarted))).rejects.toMatchObject({ code: "not-found" });
		await expect(host.client.cancelRunning(session, eventRunId(employeeStarted))).rejects.toMatchObject({
			code: "not-found",
		});
		await expect(other.cancelQueued(session, a.requestId)).rejects.toMatchObject({ code: "not-found" });
		await complete(host, "service-only-private", "已有服务私有历史");
		await expect(other.getSession("service-only-private")).rejects.toMatchObject({ code: "denied" });
		host.releaseRead(session);
		host.fixture.releaseRead(employee, session);
		await Promise.all([
			host.trace.event(session, "terminal", a.requestId, service.id),
			host.trace.event(session, "terminal", b.requestId, employee.id),
		]);
		const [left, right] = await Promise.all([host.client.getSession(session), other.getSession(session)]);
		expect(JSON.stringify(left)).toContain("SERVICE-ONLY");
		expect(JSON.stringify(left)).not.toContain("EMPLOYEE-ONLY");
		expect(JSON.stringify(right)).toContain("EMPLOYEE-ONLY");
		expect(JSON.stringify(right)).not.toContain("SERVICE-ONLY");
		expect(host.trace.events(session, service.id).every(({ requestId }) => requestId === a.requestId)).toBe(true);
		expect(host.trace.events(session, employee.id).every(({ requestId }) => requestId === b.requestId)).toBe(true);
		expectSequence(host.trace.events(session, service.id));
		expectSequence(host.trace.events(session, employee.id));
		const stats = host.stats();
		const serviceCalls = stats.modelCalls.filter(({ subject }) => subject === service.id);
		const employeeCalls = stats.modelCalls.filter(({ subject }) => subject === employee.id);
		expect(serviceCalls[0]?.providerSessionId).toMatch(/^[a-f0-9]{64}$/);
		expect(serviceCalls[0]?.providerSessionId).not.toBe(employeeCalls[0]?.providerSessionId);
		expect(serviceCalls[0]?.tools).toEqual(["gitlab_get_file_content", "service_read_preview"]);
		expect(employeeCalls[0]?.tools).toEqual(["gitlab_get_file_content", "employee_read_preview"]);
		expect(JSON.stringify(serviceCalls)).not.toContain("EMPLOYEE-ONLY");
		expect(JSON.stringify(employeeCalls)).not.toContain("SERVICE-ONLY");
		expect(JSON.stringify({ stats, events: host.trace.rows, left, right })).not.toContain("private-model-fixture-");

		const outside = await complete(host, "link-outside", "路径:src/outside.ts");
		expect(outside.toolResults[0]).toMatchObject({ isError: true });
		expect(outside.text).toContain("文件不在获准工作区");
		expect(outside.text).not.toContain("EMPLOYEE-ONLY");
		const unavailable = await other.submit("tool-scope", "工具:service_read_preview");
		await host.trace.event("tool-scope", "terminal", unavailable.requestId, employee.id);
		expect((await other.getSession("tool-scope")).requests[0]?.toolResults[0]?.isError).toBe(true);
		expect(host.stats().toolCalls.some(({ toolName }) => toolName === "service_read_preview")).toBe(false);
	});

	it("企业入口重建后读取自己的完整历史，恢复阶段没有执行", async () => {
		const original = await enterprise();
		const prior = await complete(original, "history", "旧的完整输入");
		const restored = await enterprise();
		expect(restored.stats()).toEqual({ modelCalls: [], toolCalls: [], externalWrites: 0 });
		const snapshot = await restored.client.getSession("history");
		expect(snapshot.requests[0]).toEqual(prior);
		expect(JSON.stringify(snapshot.messages)).toContain("旧的完整输入");
		expect(restored.stats()).toEqual({ modelCalls: [], toolCalls: [], externalWrites: 0 });
		await complete(restored, "history", "显式续问");
		expect(JSON.stringify(restored.stats().modelCalls[0]?.messages)).toContain("旧的完整输入");
		expectSequence(restored.trace.events("history"), snapshot.lastSequence + 1);
	});

	it("持久化失败可重试，入队确认和终态在提交完成后发出", async () => {
		const fileStore = createFileStore(join(directory, "sessions"));
		const saveStarted = Promise.withResolvers<void>();
		const releaseSave = Promise.withResolvers<void>();
		const scope = { host: "enterprise-node", subject: service, sessionId: "durable" };
		let failSave = true;
		const host = await enterprise({
			load: fileStore.load,
			async save(scope, snapshot) {
				if (failSave) {
					failSave = false;
					throw new Error("测试提交失败");
				}
				if (snapshot.requests.some((request) => request.status === "succeeded")) {
					saveStarted.resolve();
					await releaseSave.promise;
				}
				await fileStore.save(scope, snapshot);
			},
		});
		await expect(host.client.submit("durable", "未提交的输入")).rejects.toMatchObject({ code: "storage" });
		expect(host.trace.events("durable")).toEqual([]);
		expect(host.stats().modelCalls).toEqual([]);
		expect(await fileStore.load(scope)).toBeUndefined();
		const request = await host.client.submit("durable", "可重试输入");
		try {
			await saveStarted.promise;
			expect(host.trace.events("durable").some(({ type }) => type === "terminal")).toBe(false);
			expect((await fileStore.load(scope))?.requests.map((entry: RequestRecord) => entry.status)).toEqual(["running"]);
		} finally {
			releaseSave.resolve();
		}
		expect((await host.trace.event("durable", "terminal", request.requestId)).event).toMatchObject({
			status: "succeeded",
		});
		expect((await fileStore.load(scope))?.requests.map((entry: RequestRecord) => entry.status)).toEqual(["succeeded"]);
		expectSequence(host.trace.events("durable"));
	});

	it("SDK 装配失败后可以继续，初始化期间取消等待释放后才执行下一项", async () => {
		const trace = new Trace();
		const booting = Promise.withResolvers<void>();
		const finishBoot = Promise.withResolvers<void>();
		const disposing = Promise.withResolvers<void>();
		const finishDispose = Promise.withResolvers<void>();
		const prompted: string[] = [];
		const received: string[][] = [];
		let bootCount = 0;
		let snapshot: SessionSnapshot | undefined;
		const runtime = createAgentRuntime({
			host: "sdk-fixture",
			store: {
				load: async () => snapshot,
				save: async (_scope, next) => {
					snapshot = next;
				},
			},
			authorize: () => ({
				workspaceId: "sdk-fixture",
				async createExecution({ signal, attachments }) {
					received.push((attachments ?? []).map((entry) => entry.id));
					const boot = ++bootCount;
					if (boot === 1) throw new Error("装配失败");
					if (boot === 2) {
						booting.resolve();
						await finishBoot.promise;
						expect(signal.aborted).toBe(true);
					}
					return {
						prompt: async (input) => {
							prompted.push(input);
						},
						subscribe: () => () => {},
						abort: () => {},
						waitForIdle: async () => {},
						getMessages: () => [],
						dispose: async () => {
							if (boot === 2) {
								disposing.resolve();
								await finishDispose.promise;
							}
						},
					};
				},
			}),
		});
		const client = runtime.bindSubject(service, (event) => trace.push({ kind: "event", event }));
		const session = "sdk";
		const invalid = await client.submit(session, "装配失败");
		expect((await trace.event(session, "terminal", invalid.requestId)).event).toMatchObject({ status: "failed" });
		const active = await client.submit(session, "初始化阶段取消");
		const refs = [
			{ id: "document-a", name: "资料 A" },
			{ id: "document-b", name: "资料 B" },
		];
		const waiting = await client.submit(session, "下一条", refs);
		refs[0].id = "下一份草稿";
		try {
			await booting.promise;
			const started = await trace.event(session, "started", active.requestId);
			await client.cancelRunning(session, eventRunId(started));
			finishBoot.resolve();
			await disposing.promise;
			expect((await client.getSession(session)).requests.map(({ status }) => status)).toEqual([
				"failed",
				"cancelling",
				"queued",
			]);
			expect(prompted).toEqual([]);
		} finally {
			finishBoot.resolve();
			finishDispose.resolve();
		}
		expect((await trace.event(session, "terminal", active.requestId)).event).toMatchObject({ status: "cancelled" });
		expect((await trace.event(session, "terminal", waiting.requestId)).event).toMatchObject({ status: "succeeded" });
		expect(prompted).toEqual(["下一条"]);
		expect(received).toEqual([[], [], ["document-a", "document-b"]]);
		expect((await client.getSession(session)).requests.at(-1)?.attachments).toEqual(waiting.attachments);
		expect(trace.events(session).filter(({ type }) => type === "terminal")).toHaveLength(3);
	});

	it("子进程断开后恢复已提交历史和中断状态，不触发重放", async () => {
		const session = "restart";
		const first = await desktop(true);
		const confirmed = await complete(first, session, `工具:${operationProbeName}`);
		expect((await first.stats()).externalWrites).toBe(1);
		const previous = await complete(first, session, "已完成的旧输入");
		await first.close();

		const store = createFileStore(join(directory, "sessions"));
		const scope = { host: "desktop-node", subject: employee, sessionId: session };
		const snapshot = (await store.load(scope)) as SessionSnapshot;
		snapshot.artifacts.push("src/a.ts");
		snapshot.operations.push(
			{ id: "confirmed", status: "confirmed", result: "已确认" },
			{ id: "unknown", status: "needs-verification" },
		);
		await store.save(scope, snapshot);

		const interrupted = await desktop(true);
		expect((await interrupted.client.getSession(session)).requests).toEqual([confirmed, previous]);
		await interrupted.holdRead(session);
		const active = await interrupted.client.submit(session, "断开时正在运行");
		await interrupted.trace.probe(session, "read_chunk");
		const waiting = await interrupted.client.submit(session, "断开时正在等待");
		const before = await interrupted.client.getSession(session);
		expect(before.requests.map(({ status }) => status)).toEqual(["succeeded", "succeeded", "running", "queued"]);
		await interrupted.kill();

		const restarted = await desktop(true);
		expect(restarted.identity.pid).not.toBe(interrupted.identity.pid);
		expect(restarted.identity.fingerprint).toBe(first.identity.fingerprint);
		const recovered = await restarted.client.getSession(session);
		expect(recovered.requests.map(({ requestId, status }) => [requestId, status])).toEqual([
			[confirmed.requestId, "succeeded"],
			[previous.requestId, "succeeded"],
			[active.requestId, "interrupted"],
			[waiting.requestId, "interrupted"],
		]);
		expect(recovered.requests.slice(0, 2)).toEqual([confirmed, previous]);
		expect(recovered.requests[2]?.text).toBe(partialReadText);
		expect(recovered.operations).toEqual(snapshot.operations);
		expect(recovered.artifacts).toEqual(["src/a.ts"]);
		expect(recovered.messages).toEqual(snapshot.messages);
		expect(await restarted.stats()).toEqual({ modelCalls: [], toolCalls: [], externalWrites: 0 });
		expect(restarted.trace.events(session)).toEqual([]);
		expect(await store.load({ ...scope, subject: service })).toBeUndefined();

		await complete(restarted, session, "重启后的显式请求");
		const stats = await restarted.stats();
		expect(stats.toolCalls).toHaveLength(1);
		expect(stats.externalWrites).toBe(0);
		expect(JSON.stringify(stats.modelCalls[0]?.messages)).toContain("已完成的旧输入");
		expect(JSON.stringify(stats.modelCalls[0]?.messages)).toContain("测试替身已计数");
		expect(JSON.stringify(stats.modelCalls[0]?.messages)).not.toContain("断开时");
		expectSequence(restarted.trace.events(session), before.lastSequence + 1);
		await restarted.close();
	});
});
