/**
 * code-reviewer 运行期配置解析
 *
 * 这些配置用于约束 CI 中的评审边界:
 * - 总评审软超时,必须早于 GitLab job hard timeout
 * - pi/provider 请求 timeout 与有限重试
 * - prompt 层每轮读取预算
 *
 * 解析规则统一为:env 缺失或非法时回退默认值;`FLOWER_REVIEW_TIMEOUT_MS=0` 允许关闭软超时。
 */

/**
 * reviewer 运行期配置
 */
export interface ReviewRuntimeConfig {
	/** 总评审软超时(ms);0 表示关闭 */
	reviewTimeoutMs: number;
	/** LLM provider 单次请求超时(ms) */
	llmRequestTimeoutMs: number;
	/** pi-ai provider 内部最大重试次数 */
	llmProviderMaxRetries: number;
	/** pi-coding-agent agent 级自动重试次数 */
	llmAgentMaxRetries: number;
	/** prompt 约束:每轮最多批量读取多少个代码窗口 */
	contextReadBatchSize: number;
	/** 工具默认读取行数 */
	contextReadDefaultLines: number;
	/** 工具单次最大读取行数 */
	contextReadMaxLines: number;
}

/**
 * 解析完整运行期配置
 *
 * @returns 合并默认值和 `FLOWER_*` env 后的配置对象
 */
export function resolveReviewRuntimeConfig(): ReviewRuntimeConfig {
	return {
		reviewTimeoutMs: resolveReviewTimeoutMs(),
		llmRequestTimeoutMs: resolveLlmRequestTimeoutMs(),
		llmProviderMaxRetries: resolveLlmProviderMaxRetries(),
		llmAgentMaxRetries: resolveLlmAgentMaxRetries(),
		contextReadBatchSize: resolveContextReadBatchSize(),
		contextReadDefaultLines: resolveContextReadDefaultLines(),
		contextReadMaxLines: resolveContextReadMaxLines(),
	};
}

/**
 * 解析总评审软超时(ms)
 *
 * 默认 1080000ms(18 分钟),早于 infra-harness 默认 20 分钟 hard timeout。
 * `FLOWER_REVIEW_TIMEOUT_MS=0` 表示关闭软超时,用于临时回退。
 *
 * @returns soft timeout 毫秒数
 */
export function resolveReviewTimeoutMs(): number {
	return resolvePositiveIntegerEnv("FLOWER_REVIEW_TIMEOUT_MS", 1080000, { allowZero: true });
}

/**
 * 解析 provider 单次请求 timeout(ms)
 *
 * @returns provider timeout 毫秒数
 */
export function resolveLlmRequestTimeoutMs(): number {
	return resolvePositiveIntegerEnv("FLOWER_LLM_REQUEST_TIMEOUT_MS", 120000);
}

/**
 * 解析 provider 内部重试次数
 *
 * @returns provider maxRetries
 */
export function resolveLlmProviderMaxRetries(): number {
	return resolveNonNegativeIntegerEnv("FLOWER_LLM_PROVIDER_MAX_RETRIES", 1);
}

/**
 * 解析 pi agent 级自动重试次数
 *
 * @returns agent maxRetries
 */
export function resolveLlmAgentMaxRetries(): number {
	return resolveNonNegativeIntegerEnv("FLOWER_LLM_AGENT_MAX_RETRIES", 3);
}

/**
 * 解析 prompt 层每轮读取窗口预算
 *
 * @returns 每轮最多读取窗口数
 */
export function resolveContextReadBatchSize(): number {
	return resolvePositiveIntegerEnv("FLOWER_CONTEXT_READ_BATCH_SIZE", 5);
}

/**
 * 解析默认读取行数
 *
 * @returns 未指定行号时默认读取的行数
 */
export function resolveContextReadDefaultLines(): number {
	return resolvePositiveIntegerEnv("FLOWER_CONTEXT_READ_DEFAULT_LINES", 500);
}

/**
 * 解析单次最大读取行数
 *
 * @returns 单次 `gitlab_get_file_content` 最大读取行数
 */
export function resolveContextReadMaxLines(): number {
	return resolvePositiveIntegerEnv("FLOWER_CONTEXT_READ_MAX_LINES", 1000);
}

function resolvePositiveIntegerEnv(name: string, fallback: number, options?: { allowZero?: boolean }): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed === 0 && options?.allowZero) return 0;
	if (parsed <= 0) return fallback;
	return parsed;
}

function resolveNonNegativeIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}
