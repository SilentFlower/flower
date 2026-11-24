import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { createProxyFixture, proxyScenarios } from "./local-proxy.mjs";

const [scenario = "normal"] = process.argv.slice(2);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const runRoot = await mkdtemp(join(tmpdir(), `flower-review-${scenario}-`));
const mode = process.env.FLOWER_VERIFY_MODE ?? "candidate";
const image = process.env.FLOWER_VERIFY_IMAGE;
const priorSession = process.env.FLOWER_VERIFY_PRIOR_SESSION;
const launcher = process.env.FLOWER_VERIFY_COMMAND
	? JSON.parse(process.env.FLOWER_VERIFY_COMMAND)
	: [process.execPath, join(repo, "apps/code-reviewer/dist/cli.js")];
const preflight = new Set([
	"normal",
	"blocker",
	"unsupported",
	"default",
	"gateway-401",
	"gateway-503",
	"gateway-timeout",
	"timeout-model",
	"timeout-write",
	"timeout-line-fallback",
	"dry-run",
	"iid",
	"iid-argument",
	"gitlab-auth",
	"invalid-cli",
	"missing-config",
	"trust-ask",
	"trust-default",
	"trust-memory",
	"trust-deny-default",
	"trust-deny-memory",
	"trust-remember-denial",
	...proxyScenarios,
]);
assert(preflight.has(scenario), "未知验收用例");
const hostAgent = join(runRoot, "agent");
const cwd = join(runRoot, "project");
await mkdir(join(hostAgent, "extensions"), { recursive: true });
await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
spawnSync("git", ["init", "-q", cwd], { stdio: "ignore" });
const sentinel = (name) => `export default function(pi) { console.log("FLOWER-DISCOVERY-${name}"); }`;
await writeFile(join(hostAgent, "extensions/probe.ts"), sentinel("USER"));
await writeFile(join(cwd, ".pi/extensions/probe.ts"), sentinel("PROJECT"));
if (scenario.startsWith("trust-")) {
	const allowDefault = scenario === "trust-default" || scenario === "trust-deny-default";
	await writeFile(
		join(hostAgent, "settings.json"),
		JSON.stringify({ defaultProjectTrust: allowDefault ? "always" : "ask" }),
	);
	await writeFile(
		join(cwd, ".pi/extensions/probe.ts"),
		`export default function(pi) {
    console.log("FLOWER-DISCOVERY-PROJECT");
    pi.on("project_trust", () => { console.log("FLOWER-TRUST-PROJECT-HANDLER"); return {trusted:"yes"}; });
  }`,
	);
	if (["trust-memory", "trust-deny-memory", "trust-remember-denial"].includes(scenario)) {
		new ProjectTrustStore(hostAgent).set(cwd, true);
	}
	if (scenario.includes("deny") || scenario === "trust-remember-denial") {
		await writeFile(
			join(hostAgent, "extensions/probe.ts"),
			`export default function(pi) {
      console.log("FLOWER-DISCOVERY-USER");
      ${scenario === "trust-deny-default" ? 'pi.on("project_trust", () => { throw Error("FLOWER-TRUST-EXPECTED-ERROR"); });' : ""}
      pi.on("project_trust", () => { console.log("FLOWER-TRUST-UNDECIDED"); return {trusted:"undecided"}; });
      pi.on("project_trust", async (_event, ctx) => {
        if (ctx.mode !== "print" || ctx.hasUI || await ctx.ui.confirm("测试", "测试")) throw Error("上下文行为错误");
        console.log("FLOWER-TRUST-DENY");
        return {trusted:"no", remember:${scenario === "trust-remember-denial"}};
      });
      pi.on("project_trust", () => { console.log("FLOWER-TRUST-LATE-YES"); return {trusted:"yes"}; });
    }`,
		);
	}
}
if (priorSession) {
	assert.equal(scenario, "normal", "历史会话对照使用 normal 用例");
	const sessionDir = join(hostAgent, "sessions");
	await mkdir(sessionDir, { recursive: true });
	const copied = join(sessionDir, "prior.jsonl");
	await copyFile(priorSession, copied);
	const previous = SessionManager.open(copied);
	assert(previous.buildSessionContext().messages.some(({ role }) => role === "toolResult"));
	await writeFile(join(hostAgent, "settings.json"), JSON.stringify({ sessionDir }));
}
const files = "src/index.ts";
const calls = [];
const posts = [];
const notes = [{ id: 999, body: "<!-- severity: blocker --> 旧评论", author: { username: "flower_fixture" } }];
const interrupted = [];
let mockError;
let modelIndex = 0;
const commands = [
	[
		...(scenario === "unsupported"
			? []
			: [["call_read", "gitlab_get_file_content", { path: files, ref: "branch", startLine: "1", endLine: 3 }]]),
		["call_deny", "bash", { command: "touch local-deny-marker" }],
	],
	[
		["call_note", "gitlab_post_comment", { body: "整体示例\n/approve\n/path/file.ts", severity: "minor" }],
		[
			"call_line",
			"gitlab_post_line_comment",
			{ file: files, line: "2", body: "行内示例\n/close", severity: scenario === "blocker" ? "blocker" : "major" },
		],
	],
	[["call_self", "reviewer_list_my_blockers", {}]],
];
const stallsComment = scenario === "timeout-write" || scenario === "timeout-line-fallback";
if (scenario === "timeout-write") commands.splice(1, 1, [commands[1][0]], [commands[1][1]]);
if (scenario === "timeout-line-fallback") {
	const [id, name, args] = commands[1][1];
	commands[1] = [[id, name, { ...args, line: "100" }]];
}
let proxyFixture;
const server = createServer(async (req, res) => {
	const path = new URL(req.url, "http://127.0.0.1").pathname;
	const json = (body, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	};
	try {
		proxyFixture?.capture(req);
		if (proxyFixture?.serveIdleProbe(path, res)) return;
		if (path.startsWith("/v1/")) {
			let raw = "";
			for await (const data of req) raw += data;
			const body = JSON.parse(raw);
			calls.push({ path, body });
			assert.equal(req.headers.authorization, "Bearer local-key");
			assert.equal(req.headers["x-app-source"], "code-reviewer");
			if (scenario === "gateway-401") return json({ error: { message: "fixture authentication failed" } }, 401);
			if (scenario === "gateway-503") return json({ error: { message: "fixture gateway unavailable" } }, 503);
			if (scenario === "gateway-timeout" || scenario === "timeout-model") {
				res.once("close", () => interrupted.push("model"));
				return;
			}
			if (scenario === "default") {
				assert.equal(path, "/v1/responses");
				assert.equal(body.model, "gpt-6.1-sol");
				const content = { type: "output_text", text: "模型评审完成", annotations: [], logprobs: [] };
				const item = { id: "msg_local", type: "message", status: "completed", role: "assistant", content: [content] };
				const response = {
					id: "resp_local",
					status: "completed",
					model: body.model,
					output: [item],
					usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
				};
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				const e = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
				e("response.created", { response: { ...response, status: "in_progress", output: [] } });
				e("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
				e("response.content_part.added", {
					item_id: item.id,
					output_index: 0,
					content_index: 0,
					part: { ...content, text: "" },
				});
				e("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: content.text });
				e("response.output_item.done", { output_index: 0, item });
				e("response.completed", { response });
				return res.end();
			}
			assert.equal(path, "/v1/chat/completions");
			assert.equal(body.model, "flower-review-fixture");
			assert.equal(body.stream, true);
			const chunk = commands[modelIndex++];
			const toolChunk = chunk?.map(([id, name, args], index) => ({
				index,
				id,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
			}));
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const send = (delta, finish_reason = null) =>
				res.write(
					"data: " +
						JSON.stringify({
							id: `fixture-${modelIndex}`,
							created: 1,
							model: body.model,
							object: "chat.completion.chunk",
							choices: [{ index: 0, delta, finish_reason }],
						}) +
						"\n\n",
				);
			send(toolChunk ? { role: "assistant", tool_calls: toolChunk } : { role: "assistant", content: "模型评审完成" });
			send({}, toolChunk ? "tool_calls" : "stop");
			return res.end("data: [DONE]\n\n");
		}
		assert.equal(req.headers["private-token"], "local-gitlab-token");
		if (scenario === "gitlab-auth") return json({ message: "unauthorized" }, 401);
		if (req.method === "GET" && path === "/api/v4/version") return json({ version: "18.10.0" });
		if (req.method === "GET" && path === "/api/v4/user") return json({ username: "flower_fixture" });
		const prefix = "/api/v4/projects/123";
		assert.ok(path.startsWith(prefix), path);
		if (path.includes("/merge_requests/")) assert.ok(path.includes("/merge_requests/42/"), path);
		if (req.method === "GET" && path.endsWith("/changes")) {
			return json({
				diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" },
				changes: [
					{
						new_path: files,
						old_path: files,
						new_file: false,
						deleted_file: false,
						diff: "@@ -1,2 +1,3 @@\n context\n+fixture\n context2\n",
					},
				],
			});
		}
		if (req.method === "GET" && path.endsWith("/raw")) {
			res.writeHead(200, { "Content-Type": "text/plain" });
			return res.end("context\nfixture\ncontext2\n");
		}
		if (req.method === "GET" && path.endsWith("/notes")) return json(notes);
		if (req.method === "POST" && (path.endsWith("/notes") || path.endsWith("/discussions"))) {
			let raw = "";
			for await (const data of req) raw += data;
			const body = JSON.parse(raw);
			posts.push({ path, ...body });
			if (stallsComment && posts.length === 1) {
				res.once("close", () => interrupted.push("comment"));
				return;
			}
			notes.push({ id: posts.length, ...body, author: { username: "flower_fixture" } });
			return json({ id: `fixture-${posts.length}` }, 201);
		}
		throw new Error(`未知 GitLab 路由 ${req.method} ${path}`);
	} catch (error) {
		mockError ??= error;
		if (!res.headersSent) json({ message: error.message }, 500);
		else res.end();
	}
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const observerToken = "local-observer-token";
const observerProbe = createServer();
observerProbe.listen(0, "127.0.0.1");
await once(observerProbe, "listening");
const observerPort = observerProbe.address().port;
await new Promise((resolve, reject) => observerProbe.close((error) => (error ? reject(error) : resolve())));
const observerUrl = `http://127.0.0.1:${observerPort}`;
let observer;

async function startObserver() {
	observer = spawn(process.execPath, [join(repo, "apps/observer/dist/server.js")], {
		env: {
			PATH: process.env.PATH,
			OBSERVER_PORT: String(observerPort),
			OBSERVER_DB_PATH: join(runRoot, "observer.sqlite"),
			OBSERVER_INGEST_TOKEN: observerToken,
		},
		stdio: "ignore",
	});
	for (let index = 0; index < 50; index++) {
		if (
			await fetch(`${observerUrl}/healthz`)
				.then((response) => response.ok)
				.catch(() => false)
		)
			return;
		if (observer.exitCode !== null) break;
		await delay(100);
	}
	throw new Error("Observer 启动失败");
}

async function stopObserver() {
	if (!observer || observer.exitCode !== null || observer.signalCode !== null) return;
	const closed = once(observer, "close");
	observer.kill();
	await closed;
}

await mkdir(join(runRoot, "home"), { recursive: true });
const settings = {
	HOME: join(runRoot, "home"),
	PATH: process.env.PATH,
	PI_CODING_AGENT_DIR: hostAgent,
	PI_OFFLINE: "1",
	PI_TELEMETRY: "0",
	LLM_BASE_URL: url,
	LLM_API_KEY: "local-key",
	LLM_PROVIDER: "havefun-openai",
	LLM_MODEL: "flower-review-fixture",
	LLM_REASONING_EFFORT: "off",
	LLM_EXTRA_MODELS_JSON: JSON.stringify([{ id: "flower-review-fixture", nativeApi: "openai-completions" }]),
	GITLAB_HOST: url,
	GITLAB_TOKEN: "local-gitlab-token",
	CI_PROJECT_ID: "123",
	CI_MERGE_REQUEST_IID: scenario === "iid" ? "43" : "42",
	CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "branch",
	FLOWER_TELEMETRY_URL: `${observerUrl}/v1/events`,
	FLOWER_TELEMETRY_TOKEN: observerToken,
	FLOWER_VERBOSE: "0",
	FLOWER_LLM_PROVIDER_MAX_RETRIES: "0",
	FLOWER_LLM_AGENT_MAX_RETRIES: "0",
	FLOWER_LLM_REQUEST_TIMEOUT_MS: scenario === "gateway-timeout" ? "1000" : "10000",
	FLOWER_REVIEW_TIMEOUT_MS: scenario.startsWith("timeout-") ? "1800" : "15000",
	FLOWER_TELEMETRY_FILE: join(runRoot, "trace.jsonl"),
};
if (scenario === "default") {
	delete settings.LLM_MODEL;
	delete settings.LLM_PROVIDER;
	settings.LLM_REASONING_EFFORT = "high";
}
if (scenario === "missing-config") delete settings.LLM_API_KEY;
if (scenario === "iid-argument") delete settings.CI_MERGE_REQUEST_IID;
const cliArgs = scenario === "invalid-cli" ? ["--mr-iid", "invalid"] : ["--mr-iid", "42", "--skill", "general"];
if (scenario === "dry-run") cliArgs.push("--dry-run");
let output = "";
try {
	await startObserver();
	if (proxyScenarios.includes(scenario)) {
		proxyFixture = await createProxyFixture({ scenario, originUrl: url, observerUrl, runRoot, agentDir: hostAgent });
		Object.assign(settings, proxyFixture.env);
	}
	const runtime = image
		? [
				"docker",
				"run",
				"--rm",
				"--network",
				"host",
				"-v",
				`${runRoot}:${runRoot}`,
				"-w",
				cwd,
				...Object.entries(settings)
					.filter(([key]) => key !== "PATH")
					.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
				...(process.env.FLOWER_VERIFY_IMAGE_PATH ? ["--entrypoint", "flower-review"] : []),
				image,
			]
		: launcher;
	const [program, ...args] = runtime;
	const child = spawn(program, [...args, ...cliArgs], {
		cwd,
		env: image ? process.env : settings,
		stdio: ["ignore", "pipe", "pipe"],
		signal: AbortSignal.timeout(30000),
	});
	for (const pipe of [child.stdout, child.stderr])
		pipe.on("data", (data) => {
			output += data.toString();
		});
	const [code] = await once(child, "close");
	assert.equal(mockError, undefined, mockError?.stack);
	const rejectedAtStartup = scenario === "invalid-cli" || scenario === "proxy-invalid";
	const expectedCode = rejectedAtStartup ? 2 : ["blocker", "unsupported", "missing-config"].includes(scenario) ? 1 : 0;
	assert.equal(code, expectedCode, output);
	const observations = {
		code,
		paths: calls.map(({ path }) => path),
		tools: calls[0]?.body.tools?.map((tool) => tool.function?.name ?? tool.name).sort() ?? [],
		discovered: [...output.matchAll(/FLOWER-DISCOVERY-(USER|PROJECT)/g)].map((match) => match[1]).sort(),
		posts,
		interrupted,
	};
	if (mode === "candidate" && !rejectedAtStartup) {
		assert.equal((output.match(/共享运行已开始 /g) ?? []).length, 1, output);
		assert.equal((output.match(/共享运行结束 /g) ?? []).length, 1, output);
	}
	if (scenario.startsWith("trust-")) {
		const allows = ["trust-default", "trust-memory"].includes(scenario);
		const rejects = scenario.includes("deny") || scenario === "trust-remember-denial";
		assert.deepEqual(observations.discovered, allows ? ["PROJECT", "USER"] : ["USER"], output);
		assert.doesNotMatch(output, /FLOWER-TRUST-LATE-YES|FLOWER-TRUST-PROJECT-HANDLER/, output);
		if (rejects) assert.match(output, /FLOWER-TRUST-UNDECIDED[\s\S]*FLOWER-TRUST-DENY/, output);
		if (scenario === "trust-deny-default") assert.match(output, /FLOWER-TRUST-EXPECTED-ERROR/, output);
		const remembered = new ProjectTrustStore(hostAgent).get(cwd);
		assert.equal(
			remembered,
			scenario === "trust-remember-denial"
				? false
				: ["trust-memory", "trust-deny-memory"].includes(scenario)
					? true
					: null,
		);
		observations.trust = { hookDeny: output.includes("FLOWER-TRUST-DENY"), remembered };
	}
	if (
		["normal", "blocker", "unsupported", "iid", "iid-argument"].includes(scenario) ||
		scenario.startsWith("trust-") ||
		(proxyFixture && !rejectedAtStartup)
	) {
		assert.equal(posts.length, scenario === "unsupported" ? 3 : 2, output);
		assert.equal(posts[0].body, "整体示例\n&#47;approve\n/path/file.ts");
		assert.equal(posts[1].body, `${scenario === "blocker" ? "<!-- severity: blocker -->\n" : ""}行内示例\n&#47;close`);
		assert.deepEqual(posts[1].position, {
			position_type: "text",
			base_sha: "base",
			start_sha: "start",
			head_sha: "head",
			new_path: files,
			new_line: 2,
		});
		if (scenario === "unsupported") assert.match(posts[2].body, /无依据评论/);
		assert.match(JSON.stringify(calls.at(-1).body.messages), /blockers/);
		await assert.rejects(readFile(join(cwd, "local-deny-marker")), { code: "ENOENT" });
		const sessions = (await readdir(hostAgent, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
		assert.equal(sessions.length, priorSession ? 2 : 1);
		const session = sessions.find((file) => !file.endsWith("/prior.jsonl"));
		const sessionContents = await readFile(join(hostAgent, session), "utf8");
		assert.match(sessionContents, /call_line/);
		if (priorSession) assert.doesNotMatch(JSON.stringify(calls[0].body.messages), /call_line|模型评审完成/);
		await writeFile(join(runRoot, "session-path.txt"), join(hostAgent, session));
	}
	if (scenario === "default") {
		assert.deepEqual(observations.paths, ["/v1/responses"]);
		assert.equal(posts.length, 0);
		assert.match(output, /模型评审完成/);
	}
	if (["gateway-401", "gateway-503", "gateway-timeout", "timeout-model"].includes(scenario) || stallsComment) {
		assert.equal(posts.length, stallsComment ? 2 : 1);
		assert.match(posts.at(-1).body, /未能完成自动评审/);
		if (scenario.startsWith("timeout-")) {
			assert.match(posts.at(-1).body, /自动评审超时/);
			assert(interrupted.includes(scenario === "timeout-model" ? "model" : "comment"));
		}
		if (stallsComment) {
			assert.match(output, /写入结果待核对/);
			assert(posts.every(({ path }) => path.endsWith("/notes")));
		}
		if (scenario === "timeout-line-fallback") assert.match(posts[0].body, /原计划行内评论位置不可用/);
	}
	if (rejectedAtStartup || ["dry-run", "gitlab-auth", "missing-config"].includes(scenario)) {
		assert.equal(posts.length, 0);
	}
	if (scenario === "dry-run") assert.match(JSON.stringify(calls.at(-1).body.messages), /试跑模式禁止发表/);
	if (scenario === "gitlab-auth") assert.match(JSON.stringify(calls.at(-1).body.messages), /401|unauthorized/i);
	if (scenario === "missing-config") assert.match(output, /LLM_API_KEY 未配置/);
	if (rejectedAtStartup || scenario === "missing-config") {
		assert.equal(calls.length, 0);
	} else {
		const trace = (await readFile(settings.FLOWER_TELEMETRY_FILE, "utf8")).trim().split("\n").map(JSON.parse);
		const traceId = trace[0].traceId;
		const response = await fetch(`${observerUrl}/api/traces/${traceId}`);
		assert(response.ok);
		const detail = await response.json();
		assert.deepEqual(detail.events, trace);
		assert.equal(detail.trace.mr_iid, "42");
		assert.equal(detail.trace.exit_code, code);
		assert.equal(trace.filter(({ kind }) => kind === "trace_end").length, 1);
		if (scenario === "normal") {
			const attempt = trace.findIndex((event) => event.spanType === "tool_call" && event.tool === "bash");
			const blocked = trace.findIndex(
				(event) => event.outcomeType === "security_block" && event.securityBlock?.tool === "bash",
			);
			assert(attempt >= 0 && blocked > attempt);
			assert(trace.some((event) => event.spanType === "llm_call"));
			assert(trace.some((event) => event.outcomeType === "self_check"));
			await stopObserver();
			await startObserver();
			const restored = await fetch(`${observerUrl}/api/traces/${traceId}`).then((response) => response.json());
			assert.deepEqual(restored.events, trace);
			assert.equal(restored.trace.exit_code, code);
		}
		observations.observer = {
			kinds: trace.map((event) => event.spanType ?? event.outcomeType ?? event.kind),
			eventCount: detail.trace.event_count,
			maxSequence: detail.trace.max_seq,
			status: detail.trace.display_status,
			exitCode: detail.trace.exit_code,
		};
		await writeFile(join(runRoot, "observer.json"), JSON.stringify(detail, null, 2));
	}
	if (proxyFixture) observations.proxy = proxyFixture.verify(output);
	await writeFile(join(runRoot, "observations.json"), JSON.stringify(observations, null, 2));
	console.log(JSON.stringify({ runRoot, ...observations }));
} finally {
	proxyFixture?.close();
	await writeFile(join(runRoot, "cli.log"), output);
	console.error("验收目录", runRoot);
	server.closeAllConnections();
	server.close();
	await stopObserver();
}
