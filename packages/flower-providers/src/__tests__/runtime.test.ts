/**
 * `runtime.ts` 单元测试:getDefaultModel + buildHavefunModel
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHavefunModel, getDefaultModel } from "../runtime.js";

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

describe("getDefaultModel — 合法组合", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("anthropic + Claude Opus", () => {
		process.env.LLM_PROVIDER = "havefun-anthropic";
		process.env.LLM_MODEL = "claude-opus-4-7";
		expect(getDefaultModel()).toEqual({
			provider: "havefun-anthropic",
			modelId: "claude-opus-4-7",
		});
	});

	it("gemini + Gemini Flash", () => {
		process.env.LLM_PROVIDER = "havefun-gemini";
		process.env.LLM_MODEL = "gemini-2.5-flash";
		expect(getDefaultModel()).toEqual({
			provider: "havefun-gemini",
			modelId: "gemini-2.5-flash",
		});
	});

	it("openai-responses + GPT-5.5(网关漏报但实际支持)", () => {
		process.env.LLM_PROVIDER = "havefun-openai-responses";
		process.env.LLM_MODEL = "gpt-5.5";
		expect(getDefaultModel()).toEqual({
			provider: "havefun-openai-responses",
			modelId: "gpt-5.5",
		});
	});

	it("havefun-openai + extras 注入的模型", () => {
		process.env.LLM_PROVIDER = "havefun-openai";
		process.env.LLM_MODEL = "grok-4.20-fast";
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([{ id: "grok-4.20-fast", nativeApi: "openai-completions" }]);
		expect(getDefaultModel()).toEqual({
			provider: "havefun-openai",
			modelId: "grok-4.20-fast",
		});
	});
});

describe("getDefaultModel — 非法组合", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("LLM_PROVIDER 缺失 → 抛错", () => {
		process.env.LLM_MODEL = "claude-opus-4-7";
		expect(() => getDefaultModel()).toThrow(/LLM_PROVIDER 未配置/);
	});

	it("LLM_MODEL 缺失 → 抛错", () => {
		process.env.LLM_PROVIDER = "havefun-anthropic";
		expect(() => getDefaultModel()).toThrow(/LLM_MODEL 未配置/);
	});

	it("LLM_PROVIDER 非法值 → 抛错", () => {
		process.env.LLM_PROVIDER = "invalid-provider";
		process.env.LLM_MODEL = "claude-opus-4-7";
		expect(() => getDefaultModel()).toThrow(/LLM_PROVIDER 非法值/);
	});

	it("LLM_MODEL 不在清单 → 抛错(错误信息列出全部合法 id)", () => {
		process.env.LLM_PROVIDER = "havefun-anthropic";
		process.env.LLM_MODEL = "nonexistent-model";
		expect(() => getDefaultModel()).toThrow(/不在合并模型清单中.*claude-opus-4-7/);
	});

	it("LLM_PROVIDER=havefun-openai + LLM_MODEL=claude-opus-4-7 → 协议不匹配", () => {
		process.env.LLM_PROVIDER = "havefun-openai";
		process.env.LLM_MODEL = "claude-opus-4-7";
		expect(() => getDefaultModel()).toThrow(/不一致/);
	});

	it("LLM_PROVIDER=havefun-gemini + LLM_MODEL=gpt-5.4 → 协议不匹配", () => {
		process.env.LLM_PROVIDER = "havefun-gemini";
		process.env.LLM_MODEL = "gpt-5.4";
		expect(() => getDefaultModel()).toThrow(/不一致/);
	});

	it("LLM_PROVIDER=havefun-anthropic + LLM_MODEL=gemini-2.5-pro → 协议不匹配", () => {
		process.env.LLM_PROVIDER = "havefun-anthropic";
		process.env.LLM_MODEL = "gemini-2.5-pro";
		expect(() => getDefaultModel()).toThrow(/不一致/);
	});
});

describe("buildHavefunModel — 字段对照", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("Claude 返回 anthropic-messages 协议 + baseUrl 来自 env", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		const model = buildHavefunModel("havefun-anthropic", "claude-opus-4-7");
		expect(model).toMatchObject({
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
			api: "anthropic-messages",
			provider: "havefun-anthropic",
			baseUrl: "https://jp-ai.havefun.eu.cc",
			contextWindow: 200_000,
			maxTokens: 32_000,
			reasoning: true,
		});
	});

	it("Gemini 返回 google-generative-ai 协议", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		const model = buildHavefunModel("havefun-gemini", "gemini-2.5-flash");
		expect(model.api).toBe("google-generative-ai");
		expect(model.provider).toBe("havefun-gemini");
	});

	it("GPT-5.4 返回 openai-responses 协议", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		const model = buildHavefunModel("havefun-openai-responses", "gpt-5.4");
		expect(model.api).toBe("openai-responses");
	});

	it("不存在的 modelId → 抛错", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		expect(() => buildHavefunModel("havefun-anthropic", "no-such-model")).toThrow(/不在合并模型清单中/);
	});

	it("provider 与 model 协议不匹配 → 抛错", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		expect(() => buildHavefunModel("havefun-openai", "claude-opus-4-7")).toThrow(/不一致/);
	});

	it("cost 字段保留原结构(全 0 是有意为之)", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		const model = buildHavefunModel("havefun-anthropic", "claude-opus-4-7");
		expect(model.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("从 extras 注入的 model 也能构造", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([
			{ id: "grok-4.20-fast", nativeApi: "openai-completions", name: "Grok 4.20" },
		]);
		const model = buildHavefunModel("havefun-openai", "grok-4.20-fast");
		expect(model.id).toBe("grok-4.20-fast");
		expect(model.api).toBe("openai-completions");
		expect(model.name).toBe("Grok 4.20");
	});
});
