/**
 * `runtime.ts` 单元测试:getDefaultModel + buildHavefunModel
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHavefunModel, getDefaultModel, getDefaultReasoningEffort } from "../runtime.js";

const ENV_KEYS = [
	"LLM_BASE_URL",
	"LLM_API_KEY",
	"LLM_PROVIDER",
	"LLM_MODEL",
	"LLM_EXTRA_MODELS_JSON",
	"LLM_REASONING_EFFORT",
];

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
			contextWindow: 1_000_000,
			maxTokens: 128_000,
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

	it("Opus 4.7 构造出的 Model 含 thinkingLevelMap(只 override xhigh → max)", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		const model = buildHavefunModel("havefun-anthropic", "claude-opus-4-7");
		// 精简到 1 key:其他 level 由 pi anthropic.js switch fallback 自动恒等映射
		expect(model.thinkingLevelMap).toEqual({ xhigh: "max" });
	});

	it("Sonnet 4.6 构造出的 Model 不含 thinkingLevelMap(避免 undefined 污染)", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		const model = buildHavefunModel("havefun-anthropic", "claude-sonnet-4-6");
		// 走 pi 默认 mapping;对象上根本没有这个键(而不是 undefined 字段)
		expect(Object.hasOwn(model, "thinkingLevelMap")).toBe(false);
	});

	it("extras 注入带 thinkingLevelMap 的 model → 也透传到 Model", () => {
		process.env.LLM_BASE_URL = "https://jp-ai.havefun.eu.cc";
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([
			{
				id: "claude-opus-4-x-custom",
				nativeApi: "anthropic-messages",
				thinkingLevelMap: { off: "off", xhigh: "max" },
			},
		]);
		const model = buildHavefunModel("havefun-anthropic", "claude-opus-4-x-custom");
		expect(model.thinkingLevelMap).toEqual({ off: "off", xhigh: "max" });
	});
});

describe("getDefaultReasoningEffort", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("env 未配置 + 不传 modelId → 全局 fallback 'high'", () => {
		expect(getDefaultReasoningEffort()).toBe("high");
	});

	it("env 未配置 + 传 'claude-opus-4-7' → 'xhigh'(每模型默认)", () => {
		expect(getDefaultReasoningEffort("claude-opus-4-7")).toBe("xhigh");
	});

	it("env 未配置 + 传 'claude-sonnet-4-6' → 'high'(每模型默认)", () => {
		expect(getDefaultReasoningEffort("claude-sonnet-4-6")).toBe("high");
	});

	it("env 未配置 + 传 'claude-haiku-4-5-20251001' → 'off'(reasoning=false 模型跳过 thinking)", () => {
		expect(getDefaultReasoningEffort("claude-haiku-4-5-20251001")).toBe("off");
	});

	it("env 未配置 + 传 'gemini-2.5-flash-lite' → 'off'", () => {
		expect(getDefaultReasoningEffort("gemini-2.5-flash-lite")).toBe("off");
	});

	it("env 未配置 + 传 'gemini-2.5-pro' → 'high'", () => {
		expect(getDefaultReasoningEffort("gemini-2.5-pro")).toBe("high");
	});

	it("env 未配置 + 传 'gpt-5.5' → 'xhigh'", () => {
		expect(getDefaultReasoningEffort("gpt-5.5")).toBe("xhigh");
	});

	it("env 未配置 + 传未知 model id → 全局 fallback 'high'", () => {
		expect(getDefaultReasoningEffort("unknown-id-foo")).toBe("high");
	});

	it("env 配 'low' → 覆盖任何 model 的默认", () => {
		process.env.LLM_REASONING_EFFORT = "low";
		expect(getDefaultReasoningEffort()).toBe("low");
		expect(getDefaultReasoningEffort("claude-opus-4-7")).toBe("low");
		expect(getDefaultReasoningEffort("claude-haiku-4-5-20251001")).toBe("low");
		expect(getDefaultReasoningEffort("unknown-id")).toBe("low");
	});

	it("env 配 'off' → 所有 model 都返回 'off'", () => {
		process.env.LLM_REASONING_EFFORT = "off";
		expect(getDefaultReasoningEffort("claude-opus-4-7")).toBe("off");
	});

	it("env 配非法值 → 调用时立即抛错", () => {
		process.env.LLM_REASONING_EFFORT = "max";
		expect(() => getDefaultReasoningEffort()).toThrow(/LLM_REASONING_EFFORT 非法值/);
		expect(() => getDefaultReasoningEffort("claude-opus-4-7")).toThrow(/LLM_REASONING_EFFORT 非法值/);
	});
});
