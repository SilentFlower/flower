/**
 * Agent 工厂与会话恢复
 *
 * 为每个 conversationId 构造一个 Agent 实例。messages 从 Redis 恢复,
 * 处理完后写回 Redis。
 */

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { hasApi, type ThinkingBudgets, type ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamGemini } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { buildHavefunModel, getDefaultModel, getDefaultReasoningEffort } from "@flower-ai/flower-providers";
import { OPS_SYSTEM_PROMPT } from "./prompts.js";
import { getSession, saveSession } from "./session-store.js";

/**
 * Gemini 系列每个 model 的 thinkingBudgets 阶梯(PRD ADR-4 初版)
 *
 * @remarks pi-ai google.js 不查 `thinkingLevelMap`,而是用 `options.thinkingBudgets`
 *          数字阶梯算实际 budget。这里 hardcode 初版阶梯,实测后可调;
 *          flash-lite 不支持 thinking(reasoning=false),不挂在表上。
 *          PRD Out of Scope:后续可提取到 flower-providers 公开 API,本任务在 streamFn 内 hardcode。
 */
const GEMINI_BUDGETS_BY_MODEL: Record<string, ThinkingBudgets> = {
	"gemini-2.5-pro": { minimal: 1024, low: 4096, medium: 16384, high: 24576 },
	"gemini-2.5-flash": { minimal: 1024, low: 4096, medium: 16384, high: 24576 },
};

/**
 * 工厂返回值
 */
export interface AgentInstance {
	agent: Agent;
	/** 调用后清理临时资源(本实例不再使用) */
	dispose: () => void;
}

/**
 * 根据 conversationId 获取或创建 Agent
 *
 * @param conversationId 钉钉会话标识
 * @returns 已加载该会话历史的 Agent 实例
 * @remarks 当前实现是无缓存的——每个请求新建。如果并发高,
 *          后续可以加 LRU 缓存(注意要正确处理多副本一致性)。
 */
export async function getOrCreateAgent(conversationId: string): Promise<AgentInstance> {
	const restored = await getSession(conversationId);
	const initialMessages: AgentMessage[] = restored?.messages ?? [];

	const model = pickModel();

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: OPS_SYSTEM_PROMPT,
			messages: initialMessages,
		},
		streamFn: (model, context, options) => {
			const effort = getDefaultReasoningEffort(model.id);
			const reasoning: ThinkingLevel | undefined = effort === "off" ? undefined : effort;
			const request = {
				...options,
				// 公开协议入口直接接收请求凭据和 Agent 提供的取消信号。
				apiKey: process.env.LLM_API_KEY,
				reasoning,
			};
			if (hasApi(model, "openai-completions")) return streamCompletions(model, context, request);
			if (hasApi(model, "openai-responses")) return streamResponses(model, context, request);
			if (hasApi(model, "anthropic-messages")) return streamAnthropic(model, context, request);
			if (hasApi(model, "google-generative-ai")) {
				// Gemini 2.5 的自定义预算按最高 high 档传递。
				return streamGemini(model, context, {
					...request,
					reasoning: reasoning === "xhigh" ? "high" : reasoning,
					thinkingBudgets: GEMINI_BUDGETS_BY_MODEL[model.id],
				});
			}
			throw new Error(`不支持的模型协议：${model.api}`);
		},
		sessionId: conversationId,
	});

	return {
		agent,
		dispose: () => {
			// 当前没有需要清理的资源
		},
	};
}

/**
 * 持久化 agent 状态到 Redis
 */
export async function persistAgent(conversationId: string, agent: Agent): Promise<void> {
	await saveSession(conversationId, {
		messages: agent.state.messages,
		updatedAt: Date.now(),
	});
}

/**
 * 选用的模型
 *
 * @remarks 全部通过 `@flower-ai/flower-providers` 统一管理 —
 *          模型清单 / baseUrl / 默认选择均由本进程的 env 配置驱动
 *          (`LLM_PROVIDER` + `LLM_MODEL`)。任何变更只改 flower-providers。
 */
function pickModel() {
	const { provider, modelId } = getDefaultModel();
	return buildHavefunModel(provider, modelId);
}
