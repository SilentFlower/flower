/**
 * 消息处理主流程
 *
 * - 按 conversationId 维度复用 Agent(每个会话独立的对话历史)
 * - 通过 agent.subscribe() 订阅事件,把文本累积起来推回钉钉
 * - 每轮结束后,把 messages 写回 Redis
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { getOrCreateAgent, persistAgent } from "./agent-factory.js";

/**
 * 处理一条钉钉消息
 */
export interface HandleMessageInput {
	conversationId: string;
	userId: string;
	userName: string;
	text: string;
	/**
	 * 流式输出回调
	 *
	 * @param chunk - 当前累积全文
	 * @param isFinal - 是否最后一次回调
	 */
	onChunk: (chunk: string, isFinal: boolean) => void | Promise<void>;
}

/**
 * 处理一条消息
 */
export async function handleMessage(input: HandleMessageInput): Promise<void> {
	const { agent, dispose } = await getOrCreateAgent({
		conversationId: input.conversationId,
		userId: input.userId,
		userName: input.userName,
	});

	let accumulator = "";

	// 订阅 agent 事件,把文本累积起来推回钉钉
	const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
		if (event.type === "message_update") {
			const delta = extractDelta(event);
			if (delta) {
				accumulator += delta;
				await input.onChunk(accumulator, false);
			}
		} else if (event.type === "message_end") {
			// 一轮 assistant 输出完(后面可能还会调工具继续)
			await input.onChunk(accumulator, false);
		} else if (event.type === "agent_end") {
			// 整个对话流程结束
			await input.onChunk(accumulator, true);
		}
	});

	try {
		await agent.prompt([
			{
				role: "user",
				content: [{ type: "text", text: input.text }],
				timestamp: Date.now(),
			},
		]);

		// 持久化对话历史
		await persistAgent(input.conversationId, agent);
	} finally {
		unsubscribe();
		dispose();
	}
}

/**
 * 从 message_update 事件中提取本次新增的文本
 *
 * @remarks pi-ai 的事件类型在 v0.75 是个 union;这里只关心 text_delta。
 */
// biome-ignore lint/suspicious/noExplicitAny: pi-ai 的事件类型在不同版本结构略有不同
function extractDelta(event: any): string {
	const inner = event?.assistantMessageEvent;
	if (inner?.type === "text_delta") {
		return inner.delta ?? "";
	}
	return "";
}
