/**
 * `catalog.ts` 单元测试:BUILTIN_MODELS 数据完整性
 */

import { describe, expect, it } from "vitest";
import { ALLOWED_APIS, ALLOWED_PROVIDER_NAMES, API_TO_PROVIDER, BUILTIN_MODELS, PROVIDER_TO_API } from "../catalog.js";

describe("BUILTIN_MODELS", () => {
	it("应有 8 条记录", () => {
		expect(BUILTIN_MODELS.length).toBe(8);
	});

	it("每条 nativeApi 必须 ∈ 4 个合法 Api 值", () => {
		for (const m of BUILTIN_MODELS) {
			expect(ALLOWED_APIS).toContain(m.nativeApi);
		}
	});

	it("Claude 家族 3 条,均走 anthropic-messages", () => {
		const claudes = BUILTIN_MODELS.filter((m) => m.id.startsWith("claude-"));
		expect(claudes.length).toBe(3);
		for (const m of claudes) {
			expect(m.nativeApi).toBe("anthropic-messages");
		}
	});

	it("Gemini 家族 3 条,均走 google-generative-ai", () => {
		const geminis = BUILTIN_MODELS.filter((m) => m.id.startsWith("gemini-"));
		expect(geminis.length).toBe(3);
		for (const m of geminis) {
			expect(m.nativeApi).toBe("google-generative-ai");
		}
	});

	it("GPT-5.x 家族 2 条,均走 openai-responses", () => {
		const gpts = BUILTIN_MODELS.filter((m) => m.id.startsWith("gpt-"));
		expect(gpts.length).toBe(2);
		for (const m of gpts) {
			expect(m.nativeApi).toBe("openai-responses");
		}
		// 关键 case:gpt-5.5 必须走 openai-responses(网关 /v1/models 漏报,以人工知识为准)
		expect(gpts.find((m) => m.id === "gpt-5.5")?.nativeApi).toBe("openai-responses");
	});

	it("无 BUILTIN 模型走 openai-completions(havefun-openai 默认空,这是设计)", () => {
		const openaiOnly = BUILTIN_MODELS.filter((m) => m.nativeApi === "openai-completions");
		expect(openaiOnly.length).toBe(0);
	});

	it("model id 唯一", () => {
		const ids = BUILTIN_MODELS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("基础字段非空", () => {
		for (const m of BUILTIN_MODELS) {
			expect(m.id).toBeTruthy();
			expect(m.name).toBeTruthy();
			expect(m.contextWindow).toBeGreaterThan(0);
			expect(m.maxTokens).toBeGreaterThan(0);
			expect(Array.isArray(m.input)).toBe(true);
			expect(m.cost).toBeDefined();
		}
	});
});

describe("PROVIDER_TO_API / API_TO_PROVIDER", () => {
	it("4 个 provider 名对应 4 个 pi-ai Api 字段", () => {
		expect(PROVIDER_TO_API["havefun-openai"]).toBe("openai-completions");
		expect(PROVIDER_TO_API["havefun-openai-responses"]).toBe("openai-responses");
		expect(PROVIDER_TO_API["havefun-anthropic"]).toBe("anthropic-messages");
		expect(PROVIDER_TO_API["havefun-gemini"]).toBe("google-generative-ai");
	});

	it("API_TO_PROVIDER 反向映射对称", () => {
		for (const providerName of ALLOWED_PROVIDER_NAMES) {
			const api = PROVIDER_TO_API[providerName];
			expect(API_TO_PROVIDER[api as string]).toBe(providerName);
		}
	});
});
