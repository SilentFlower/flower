/**
 * 自定义 LLM provider 统一注册
 *
 * 两个产品(code-reviewer / ops-bot)都通过本包接入目标 LLM 网关
 * (自部署 vLLM / 内部 AI Gateway / 第三方 OpenAI 兼容服务),
 * 任何 baseUrl / 模型清单 / header 的变更都只需要改这一处。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 允许使用的模型清单(占位)
 *
 * @remarks 真实的模型 id 和参数需要替换为目标 LLM 网关实际支持的值。
 *          字段含义见 pi-ai 的 Model 类型。
 */
const CUSTOM_MODELS = [
	{
		id: "company-gpt-4",
		name: "Custom GPT-4",
		reasoning: false,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	},
	{
		id: "company-gpt-4-mini",
		name: "Custom GPT-4 Mini",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
		maxTokens: 4096,
	},
];

/**
 * 注册自定义 LLM provider 到 pi
 *
 * @param pi - pi 扩展 API
 * @param options - 注册选项
 * @param options.appSource - 标记请求来自哪个产品,用于审计与计费(code-reviewer / ops-bot)
 */
export function registerCompanyProviders(
	pi: ExtensionAPI,
	options: { appSource: string },
): void {
	const baseUrl = process.env.COMPANY_LLM_BASE_URL;
	const apiKey = process.env.COMPANY_AI_TOKEN;

	if (!baseUrl) {
		throw new Error("COMPANY_LLM_BASE_URL 环境变量未配置");
	}
	if (!apiKey) {
		throw new Error("COMPANY_AI_TOKEN 环境变量未配置");
	}

	pi.registerProvider("company", {
		baseUrl,
		apiKey: "COMPANY_AI_TOKEN",
		api: "openai-completions",
		// biome-ignore lint/suspicious/noExplicitAny: pi 的 Model 类型在自定义 provider 上较宽松
		models: CUSTOM_MODELS as any,
		headers: {
			"X-App-Source": options.appSource,
		},
	});
}

/**
 * 默认模型选择策略
 *
 * - code-reviewer 这种代码任务,优先选大模型
 * - ops-bot 简单查询用 mini,复杂分析用大模型(后续可做动态分流)
 */
export function getDefaultModelId(appSource: string): string {
	if (appSource === "code-reviewer") {
		return "company-gpt-4";
	}
	return "company-gpt-4-mini";
}
