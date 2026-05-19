/**
 * 跨产品复用的通用工具
 *
 * 目前仅包含 Stub 实现,作为后续填充的样板。
 * 真实工具需要根据具体的内部 / 第三方 API 完成。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

/**
 * 占位:Jira 查询工具
 *
 * @remarks 用于让 LLM 在评审或运维场景中关联 issue。
 *          真实实现需要接入 Jira / 工单系统的 REST API。
 */
export const jiraSearchTool = defineTool({
	name: "jira_search",
	label: "Jira 搜索",
	description: "在 Jira 中搜索 issue。支持 JQL 语法",
	parameters: Type.Object({
		query: Type.String({ description: "JQL 查询语句" }),
		limit: Type.Optional(Type.Number({ description: "返回数量,默认 10" })),
	}),
	async execute(_id, params) {
		// TODO: 接入 Jira API
		return {
			content: [
				{
					type: "text",
					text: `[Stub] Jira 查询: ${params.query}\n实际接入后会返回真实结果。`,
				},
			],
		};
	},
});

/**
 * 占位:Wiki / 内部文档检索工具
 *
 * @remarks 用于让 LLM 引用内部规范、SOP、架构文档。
 *          真实实现需要接入 Confluence / 飞书文档 / 内部知识库。
 */
export const wikiSearchTool = defineTool({
	name: "wiki_search",
	label: "Wiki 检索",
	description: "在 Wiki / 内部文档中检索",
	parameters: Type.Object({
		query: Type.String({ description: "搜索关键词" }),
		space: Type.Optional(Type.String({ description: "限定 Wiki 空间名" })),
	}),
	async execute(_id, params) {
		// TODO: 接入 Wiki / 文档系统 API
		return {
			content: [
				{
					type: "text",
					text: `[Stub] Wiki 检索: ${params.query}`,
				},
			],
		};
	},
});

/**
 * 一次性注册所有通用工具
 */
// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI 类型在不同入口下细节略有不同
export function registerCommonTools(pi: {
	registerTool: (def: any) => void;
}): void {
	pi.registerTool(jiraSearchTool);
	pi.registerTool(wikiSearchTool);
}
