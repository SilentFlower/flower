/**
 * reviewer 运行期配置单元测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveContextReadBatchSize,
	resolveContextReadDefaultLines,
	resolveContextReadMaxLines,
	resolveLlmAgentMaxRetries,
	resolveLlmProviderMaxRetries,
	resolveLlmRequestTimeoutMs,
	resolveReviewRuntimeConfig,
	resolveReviewTimeoutMs,
} from "../runtime-config.js";

describe("runtime-config · 默认值", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("默认值与 infra hard timeout / 行窗策略一致", () => {
		expect(resolveReviewTimeoutMs()).toBe(1080000);
		expect(resolveLlmRequestTimeoutMs()).toBe(60000);
		expect(resolveLlmProviderMaxRetries()).toBe(1);
		expect(resolveLlmAgentMaxRetries()).toBe(3);
		expect(resolveContextReadBatchSize()).toBe(5);
		expect(resolveContextReadDefaultLines()).toBe(500);
		expect(resolveContextReadMaxLines()).toBe(1000);
	});

	it("resolveReviewRuntimeConfig 聚合所有配置", () => {
		expect(resolveReviewRuntimeConfig()).toEqual({
			reviewTimeoutMs: 1080000,
			llmRequestTimeoutMs: 60000,
			llmProviderMaxRetries: 1,
			llmAgentMaxRetries: 3,
			contextReadBatchSize: 5,
			contextReadDefaultLines: 500,
			contextReadMaxLines: 1000,
		});
	});
});

describe("runtime-config · env 覆盖", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("有效 env 覆盖默认值", () => {
		vi.stubEnv("FLOWER_REVIEW_TIMEOUT_MS", "600000");
		vi.stubEnv("FLOWER_LLM_REQUEST_TIMEOUT_MS", "30000");
		vi.stubEnv("FLOWER_LLM_PROVIDER_MAX_RETRIES", "2");
		vi.stubEnv("FLOWER_LLM_AGENT_MAX_RETRIES", "4");
		vi.stubEnv("FLOWER_CONTEXT_READ_BATCH_SIZE", "3");
		vi.stubEnv("FLOWER_CONTEXT_READ_DEFAULT_LINES", "200");
		vi.stubEnv("FLOWER_CONTEXT_READ_MAX_LINES", "900");

		expect(resolveReviewRuntimeConfig()).toEqual({
			reviewTimeoutMs: 600000,
			llmRequestTimeoutMs: 30000,
			llmProviderMaxRetries: 2,
			llmAgentMaxRetries: 4,
			contextReadBatchSize: 3,
			contextReadDefaultLines: 200,
			contextReadMaxLines: 900,
		});
	});

	it("FLOWER_REVIEW_TIMEOUT_MS=0 允许关闭软超时", () => {
		vi.stubEnv("FLOWER_REVIEW_TIMEOUT_MS", "0");
		expect(resolveReviewTimeoutMs()).toBe(0);
	});

	it("非法 env 回退默认值", () => {
		vi.stubEnv("FLOWER_REVIEW_TIMEOUT_MS", "-1");
		vi.stubEnv("FLOWER_LLM_REQUEST_TIMEOUT_MS", "NaN");
		vi.stubEnv("FLOWER_LLM_PROVIDER_MAX_RETRIES", "-2");
		vi.stubEnv("FLOWER_CONTEXT_READ_DEFAULT_LINES", "0");

		expect(resolveReviewTimeoutMs()).toBe(1080000);
		expect(resolveLlmRequestTimeoutMs()).toBe(60000);
		expect(resolveLlmProviderMaxRetries()).toBe(1);
		expect(resolveContextReadDefaultLines()).toBe(500);
	});
});
