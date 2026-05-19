/**
 * 禅道(ZenTao)集成工具
 *
 * 禅道是国内常用的项目管理系统(类 Jira)。本工具让 LLM 能在评审 / 运维场景中
 * 关联 bug / 任务 / 需求。
 *
 * 需配置环境变量:
 *   ZENTAO_BASE_URL - 禅道实例地址,例如 https://zentao.corp.internal
 *   ZENTAO_TOKEN    - 禅道 PAT 或 API token
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

/**
 * 禅道支持的对象类型
 */
const zentaoEntityType = Type.Union(
	[
		Type.Literal("bug"),
		Type.Literal("task"),
		Type.Literal("story"),
		Type.Literal("case"),
	],
	{ description: "限定对象类型:bug(缺陷)/ task(任务)/ story(需求)/ case(用例)" },
);

/**
 * 禅道搜索工具
 *
 * @remarks 真实实现需要接入禅道 REST API:
 *          - GET {baseUrl}/api.php/v1/{type}s?keywords=...&status=...
 *          - 或 GET {baseUrl}/api.php/v1/search 全局搜索
 *          注意鉴权:禅道 v17+ 支持 Token,旧版本需用 session 流。
 */
export const zentaoSearchTool = defineTool({
	name: "zentao_search",
	label: "禅道搜索",
	description: "在禅道中搜索 bug / 任务 / 需求 / 用例。支持按关键词、产品、状态过滤",
	parameters: Type.Object({
		query: Type.String({ description: "搜索关键词,匹配标题与描述" }),
		type: Type.Optional(zentaoEntityType),
		product: Type.Optional(Type.Number({ description: "限定产品 ID(数字),不填则全局搜索" })),
		status: Type.Optional(
			Type.String({
				description: "限定状态:active / closed / resolved / pause 等,具体取值看禅道配置",
			}),
		),
		limit: Type.Optional(Type.Number({ description: "返回数量,默认 10" })),
	}),
	async execute(_id, params, _signal) {
		// TODO: 接入禅道 REST API
		const summary = [
			`[Stub] zentao_search`,
			`  query=${params.query}`,
			`  type=${params.type ?? "all"}`,
			`  product=${params.product ?? "all"}`,
			`  status=${params.status ?? "all"}`,
			`  limit=${params.limit ?? 10}`,
			"实际接入后会返回真实记录列表(标题、ID、负责人、状态、链接)。",
		].join("\n");
		return {
			content: [{ type: "text", text: summary }],
			details: undefined,
		};
	},
});
