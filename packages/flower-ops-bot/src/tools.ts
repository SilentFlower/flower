/**
 * 工具装配
 *
 * 把 @flower-ai/flower-tools-arms 和 @flower-ai/flower-tools-common 提供的工具转成
 * pi-agent-core 直接可用的 AgentTool 数组。
 *
 * pi-agent-core 的 Agent 类期望 AgentTool[],
 * pi-coding-agent 的 ToolDefinition 略有不同(包了一层 render hooks)。
 * 这里需要做一次转换。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	armsGetTraceTool,
	armsListAlertsTool,
	armsQueryLogsTool,
	armsQueryMetricsTool,
} from "@flower-ai/flower-tools-arms";
import { dingtalkDocSearchTool, zentaoSearchTool } from "@flower-ai/flower-tools-common";

/**
 * 构造工具列表
 *
 * @param ctx - 当前请求的上下文(用户身份等)
 * @returns AgentTool[]
 */
export function buildToolList(ctx: { userId: string }): AgentTool<any>[] {
	// 这里可以根据用户权限决定要不要把某些工具放进 list
	// 当前先放全部,鉴权由后续的 tool_call 拦截做
	void ctx;

	// pi-coding-agent 的 ToolDefinition 和 pi-agent-core 的 AgentTool 字段重合度很高,
	// 实际只需要把 execute 拿出来重新包装即可。这里做最小转换。
	return [
		toAgentTool(armsQueryLogsTool),
		toAgentTool(armsQueryMetricsTool),
		toAgentTool(armsListAlertsTool),
		toAgentTool(armsGetTraceTool),
		toAgentTool(zentaoSearchTool),
		toAgentTool(dingtalkDocSearchTool),
	];
}

/**
 * ToolDefinition → AgentTool 的最小转换
 *
 * @remarks pi 不同版本之间字段名可能微调,真实接入时需要根据
 *          实际 pi-agent-core / pi-coding-agent 版本对齐。
 */
// biome-ignore lint/suspicious/noExplicitAny: 跨包类型转换,暂用 any 占位
function toAgentTool(def: any): AgentTool<any> {
	return {
		name: def.name,
		description: def.description,
		parameters: def.parameters,
		execute: def.execute,
	} as AgentTool<any>;
}
