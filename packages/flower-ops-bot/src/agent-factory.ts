/**
 * Agent 工厂 + 工具装配
 *
 * 为每个 conversationId 构造一个 Agent 实例。messages 从 Redis 恢复,
 * 处理完后写回 Redis。
 */

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { streamSimple, type ThinkingBudgets, type ThinkingLevel } from "@earendil-works/pi-ai";
import { buildHavefunModel, getDefaultModel, getDefaultReasoningEffort } from "@flower-ai/flower-providers";
import { OPS_SYSTEM_PROMPT } from "./prompts.js";
import { getSession, saveSession } from "./session-store.js";
import { buildToolList } from "./tools.js";

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
 * 构造 Agent 的输入
 */
export interface AgentFactoryInput {
	conversationId: string;
	userId: string;
	userName: string;
}

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
 * @remarks 当前实现是无缓存的——每个请求新建。如果并发高,
 *          后续可以加 LRU 缓存(注意要正确处理多副本一致性)。
 */
export async function getOrCreateAgent(input: AgentFactoryInput): Promise<AgentInstance> {
	const restored = await getSession(input.conversationId);
	const initialMessages: AgentMessage[] = restored?.messages ?? [];

	const model = pickModel();

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: OPS_SYSTEM_PROMPT,
			tools: buildToolList({ userId: input.userId }),
			messages: initialMessages,
		},
		streamFn: async (model, context, options) => {
			// 从 flower-providers 统一获取该 model 的默认 reasoning effort
			// (env LLM_REASONING_EFFORT 优先,否则 per-model 默认)
			let effort = getDefaultReasoningEffort(model.id);
			// Gemini 边缘 case clamp:
			// pi-ai 0.75.3 `ThinkingBudgets` 类型只有 minimal/low/medium/high 4 键(无 xhigh),
			// 且 google.js 内置 budget 表对 2.5-pro/flash/flash-lite 也只定义到 high。
			// 若运维配 LLM_REASONING_EFFORT=xhigh,gemini 路径 budgetTokens 会落空(undefined),
			// google SDK 行为未定义。这里把 gemini 上的 xhigh 降级到 high,
			// 让其稳定落在 GEMINI_BUDGETS_BY_MODEL 的 high 阶梯。
			if (model.api === "google-generative-ai" && effort === "xhigh") {
				effort = "high";
			}
			// streamSimple.reasoning 类型是 ThinkingLevel(不含 off),"off" 表示不发送 reasoning 字段
			const reasoning: ThinkingLevel | undefined = effort === "off" ? undefined : effort;
			// 仅 Gemini 系列需要显式 thinkingBudgets(Anthropic / OpenAI 走 thinkingLevelMap)
			const thinkingBudgets = GEMINI_BUDGETS_BY_MODEL[model.id];
			return streamSimple(model, context, {
				...options,
				// 与 flower-providers 用同一个 env 来源:LLM_API_KEY
				// pi-agent-core 的 streamSimple 协议要求直接传 apiKey,无法绕开
				apiKey: process.env.LLM_API_KEY ?? "",
				reasoning,
				...(thinkingBudgets ? { thinkingBudgets } : {}),
			});
		},
		sessionId: input.conversationId,
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
