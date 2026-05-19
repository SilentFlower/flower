/**
 * `register.ts` 单元测试:registerHavefunProviders 行为
 *
 * 用 stub 的 ExtensionAPI(只实现 registerProvider spy)。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerHavefunProviders } from "../register.js";

const ENV_KEYS = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_EXTRA_MODELS_JSON"];

function snapshotEnv(): Record<string, string | undefined> {
	const snap: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) snap[k] = process.env[k];
	return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
	for (const k of ENV_KEYS) {
		if (snap[k] === undefined) delete process.env[k];
		else process.env[k] = snap[k];
	}
}
function clearEnv(): void {
	for (const k of ENV_KEYS) delete process.env[k];
}

/**
 * 构造一个仅实现 registerProvider spy 的 ExtensionAPI 桩
 */
interface RegisterCall {
	name: string;
	// biome-ignore lint/suspicious/noExplicitAny: 测试场景对 config 字段做断言,不需要精确类型
	config: any;
}

function createStubPi(): { pi: ExtensionAPI; calls: RegisterCall[] } {
	const calls: RegisterCall[] = [];
	const registerProvider = vi.fn((name: string, config: Record<string, unknown>) => {
		calls.push({ name, config });
	});
	const pi = { registerProvider } as unknown as ExtensionAPI;
	return { pi, calls };
}

describe("registerHavefunProviders — 4 个 provider 全部注册", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		process.env.LLM_API_KEY = "sk-test-do-not-leak";
	});
	afterEach(() => restoreEnv(snap));

	it("调 4 次 registerProvider,name + api 正确", () => {
		const { pi, calls } = createStubPi();
		registerHavefunProviders(pi, { appSource: "code-reviewer" });

		expect(calls.length).toBe(4);

		const byName = new Map(calls.map((c) => [c.name, c]));
		expect(byName.get("havefun-openai")?.config.api).toBe("openai-completions");
		expect(byName.get("havefun-openai-responses")?.config.api).toBe("openai-responses");
		expect(byName.get("havefun-anthropic")?.config.api).toBe("anthropic-messages");
		expect(byName.get("havefun-gemini")?.config.api).toBe("google-generative-ai");
	});

	it("apiKey 字段始终是字面量 'LLM_API_KEY',真实 key 不出现在 config", () => {
		const { pi, calls } = createStubPi();
		registerHavefunProviders(pi, { appSource: "code-reviewer" });

		for (const c of calls) {
			expect(c.config.apiKey).toBe("LLM_API_KEY");
		}
		// 序列化后真实 key 不应该出现
		const serialized = JSON.stringify(calls);
		expect(serialized).not.toContain("sk-test-do-not-leak");
	});

	it("baseUrl 按 provider 拼协议后缀(LLM_BASE_URL 是根 URL)", () => {
		const { pi, calls } = createStubPi();
		registerHavefunProviders(pi, { appSource: "ops-bot" });
		const byName = new Map(calls.map((c) => [c.name, c]));
		expect(byName.get("havefun-openai")?.config.baseUrl).toBe("https://jp-ai.havefun.eu.cc/v1");
		expect(byName.get("havefun-openai-responses")?.config.baseUrl).toBe("https://jp-ai.havefun.eu.cc/v1");
		expect(byName.get("havefun-anthropic")?.config.baseUrl).toBe("https://jp-ai.havefun.eu.cc");
		expect(byName.get("havefun-gemini")?.config.baseUrl).toBe("https://jp-ai.havefun.eu.cc/v1beta");
	});

	it("LLM_BASE_URL 尾部斜杠会被去除", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc/";
		const { pi, calls } = createStubPi();
		registerHavefunProviders(pi, { appSource: "ops-bot" });
		const byName = new Map(calls.map((c) => [c.name, c]));
		expect(byName.get("havefun-openai")?.config.baseUrl).toBe("https://jp-ai.havefun.eu.cc/v1");
		expect(byName.get("havefun-anthropic")?.config.baseUrl).toBe("https://jp-ai.havefun.eu.cc");
	});

	it("X-App-Source header 来自 options.appSource", () => {
		const { pi, calls } = createStubPi();
		registerHavefunProviders(pi, { appSource: "ops-bot" });
		for (const c of calls) {
			expect(c.config.headers["X-App-Source"]).toBe("ops-bot");
		}
	});

	it("模型数:anthropic=3 / gemini=3 / openai-responses=2 / openai=0(无 extras)", () => {
		const { pi, calls } = createStubPi();
		registerHavefunProviders(pi, { appSource: "code-reviewer" });

		const byName = new Map(calls.map((c) => [c.name, c]));
		expect(byName.get("havefun-anthropic")?.config.models.length).toBe(3);
		expect(byName.get("havefun-gemini")?.config.models.length).toBe(3);
		expect(byName.get("havefun-openai-responses")?.config.models.length).toBe(2);
		// havefun-openai 默认空(供 extras 注入)
		expect(byName.get("havefun-openai")?.config.models.length).toBe(0);
	});

	it("gpt-5.5 只出现在 havefun-openai-responses 的 models 中", () => {
		const { pi, calls } = createStubPi();
		registerHavefunProviders(pi, { appSource: "code-reviewer" });

		for (const c of calls) {
			const ids: string[] = c.config.models.map((m: { id: string }) => m.id);
			if (c.name === "havefun-openai-responses") {
				expect(ids).toContain("gpt-5.5");
			} else {
				expect(ids).not.toContain("gpt-5.5");
			}
		}
	});
});

describe("registerHavefunProviders — extras 注入", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		process.env.LLM_API_KEY = "sk-test-do-not-leak";
	});
	afterEach(() => restoreEnv(snap));

	it("extras 注入 only-openai 模型 → 出现在 havefun-openai 注册中", () => {
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([
			{
				id: "grok-4.20-fast",
				name: "Grok 4.20 Fast",
				nativeApi: "openai-completions",
			},
		]);

		const { pi, calls } = createStubPi();
		registerHavefunProviders(pi, { appSource: "code-reviewer" });

		const havefunOpenai = calls.find((c) => c.name === "havefun-openai");
		expect(havefunOpenai).toBeDefined();
		const ids = havefunOpenai?.config.models.map((m: { id: string }) => m.id);
		expect(ids).toContain("grok-4.20-fast");
		// 其他 provider 不应该出现这个模型
		for (const c of calls) {
			if (c.name === "havefun-openai") continue;
			const otherIds = c.config.models.map((m: { id: string }) => m.id);
			expect(otherIds).not.toContain("grok-4.20-fast");
		}
	});

	it("extras 注入额外 Claude 模型 → 出现在 havefun-anthropic 注册中", () => {
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([
			{
				id: "claude-opus-4-5-thinking",
				name: "Claude Opus 4.5 Thinking",
				nativeApi: "anthropic-messages",
			},
		]);

		const { pi, calls } = createStubPi();
		registerHavefunProviders(pi, { appSource: "code-reviewer" });

		const havefunAnthropic = calls.find((c) => c.name === "havefun-anthropic");
		expect(havefunAnthropic).toBeDefined();
		const ids = havefunAnthropic?.config.models.map((m: { id: string }) => m.id);
		expect(ids).toContain("claude-opus-4-5-thinking");
		// builtin 3 个 + 注入 1 个 = 4 个
		expect(havefunAnthropic?.config.models.length).toBe(4);
	});
});

describe("registerHavefunProviders — fail-fast", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("appSource 为空字符串 → 抛错", () => {
		process.env.LLM_BASE_URL = "https://x";
		process.env.LLM_API_KEY = "k";
		const { pi } = createStubPi();
		expect(() => registerHavefunProviders(pi, { appSource: "" })).toThrow(/appSource 必填/);
		expect(() => registerHavefunProviders(pi, { appSource: "   " })).toThrow(/appSource 必填/);
	});

	it("LLM_BASE_URL 缺失 → 抛错", () => {
		process.env.LLM_API_KEY = "k";
		const { pi } = createStubPi();
		expect(() => registerHavefunProviders(pi, { appSource: "code-reviewer" })).toThrow(/LLM_BASE_URL 未配置/);
	});

	it("LLM_API_KEY 缺失 → 抛错(本包额外检查保持两条路径一致)", () => {
		process.env.LLM_BASE_URL = "https://x";
		const { pi } = createStubPi();
		expect(() => registerHavefunProviders(pi, { appSource: "code-reviewer" })).toThrow(/LLM_API_KEY 未配置/);
	});
});
