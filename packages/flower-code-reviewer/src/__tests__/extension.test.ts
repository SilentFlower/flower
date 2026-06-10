/**
 * `extension.ts` 与 `reviewer-self-tools.ts` 单元测试
 *
 * 覆盖:
 * - tool_call hook 在 `gitlab_post_line_comment` 事件下提取 severity + body 并 record(AC3.1)
 * - 类型守卫拒绝缺字段输入(AC3.2)
 * - `reviewer_list_my_blockers` 工具 execute 返回 {count, blockers} 真值(AC1.1-AC1.5)
 *
 * 不测 piMain 集成 / provider / compliance 注册细节(那是 pi 框架的事)。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTelemetry } from "@flower-ai/flower-telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extensionFactory from "../extension.js";
import { getTrace, recordLineComment, resetTrace } from "../review-trace.js";
import { reviewerListMyBlockersTool } from "../reviewer-self-tools.js";

/**
 * 简易 mock pi:只支持 `on` + `registerTool` + `registerProvider` + `registerSkill`
 * + `registerHook` 等 noop;捕获 tool_call handler 供测试调用
 *
 * `toolCallHandlers` 按注册顺序收集全部 tool_call handler(注册顺序契约测试用);
 * `getToolCallHandler` 返回最后一个(review-trace 监听,既有用例沿用)。
 */
function createMockPi(): {
	pi: Parameters<typeof extensionFactory>[0];
	getToolCallHandler: () =>
		| ((event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>)
		| undefined;
	toolCallHandlers: Array<(event: Record<string, unknown>) => Promise<unknown>>;
	registeredTools: Array<{ name: string }>;
} {
	const toolCallHandlers: Array<(event: Record<string, unknown>) => Promise<unknown>> = [];
	const registeredTools: Array<{ name: string }> = [];

	// biome-ignore lint/suspicious/noExplicitAny: 测试 mock,绕过 ExtensionAPI 严格签名
	const pi: any = {
		on: (eventName: string, handler: (e: Record<string, unknown>) => Promise<unknown>) => {
			if (eventName === "tool_call") {
				toolCallHandlers.push(handler);
			}
		},
		registerTool: (def: { name: string }) => {
			registeredTools.push(def);
		},
		registerProvider: () => {},
		registerSkill: () => {},
		registerHook: () => {},
	};

	// 为防止 registerHavefunProviders 等检查 env 抛错,先注 env(已存在则保留)
	process.env.LLM_BASE_URL ??= "http://mock";
	process.env.LLM_API_KEY ??= "mock-key";
	process.env.LLM_MODEL ??= "mock-model";

	return {
		pi,
		getToolCallHandler: () => {
			const last = toolCallHandlers[toolCallHandlers.length - 1];
			return last as ReturnType<ReturnType<typeof createMockPi>["getToolCallHandler"]>;
		},
		toolCallHandlers,
		registeredTools,
	};
}

describe("extension · tool_call hook 提取 line_comment 完整字段", () => {
	beforeEach(() => {
		resetTrace();
	});

	it("AC3.1 · 完整 input(file/line/severity/body)→ trace 记录", async () => {
		const { pi, getToolCallHandler } = createMockPi();
		extensionFactory(pi);

		const handler = getToolCallHandler();
		expect(handler).toBeDefined();

		await handler?.({
			toolName: "gitlab_post_line_comment",
			input: {
				file: "src/api/auth.ts",
				line: 42,
				severity: "blocker",
				body: "🔴 **阻塞** · 硬编码 API Key\n\n详情...",
			},
		});

		const trace = getTrace();
		expect(trace.lineComments).toEqual([
			{
				file: "src/api/auth.ts",
				line: 42,
				severity: "blocker",
				title: "硬编码 API Key",
			},
		]);
	});

	it("AC3.2 · input 缺 severity → 不记录(类型守卫拦截)", async () => {
		const { pi, getToolCallHandler } = createMockPi();
		extensionFactory(pi);

		const handler = getToolCallHandler();
		await handler?.({
			toolName: "gitlab_post_line_comment",
			input: {
				file: "src/a.ts",
				line: 1,
				// severity: 缺
				body: "🔴 **阻塞** · X",
			},
		});

		const trace = getTrace();
		expect(trace.lineComments).toEqual([]);
	});

	it("AC3.2 · input severity 非法值 → 不记录", async () => {
		const { pi, getToolCallHandler } = createMockPi();
		extensionFactory(pi);

		const handler = getToolCallHandler();
		await handler?.({
			toolName: "gitlab_post_line_comment",
			input: {
				file: "src/a.ts",
				line: 1,
				severity: "warning", // 旧词表,已淘汰
				body: "🔴 **阻塞** · X",
			},
		});

		expect(getTrace().lineComments).toEqual([]);
	});

	it("gitlab_get_file_content event → 记录 readFiles", async () => {
		const { pi, getToolCallHandler } = createMockPi();
		extensionFactory(pi);

		const handler = getToolCallHandler();
		await handler?.({
			toolName: "gitlab_get_file_content",
			input: { path: "src/a.ts", ref: "main" },
		});

		expect([...getTrace().readFiles]).toEqual(["src/a.ts"]);
	});

	it("gitlab_prepare_project_workspace event → 累计 workspacePrepareCount(R3 数据源)", async () => {
		const { pi, getToolCallHandler } = createMockPi();
		extensionFactory(pi);

		const handler = getToolCallHandler();
		await handler?.({
			toolName: "gitlab_prepare_project_workspace",
			input: { project: "digital-biz-projects/srm/srm-harness", ref: "v1.4", alias: "srm-harness" },
		});
		await handler?.({
			toolName: "gitlab_prepare_project_workspace",
			input: { project: "digital-biz-projects/srm/srm-harness", ref: "master", alias: "srm-harness" },
		});

		expect(getTrace().workspacePrepareCount).toBe(2);
	});

	it("其他 tool event → trace 不变", async () => {
		const { pi, getToolCallHandler } = createMockPi();
		extensionFactory(pi);

		const handler = getToolCallHandler();
		await handler?.({
			toolName: "gitlab_get_mr_diff",
			input: {},
		});

		const trace = getTrace();
		expect(trace.readFiles.size).toBe(0);
		expect(trace.lineComments).toEqual([]);
		expect(trace.workspacePrepareCount).toBe(0);
	});
});

describe("extension · 注册顺序契约:telemetry 先于 compliance(拦截调用可观测)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "flower-ext-"));
		resetTrace();
		resetTelemetry();
		vi.stubEnv("FLOWER_VERBOSE", "0"); // 测试不要 console sink 刷屏
		vi.stubEnv("FLOWER_TELEMETRY_FILE", join(dir, "trace.jsonl"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		resetTelemetry();
		rmSync(dir, { recursive: true, force: true });
	});

	/** 模拟 pi 的 tool_call 派发:按注册顺序执行,首个 {block} 短路 */
	async function dispatchToolCall(
		handlers: Array<(event: Record<string, unknown>) => Promise<unknown>>,
		event: Record<string, unknown>,
	): Promise<unknown> {
		for (const handler of handlers) {
			const res = (await handler(event)) as { block?: boolean } | undefined;
			if (res?.block === true) return res;
		}
		return undefined;
	}

	it("被 compliance 拦截的 bash 调用:tool_call span 已进 JSONL,且 security_block outcome 落盘(漏报缺陷回归)", async () => {
		const { pi, toolCallHandlers } = createMockPi();
		extensionFactory(pi);
		// 注册顺序契约:≥3 个 tool_call handler(telemetry → compliance → review-trace)
		expect(toolCallHandlers.length).toBeGreaterThanOrEqual(3);

		const res = (await dispatchToolCall(toolCallHandlers, {
			toolName: "bash",
			toolCallId: "call-blocked-1",
			input: { command: "env" },
		})) as { block: boolean; reason: string };
		expect(res.block).toBe(true);

		const lines = readFileSync(join(dir, "trace.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		// 调用意图 span:telemetry 先于 compliance 注册才能看到
		const span = lines.find((l) => l.kind === "span" && l.spanType === "tool_call");
		expect(span).toMatchObject({ tool: "bash", toolCallId: "call-blocked-1", inputKeys: ["command"] });
		// 拦截结论 outcome:经 onBlock → recordSecurityEvent 接线写入
		const blocked = lines.find((l) => l.kind === "outcome" && l.outcomeType === "security_block");
		expect(blocked).toBeDefined();
		expect((blocked as { securityBlock: Record<string, unknown> }).securityBlock).toMatchObject({
			tool: "bash",
			mode: "ci-readonly",
			toolCallId: "call-blocked-1",
			command: "env",
		});
	});

	it("放行的白名单调用:有 tool_call span,无 security_block outcome", async () => {
		const { pi, toolCallHandlers } = createMockPi();
		extensionFactory(pi);
		const res = await dispatchToolCall(toolCallHandlers, {
			toolName: "bash",
			toolCallId: "call-ok-1",
			input: { command: "git status" },
		});
		expect(res).toBeUndefined();

		const lines = readFileSync(join(dir, "trace.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(lines.some((l) => l.kind === "span" && l.spanType === "tool_call")).toBe(true);
		expect(lines.some((l) => l.kind === "outcome")).toBe(false);
	});
});

describe("extension · reviewer_list_my_blockers 工具注册", () => {
	it("AC1.5 · 工具被注册且 name 是 reviewer_list_my_blockers + 无参 schema", () => {
		const { pi, registeredTools } = createMockPi();
		extensionFactory(pi);

		const tool = registeredTools.find((t) => t.name === "reviewer_list_my_blockers");
		expect(tool).toBeDefined();
		expect(reviewerListMyBlockersTool.name).toBe("reviewer_list_my_blockers");
	});
});

describe("reviewer_list_my_blockers · execute 真值返回", () => {
	beforeEach(() => {
		resetTrace();
	});

	it("AC1.2 · trace 空 → count=0, blockers=[]", async () => {
		const result = await (
			reviewerListMyBlockersTool.execute as unknown as (
				id: string,
				params: Record<string, never>,
			) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>
		)("id-1", {});
		const text = result.content[0];
		expect(text?.type).toBe("text");
		expect(text && "text" in text ? JSON.parse(text.text) : null).toEqual({
			count: 0,
			blockers: [],
		});
	});

	it("AC1.1 · trace 2 blocker + 1 major → 只返回 2 blocker", async () => {
		recordLineComment({
			file: "src/a.ts",
			line: 10,
			severity: "blocker",
			body: "🔴 **阻塞** · A",
		});
		recordLineComment({
			file: "src/b.ts",
			line: 20,
			severity: "major",
			body: "🟠 **重要** · B",
		});
		recordLineComment({
			file: "src/c.ts",
			line: 30,
			severity: "blocker",
			body: "🔴 **阻塞** · C",
		});

		const result = await (
			reviewerListMyBlockersTool.execute as unknown as (
				id: string,
				params: Record<string, never>,
			) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>
		)("id-2", {});
		const text = result.content[0];
		const payload = text && "text" in text ? JSON.parse(text.text) : null;
		expect(payload).toEqual({
			count: 2,
			blockers: [
				{ path: "src/a.ts", line: 10, title: "A" },
				{ path: "src/c.ts", line: 30, title: "C" },
			],
		});
		expect(result.details).toEqual({ count: 2 });
	});

	it("AC1.3 · blocker body 含等级 + `·` 分隔 → title 抽取正确", async () => {
		recordLineComment({
			file: "src/a.ts",
			line: 1,
			severity: "blocker",
			body: "🔴 **阻塞** · 硬编码 secret\n\n详情段...",
		});

		const result = await (
			reviewerListMyBlockersTool.execute as unknown as (
				id: string,
				params: Record<string, never>,
			) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>
		)("id-3", {});
		const text = result.content[0];
		const payload = text && "text" in text ? JSON.parse(text.text) : null;
		expect(payload.blockers[0].title).toBe("硬编码 secret");
	});

	it("AC1.4 · blocker body 等级与标题间无 `·`(空格分隔)→ title 抽取仍正确", async () => {
		recordLineComment({
			file: "src/a.ts",
			line: 1,
			severity: "blocker",
			body: "🔴 **阻塞** 性能问题",
		});

		const result = await (
			reviewerListMyBlockersTool.execute as unknown as (
				id: string,
				params: Record<string, never>,
			) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>
		)("id-4", {});
		const text = result.content[0];
		const payload = text && "text" in text ? JSON.parse(text.text) : null;
		expect(payload.blockers[0].title).toBe("性能问题");
	});
});
