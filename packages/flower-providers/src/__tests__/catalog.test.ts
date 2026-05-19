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

describe("BUILTIN_MODELS 真实参数", () => {
	// 用 id 查 entry 的小工具
	function byId(id: string) {
		const m = BUILTIN_MODELS.find((x) => x.id === id);
		if (!m) throw new Error(`builtin model "${id}" 未找到`);
		return m;
	}

	it("claude-opus-4-7:1M 上下文 / 128K 输出 / reasoning=true", () => {
		const m = byId("claude-opus-4-7");
		expect(m.contextWindow).toBe(1_000_000);
		expect(m.maxTokens).toBe(128_000);
		expect(m.reasoning).toBe(true);
	});

	it("claude-sonnet-4-6:1M 上下文 / 64K 输出 / reasoning=true / 无 thinkingLevelMap", () => {
		const m = byId("claude-sonnet-4-6");
		expect(m.contextWindow).toBe(1_000_000);
		expect(m.maxTokens).toBe(64_000);
		expect(m.reasoning).toBe(true);
		expect(m.thinkingLevelMap).toBeUndefined();
	});

	it("claude-haiku-4-5-20251001:200K 上下文 / 64K 输出 / reasoning=false(Anthropic 官方未列扩展思考)", () => {
		const m = byId("claude-haiku-4-5-20251001");
		expect(m.contextWindow).toBe(200_000);
		expect(m.maxTokens).toBe(64_000);
		expect(m.reasoning).toBe(false);
		expect(m.thinkingLevelMap).toBeUndefined();
	});

	it("gemini-2.5-pro:1,048,576 上下文 / 65,536 输出 / reasoning=true", () => {
		const m = byId("gemini-2.5-pro");
		expect(m.contextWindow).toBe(1_048_576);
		expect(m.maxTokens).toBe(65_536);
		expect(m.reasoning).toBe(true);
	});

	it("gemini-2.5-flash:1,048,576 上下文 / 65,535 输出 / reasoning=true", () => {
		const m = byId("gemini-2.5-flash");
		expect(m.contextWindow).toBe(1_048_576);
		expect(m.maxTokens).toBe(65_535);
		expect(m.reasoning).toBe(true);
	});

	it("gemini-2.5-flash-lite:1,048,576 上下文 / 65,535 输出 / reasoning=false", () => {
		const m = byId("gemini-2.5-flash-lite");
		expect(m.contextWindow).toBe(1_048_576);
		expect(m.maxTokens).toBe(65_535);
		expect(m.reasoning).toBe(false);
	});

	it("gpt-5.4:1,050,000 上下文 / 128K 输出 / reasoning=true", () => {
		const m = byId("gpt-5.4");
		expect(m.contextWindow).toBe(1_050_000);
		expect(m.maxTokens).toBe(128_000);
		expect(m.reasoning).toBe(true);
	});

	it("gpt-5.5:400K 上下文(网关 Codex 模式收敛)/ 128K 输出 / reasoning=true", () => {
		const m = byId("gpt-5.5");
		expect(m.contextWindow).toBe(400_000);
		expect(m.maxTokens).toBe(128_000);
		expect(m.reasoning).toBe(true);
	});
});

describe("BUILTIN_MODELS thinkingLevelMap", () => {
	it("claude-opus-4-7 只显式 override xhigh → max(PRD ADR-1 精简版)", () => {
		// PRD ADR-1:经 pi-ai 0.75.3 anthropic.js:546-561 源码验证,缺失 key 走
		// switch fallback 自动得到恒等映射,所以无需写满 6 个 key,只保留唯一
		// 与 pi 默认不一致的 xhigh → max
		const m = BUILTIN_MODELS.find((x) => x.id === "claude-opus-4-7");
		expect(m?.thinkingLevelMap).toEqual({ xhigh: "max" });
	});

	it("除 Opus 4.7 外其他 builtin 不显式声明 thinkingLevelMap(走 pi 默认)", () => {
		for (const m of BUILTIN_MODELS) {
			if (m.id === "claude-opus-4-7") continue;
			expect(m.thinkingLevelMap).toBeUndefined();
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
