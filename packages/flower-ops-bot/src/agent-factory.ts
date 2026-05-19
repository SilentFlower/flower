/**
 * Agent 工厂 + 工具装配
 *
 * 为每个 conversationId 构造一个 Agent 实例。messages 从 Redis 恢复,
 * 处理完后写回 Redis。
 */

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import { buildHavefunModel, getDefaultModel } from "@flower-ai/flower-providers";
import { OPS_SYSTEM_PROMPT } from "./prompts.js";
import { getSession, saveSession } from "./session-store.js";
import { buildToolList } from "./tools.js";

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
			return streamSimple(model, context, {
				...options,
				// 与 flower-providers 用同一个 env 来源:LLM_API_KEY
				// pi-agent-core 的 streamSimple 协议要求直接传 apiKey,无法绕开
				apiKey: process.env.LLM_API_KEY ?? "",
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
