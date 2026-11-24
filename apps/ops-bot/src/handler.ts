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
	const { agent, dispose } = await getOrCreateAgent(input.conversationId);

	let accumulator = "";
	let modelFailure: string | undefined;

	// 订阅 agent 事件,把文本累积起来推回钉钉
	const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta" && update.delta) {
				accumulator += update.delta;
				await input.onChunk(accumulator, false);
			}
		} else if (event.type === "message_end" && accumulator) {
			// 一轮模型输出结束，发送当前累积全文
			await input.onChunk(accumulator, false);
		} else if (event.type === "agent_end") {
			const message = event.messages.at(-1);
			if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
				// pi 可通过终止消息报告失败，交回 webhook 的失败回复入口。
				modelFailure = message.stopReason === "aborted" ? "模型请求已取消" : "模型请求失败";
			} else {
				await input.onChunk(accumulator, true);
			}
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
		if (modelFailure) throw new Error(modelFailure);

		// 持久化对话历史
		await persistAgent(input.conversationId, agent);
	} finally {
		unsubscribe();
		dispose();
	}
}
