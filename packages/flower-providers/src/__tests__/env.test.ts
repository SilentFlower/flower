/**
 * `env.ts` 单元测试:fail-fast 矩阵
 *
 * 关键约束:本测试**不联网**,仅校验 env 解析与错误抛出。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getExtraModels,
	getLLMApiKeyEnvName,
	getLLMBaseUrl,
	getLLMModel,
	getLLMProvider,
	getMergedModels,
} from "../env.js";

// 备份原始 env 值,逐 case 清理
const ENV_KEYS = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_EXTRA_MODELS_JSON"];

function snapshotEnv(): Record<string, string | undefined> {
	const snap: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) {
		snap[k] = process.env[k];
	}
	return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
	for (const k of ENV_KEYS) {
		if (snap[k] === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = snap[k];
		}
	}
}

function clearEnv(): void {
	for (const k of ENV_KEYS) {
		delete process.env[k];
	}
}

describe("getLLMBaseUrl", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("缺失 → 抛错", () => {
		expect(() => getLLMBaseUrl()).toThrow(/LLM_BASE_URL 未配置/);
	});

	it("空字符串 → 抛错", () => {
		process.env.LLM_BASE_URL = "  ";
		expect(() => getLLMBaseUrl()).toThrow(/LLM_BASE_URL 未配置/);
	});

	it("合法 → 返回字符串", () => {
		process.env.LLM_BASE_URL = "https://example.com/v1";
		expect(getLLMBaseUrl()).toBe("https://example.com/v1");
	});
});

describe("getLLMApiKeyEnvName", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("LLM_API_KEY 缺失 → 抛错", () => {
		expect(() => getLLMApiKeyEnvName()).toThrow(/LLM_API_KEY 未配置/);
	});

	it("LLM_API_KEY 存在 → 返回字面量 'LLM_API_KEY'(不返回真实 key)", () => {
		process.env.LLM_API_KEY = "sk-test-do-not-leak";
		expect(getLLMApiKeyEnvName()).toBe("LLM_API_KEY");
	});
});

describe("getLLMProvider", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("缺失 → 抛错", () => {
		expect(() => getLLMProvider()).toThrow(/LLM_PROVIDER 未配置/);
	});

	it("非法值 → 抛错(错误信息列出 4 个合法名)", () => {
		process.env.LLM_PROVIDER = "invalid-provider";
		expect(() => getLLMProvider()).toThrow(/LLM_PROVIDER 非法值/);
		expect(() => getLLMProvider()).toThrow(/havefun-anthropic/);
	});

	it("合法 → 返回 ProviderName", () => {
		process.env.LLM_PROVIDER = "havefun-anthropic";
		expect(getLLMProvider()).toBe("havefun-anthropic");
	});
});

describe("getLLMModel", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("缺失 → 抛错", () => {
		expect(() => getLLMModel()).toThrow(/LLM_MODEL 未配置/);
	});

	it("合法 → 返回字符串", () => {
		process.env.LLM_MODEL = "claude-opus-4-7";
		expect(getLLMModel()).toBe("claude-opus-4-7");
	});
});

describe("getExtraModels", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("env 缺失 → 空数组", () => {
		expect(getExtraModels()).toEqual([]);
	});

	it("env 为空字符串 → 空数组", () => {
		process.env.LLM_EXTRA_MODELS_JSON = "";
		expect(getExtraModels()).toEqual([]);
	});

	it("JSON 解析失败 → 抛错", () => {
		process.env.LLM_EXTRA_MODELS_JSON = "not json {";
		expect(() => getExtraModels()).toThrow(/LLM_EXTRA_MODELS_JSON 解析失败/);
	});

	it("非数组 → 抛错", () => {
		process.env.LLM_EXTRA_MODELS_JSON = '{"foo": "bar"}';
		expect(() => getExtraModels()).toThrow(/必须是数组结构/);
	});

	it("缺 id → 抛错", () => {
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([{ nativeApi: "openai-completions" }]);
		expect(() => getExtraModels()).toThrow(/\.id 必填/);
	});

	it("缺 nativeApi → 抛错", () => {
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([{ id: "x" }]);
		expect(() => getExtraModels()).toThrow(/nativeApi 必填/);
	});

	it("nativeApi 非法值 → 抛错", () => {
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([{ id: "x", nativeApi: "unknown-api" }]);
		expect(() => getExtraModels()).toThrow(/nativeApi 非法值/);
	});

	it("合法最小 entry → 走默认值", () => {
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([{ id: "grok-4.20-fast", nativeApi: "openai-completions" }]);
		const list = getExtraModels();
		expect(list.length).toBe(1);
		const entry = list[0];
		expect(entry).toBeDefined();
		expect(entry?.id).toBe("grok-4.20-fast");
		expect(entry?.nativeApi).toBe("openai-completions");
		expect(entry?.name).toBe("grok-4.20-fast"); // 默认 = id
		expect(entry?.reasoning).toBe(false);
	});

	it("合法完整 entry → 全字段保留", () => {
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([
			{
				id: "qwen3-max",
				name: "Qwen3 Max",
				nativeApi: "openai-completions",
				contextWindow: 32000,
				maxTokens: 8192,
				reasoning: true,
				input: ["text"],
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 },
			},
		]);
		const list = getExtraModels();
		expect(list[0]).toMatchObject({
			id: "qwen3-max",
			name: "Qwen3 Max",
			contextWindow: 32000,
			maxTokens: 8192,
			reasoning: true,
			nativeApi: "openai-completions",
		});
	});
});

describe("getMergedModels", () => {
	let snap: Record<string, string | undefined>;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("无 extras → 8 条 builtin", () => {
		expect(getMergedModels().length).toBe(8);
	});

	it("extras 注入新 id → 9 条", () => {
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([{ id: "grok-4.20-fast", nativeApi: "openai-completions" }]);
		expect(getMergedModels().length).toBe(9);
	});

	it("extras 同 id 覆盖 builtin", () => {
		process.env.LLM_EXTRA_MODELS_JSON = JSON.stringify([
			{
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7 (overridden)",
				nativeApi: "anthropic-messages",
			},
		]);
		const list = getMergedModels();
		const opus = list.find((m) => m.id === "claude-opus-4-7");
		expect(opus?.name).toBe("Claude Opus 4.7 (overridden)");
		// 总数仍是 8(覆盖,不是新增)
		expect(list.length).toBe(8);
	});
});
