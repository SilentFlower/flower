/**
 * GitLab 工具集
 *
 * 仅供 code-reviewer 加载,ops-bot 不应该有写 GitLab 的能力(职责隔离)。
 *
 * 工具命名约定:
 * - get_xxx:只读
 * - post_xxx:写操作(仅 MR 评论,不允许其他写)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { gitlabClient } from "./client.js";

export type { BotComment, GitlabClient, LineCommentInput } from "./client.js";
export { gitlabClient } from "./client.js";

/**
 * 严重程度
 */
const severitySchema = Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("blocker")]);

/**
 * 获取 MR 的 diff
 */
export const gitlabGetMrDiffTool = defineTool({
	name: "gitlab_get_mr_diff",
	label: "获取 MR diff",
	description: "拿到当前 MR 的完整变更 diff(unified format)",
	parameters: Type.Object({}),
	async execute(_id) {
		const { projectId, mrIid } = readEnv();
		const diff = await gitlabClient().getMrDiff(projectId, mrIid);
		return {
			content: [{ type: "text", text: diff }],
			details: { projectId, mrIid },
		};
	},
});

/**
 * 列出 MR 修改的文件
 */
export const gitlabGetMrFilesTool = defineTool({
	name: "gitlab_get_mr_files",
	label: "MR 修改文件列表",
	description: "返回本次 MR 修改的所有文件路径",
	parameters: Type.Object({}),
	async execute(_id) {
		const { projectId, mrIid } = readEnv();
		const files = await gitlabClient().getMrFiles(projectId, mrIid);
		return {
			content: [{ type: "text", text: files.join("\n") }],
			details: { count: files.length },
		};
	},
});

/**
 * 发整体评论(放在 MR 讨论区)
 */
export const gitlabPostCommentTool = defineTool({
	name: "gitlab_post_comment",
	label: "发表整体评论",
	description: "在 MR 的讨论区发表一条整体评论。用于无法绑定到具体行的总结性意见",
	parameters: Type.Object({
		body: Type.String({ description: "评论内容(Markdown)" }),
		severity: severitySchema,
	}),
	async execute(_id, params) {
		const { projectId, mrIid } = readEnv();
		await gitlabClient().postMrComment(projectId, mrIid, params.body, params.severity);
		return {
			content: [{ type: "text", text: "整体评论已发表" }],
			details: { severity: params.severity },
		};
	},
});

/**
 * 发行内评论(绑定到具体文件 + 行号)
 */
export const gitlabPostLineCommentTool = defineTool({
	name: "gitlab_post_line_comment",
	label: "发表行内评论",
	description: "在 MR 的具体文件、具体行号上发表评论。必须传文件路径和行号",
	parameters: Type.Object({
		file: Type.String({ description: "文件路径(相对仓库根)" }),
		line: Type.Number({ description: "行号(变更后的行号)" }),
		body: Type.String({ description: "评论内容(Markdown)" }),
		severity: severitySchema,
	}),
	async execute(_id, params) {
		const { projectId, mrIid } = readEnv();
		await gitlabClient().postMrLineComment(projectId, mrIid, params);
		return {
			content: [{ type: "text", text: `行内评论已发表: ${params.file}:${params.line}` }],
			details: { severity: params.severity, file: params.file, line: params.line },
		};
	},
});

/**
 * 查看 bot 之前在本 MR 上发的评论(避免重复)
 */
export const gitlabGetPreviousReviewTool = defineTool({
	name: "gitlab_get_previous_review",
	label: "查询历史评审",
	description: "查询 bot 在本 MR 上发过的所有评论,用于增量评审避免重复",
	parameters: Type.Object({}),
	async execute(_id) {
		const { projectId, mrIid } = readEnv();
		const comments = await gitlabClient().getBotComments(projectId, mrIid);
		return {
			content: [
				{
					type: "text",
					text: comments.length === 0 ? "无历史评论" : comments.map((c) => `- ${c.file ?? "[整体]"}: ${c.body}`).join("\n"),
				},
			],
			details: { count: comments.length },
		};
	},
});

/**
 * 从环境变量读 CI 注入的项目 / MR 标识
 */
function readEnv(): { projectId: string; mrIid: number } {
	const projectId = process.env.CI_PROJECT_ID;
	const mrIidRaw = process.env.CI_MERGE_REQUEST_IID;
	if (!projectId || !mrIidRaw) {
		throw new Error("CI_PROJECT_ID / CI_MERGE_REQUEST_IID 未设置,gitlab 工具只能在 CI 环境运行");
	}
	const mrIid = Number.parseInt(mrIidRaw, 10);
	if (Number.isNaN(mrIid)) {
		throw new Error(`CI_MERGE_REQUEST_IID 不是合法整数: ${mrIidRaw}`);
	}
	return { projectId, mrIid };
}

/**
 * 一次性注册所有 GitLab 工具
 */
// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI 类型在不同入口下细节略有不同
export function registerGitlabTools(pi: { registerTool: (def: any) => void }): void {
	pi.registerTool(gitlabGetMrDiffTool);
	pi.registerTool(gitlabGetMrFilesTool);
	pi.registerTool(gitlabPostCommentTool);
	pi.registerTool(gitlabPostLineCommentTool);
	pi.registerTool(gitlabGetPreviousReviewTool);
}
