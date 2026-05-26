/**
 * 隔离 pi-coding-agent settings 注入
 *
 * code-reviewer 以 `piMain` CLI 路径运行,provider timeout / retry 只能通过
 * `settings.json` 进入 pi-coding-agent。这里在启动前准备独立 agent 目录,
 * 并通过 `PI_CODING_AGENT_DIR` 指向它,避免污染用户全局 `~/.pi/agent/settings.json`。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewRuntimeConfig } from "./runtime-config.js";

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * 写入 reviewer 需要的 pi retry settings,并返回实际 agent dir
 *
 * @param config reviewer 运行期配置
 * @returns 实际使用的 pi agent dir
 */
export function preparePiSettings(config: ReviewRuntimeConfig): string {
	const agentDir = process.env[PI_AGENT_DIR_ENV]?.trim() || join(tmpdir(), "flower-pi-agent");
	mkdirSync(agentDir, { recursive: true });
	process.env[PI_AGENT_DIR_ENV] = agentDir;

	const settingsPath = join(agentDir, "settings.json");
	const settings = readSettings(settingsPath);
	const retry = isPlainRecord(settings.retry) ? settings.retry : {};
	const provider = isPlainRecord(retry.provider) ? retry.provider : {};

	const nextSettings = {
		...settings,
		retry: {
			...retry,
			enabled: true,
			maxRetries: config.llmAgentMaxRetries,
			baseDelayMs: 2000,
			provider: {
				...provider,
				timeoutMs: config.llmRequestTimeoutMs,
				maxRetries: config.llmProviderMaxRetries,
				maxRetryDelayMs: 15000,
			},
		},
	};
	writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf-8");
	return agentDir;
}

function readSettings(settingsPath: string): Record<string, unknown> {
	try {
		const raw = readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
