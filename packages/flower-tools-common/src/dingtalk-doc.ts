/**
 * 钉钉文档(知识库)集成工具
 *
 * 让 LLM 能在评审 / 运维场景中检索钉钉知识库中的规范、SOP、架构文档。
 *
 * 需配置环境变量:
 *   DINGTALK_APP_KEY    - 钉钉企业内部应用 AppKey
 *   DINGTALK_APP_SECRET - 钉钉企业内部应用 AppSecret
 *
 * 实际调用流程:
 *   1. 用 AppKey + AppSecret 换 accessToken(POST /v1.0/oauth2/accessToken)
 *   2. 用 accessToken 调文档搜索接口(POST /v1.0/doc/spaces/{spaceId}/searchNodes 或全局搜索接口)
 *   3. accessToken 有过期时间,需做缓存
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

/**
 * 钉钉文档搜索工具
 *
 * @remarks 真实实现需要接入钉钉开放平台文档 OpenAPI:
 *          https://open.dingtalk.com/document/orgapp/dingtalk-document
 *          注意:accessToken 要缓存(2 小时有效),否则会触发限流。
 */
export const dingtalkDocSearchTool = defineTool({
	name: "dingtalk_doc_search",
	label: "钉钉文档搜索",
	description:
		"在钉钉知识库 / 文档中搜索内容。可限定某个知识库空间,或全局搜索整个企业的文档",
	parameters: Type.Object({
		query: Type.String({ description: "搜索关键词" }),
		spaceId: Type.Optional(
			Type.String({ description: "限定钉钉知识库空间 ID(可选,不填则全局搜)" }),
		),
		limit: Type.Optional(Type.Number({ description: "返回数量,默认 10" })),
	}),
	async execute(_id, params, _signal) {
		// TODO: 接入钉钉文档 OpenAPI(先换 accessToken,再调搜索接口)
		const summary = [
			"[Stub] dingtalk_doc_search",
			`  query=${params.query}`,
			`  spaceId=${params.spaceId ?? "global"}`,
			`  limit=${params.limit ?? 10}`,
			"实际接入后会返回:文档标题、所在空间、最近修改人、内容片段、链接。",
		].join("\n");
		return {
			content: [{ type: "text", text: summary }],
			details: undefined,
		};
	},
});
