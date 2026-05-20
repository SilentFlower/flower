/**
 * GitLab 工具集
 *
 * 仅供 code-reviewer 加载,ops-bot 不应该有写 GitLab 的能力(职责隔离)。
 *
 * 工具命名约定:
 * - get_xxx:只读
 * - post_xxx:写操作(仅 MR 评论,不允许其他写)
 *
 * severity 词表统一为 `blocker | major | minor`(Phase 2 起,对齐 prompts.ts 模板 + render 函数)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { sanitizeQuickActions } from "@flower-ai/flower-tools-common";
import { gitlabClient } from "./client.js";
import { safeReadFile } from "./safe-read.js";

export type { BotComment, GitlabClient, LineCommentInput, MrFileChange, Severity } from "./client.js";
export { AuthError, FileNotFoundError, gitlabClient, RetryableError } from "./client.js";

/**
 * 严重程度(对齐 render / prompts.ts 词表;LLM tool 入参 schema)
 *
 * - `blocker`:阻塞 MR 合并的严重问题(安全 / 合规 / 明显 bug);run.ts 的 scanForBlockers 凭此 fail pipeline
 * - `major`:重要但非阻塞的问题(性能 / 逻辑缺陷 / 缺关键日志)
 * - `minor`:轻量建议(命名 / 风格 / 可选优化)
 */
const severitySchema = Type.Union([Type.Literal("blocker"), Type.Literal("major"), Type.Literal("minor")]);

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
 *
 * E3 防御纵深:post 前对 body 做 `sanitizeQuickActions`,把 `^/<action>` 行首字符
 * 替换为 `&#47;`,避免 GitLab 把评论解读为 quick action 误触发(如真的 `/approve`
 * 批准 MR)。prompt 硬约束是第一层防御,本 sanitize 是 post-time 兜底,双层保险。
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
		const safeBody = sanitizeQuickActions(params.body);
		await gitlabClient().postMrComment(projectId, mrIid, safeBody, params.severity);
		return {
			content: [{ type: "text", text: "整体评论已发表" }],
			details: { severity: params.severity },
		};
	},
});

/**
 * 发行内评论(绑定到具体文件 + 行号)
 *
 * E3 防御纵深:同 `gitlabPostCommentTool`,post 前 sanitize body 防 quick action 误触发。
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
		const safeBody = sanitizeQuickActions(params.body);
		await gitlabClient().postMrLineComment(projectId, mrIid, { ...params, body: safeBody });
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
 * 拉取任意 ref 的文件原始内容(N1 · LLM 拉真实代码上下文)
 *
 * 用于 LLM 评审时拉变更文件完整内容 + 相关上下文(被改函数实现 / 调用方 / 历史版本)。
 * Prompt 强约束「每文件必读」:对每个变更文件必须先调本工具拉完整内容再评论,
 * 否则会被 `run.ts:scanForBlockers` 拦截为「无依据评论」blocker。
 *
 * 工具内部通过 `safeReadFile` 做两层防护:
 * - **二进制后缀跳过**(`.png` / `.lock` 等)→ 返回 placeholder,不发请求节省 token
 * - **size cap**(env `FLOWER_MAX_FILE_SIZE`,默认 50KB)→ 超出截断 + 加 ⚠️ HTML 注释
 *
 * LLM 永远不会拿到超 50KB 的原始文件,杜绝 context window 被单文件吃掉的情况。
 */
export const gitlabGetFileContentTool = defineTool({
	name: "gitlab_get_file_content",
	label: "拉取文件原始内容",
	description:
		"拉任意 ref 下的文件原始内容(UTF-8 文本)。ref 默认传 MR source HEAD;需要看 target 版本或历史 commit 时可传对应 ref。同一文件多次拉取请自行缓存,避免重复请求。文件超过 50KB 会被截断,二进制 / 锁文件会被跳过。",
	parameters: Type.Object({
		path: Type.String({ description: "仓库内相对路径(如 `internal/auth/sign_verify.go`)" }),
		ref: Type.String({ description: "ref(branch / tag / commit sha)" }),
	}),
	async execute(_id, params) {
		const { projectId } = readEnv();
		try {
			const content = await safeReadFile({ projectId, path: params.path, ref: params.ref });
			const details: { path: string; ref: string; length: number; error?: boolean } = {
				path: params.path,
				ref: params.ref,
				length: content.length,
			};
			return {
				content: [{ type: "text", text: content }],
				details,
			};
		} catch (err) {
			// 把错误以 content 形式返回,LLM 能感知失败并尝试别的 path/ref;
			// 真正鉴权 / 致命错误由上层 runReview 决定是否 abort(本工具不抛)
			const message = err instanceof Error ? err.message : String(err);
			const details: { path: string; ref: string; length: number; error?: boolean } = {
				path: params.path,
				ref: params.ref,
				length: 0,
				error: true,
			};
			return {
				content: [{ type: "text", text: `拉取文件失败:${message}` }],
				details,
			};
		}
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
	pi.registerTool(gitlabGetFileContentTool);
}
