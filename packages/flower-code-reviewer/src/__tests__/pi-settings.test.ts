/**
 * pi settings 注入单元测试
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePiSettings } from "../pi-settings.js";
import type { ReviewRuntimeConfig } from "../runtime-config.js";

function makeConfig(overrides: Partial<ReviewRuntimeConfig> = {}): ReviewRuntimeConfig {
	return {
		reviewTimeoutMs: 1080000,
		llmRequestTimeoutMs: 120000,
		llmProviderMaxRetries: 1,
		llmAgentMaxRetries: 3,
		contextReadBatchSize: 5,
		contextReadDefaultLines: 500,
		contextReadMaxLines: 1000,
		...overrides,
	};
}

describe("preparePiSettings", () => {
	const tempDirs: string[] = [];
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		vi.unstubAllEnvs();
	});

	it("写入 PI_CODING_AGENT_DIR/settings.json,不写用户全局 ~/.pi/agent/settings.json", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "flower-pi-agent-test-"));
		tempDirs.push(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		const result = preparePiSettings(makeConfig());
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
			retry?: {
				enabled?: boolean;
				maxRetries?: number;
				baseDelayMs?: number;
				provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
			};
		};

		expect(result).toBe(agentDir);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
		expect(settings.retry?.enabled).toBe(true);
		expect(settings.retry?.maxRetries).toBe(3);
		expect(settings.retry?.baseDelayMs).toBe(2000);
		expect(settings.retry?.provider).toEqual({
			timeoutMs: 120000,
			maxRetries: 1,
			maxRetryDelayMs: 15000,
		});
		expect(result).not.toBe(join(homedir(), ".pi", "agent"));
	});

	it("保留已有 settings 的无关字段", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "flower-pi-agent-test-"));
		tempDirs.push(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			`${JSON.stringify({
				defaultProvider: "havefun",
				retry: {
					baseDelayMs: 9000,
					provider: {
						maxRetryDelayMs: 60000,
					},
				},
			})}\n`,
			"utf-8",
		);

		preparePiSettings(makeConfig({ llmRequestTimeoutMs: 30000, llmProviderMaxRetries: 2, llmAgentMaxRetries: 4 }));
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			defaultProvider?: string;
			retry?: { maxRetries?: number; provider?: { timeoutMs?: number; maxRetries?: number } };
		};

		expect(settings.defaultProvider).toBe("havefun");
		expect(settings.retry?.maxRetries).toBe(4);
		expect(settings.retry?.provider?.timeoutMs).toBe(30000);
		expect(settings.retry?.provider?.maxRetries).toBe(2);
	});
});
