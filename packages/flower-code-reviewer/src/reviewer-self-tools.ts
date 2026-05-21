/**
 * Reviewer 自审工具集(`reviewer_*` 命名空间)
 *
 * 与 `gitlab_*` 工具的本质区别:
 * - **不发外部 API 请求**,只读评审本地 trace(`review-trace.ts` 单例)
 * - 命名空间 `reviewer_*` 表明"评审专用元工具",避免误以为会调 GitLab
 *
 * 当前工具:
 * - `reviewer_list_my_blockers`:返回本轮 LLM 已通过 `gitlab_post_line_comment` 发出的
 *   **blocker 级**行内评论列表,供 walkthrough alert 块 N + 列表照抄真值,避免靠记忆概括出错
 *
 * 未来若有同类"评审 trace 元数据查询"需求,沿用 `reviewer_*` 前缀。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getTrace } from "./review-trace.js";

/**
 * 列出本轮已发的 blocker 级行内评论
 *
 * 数据从评审本地 trace 内存中读,**不发 GitLab API 请求**。
 * 用法:在写 walkthrough 整体评论之前调用,拿到本轮 blocker 真值,
 * 然后在 walkthrough 顶部 alert 块**逐条照抄** `path:line — title`,
 * 避免靠对话记忆概括出错(stress test 实测 LLM 长上下文里靠记忆数会丢条)。
 */
export const reviewerListMyBlockersTool = defineTool({
	name: "reviewer_list_my_blockers",
	label: "列出本轮已发的 blocker",
	description: [
		"返回本轮你已通过 `gitlab_post_line_comment` 发出的 **blocker 级**行内评论列表。",
		"数据从评审本地 trace 内存中读,**不发 GitLab API 请求**。",
		"用法:在写 walkthrough 整体评论之前调用,拿到本轮 blocker 真值,",
		"然后在 walkthrough 顶部 alert 块**逐条照抄** `path:line — title`,",
		"避免靠对话记忆概括出错。",
		"返回结构:`{ count: number, blockers: [{path, line, title}] }`(JSON 文本)",
	].join("\n"),
	parameters: Type.Object({}),
	async execute(_id) {
		const trace = getTrace();
		const blockers = trace.lineComments
			.filter((c) => c.severity === "blocker")
			.map((c) => ({ path: c.file, line: c.line, title: c.title }));
		const payload = { count: blockers.length, blockers };
		return {
			content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			details: { count: blockers.length },
		};
	},
});

/**
 * 一次性注册 reviewer 自审工具集
 *
 * @param pi pi 扩展 API(只需 `registerTool` 方法,与 `registerGitlabTools` 风格对齐)
 */
// biome-ignore lint/suspicious/noExplicitAny: defineTool 返回类型与 ExtensionAPI 在不同入口下细节略有不同
export function registerReviewerSelfTools(pi: { registerTool: (def: any) => void }): void {
	pi.registerTool(reviewerListMyBlockersTool);
}
