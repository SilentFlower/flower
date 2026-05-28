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
import { assertAllowedGroup, assertAllowedProject, normalizeGroupPath, normalizeProjectPath } from "./workspace.js";

export type {
	BotComment,
	GitlabBranchSummary,
	GitlabClient,
	GitlabProjectSummary,
	LineCommentInput,
	LineCommentResult,
	MrFileChange,
	Severity,
} from "./client.js";
export { AuthError, collectCommentableNewLines, FileNotFoundError, gitlabClient, RetryableError } from "./client.js";
export type { PreparedProjectWorkspace, PrepareProjectWorkspaceInput } from "./workspace.js";

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
		const result = await gitlabClient().postMrLineComment(projectId, mrIid, { ...params, body: safeBody });
		const details: {
			severity: typeof params.severity;
			file: string;
			line: number;
			posted: typeof result.posted;
			reason: string | undefined;
		} = {
			severity: params.severity,
			file: params.file,
			line: params.line,
			posted: result.posted,
			reason: result.reason,
		};
		if (result.posted === "note_fallback") {
			return {
				content: [
					{
						type: "text",
						text: `目标行不可行内评论,已降级发表整体评论: ${params.file}:${params.line}`,
					},
				],
				details,
			};
		}
		return {
			content: [{ type: "text", text: `行内评论已发表: ${params.file}:${params.line}` }],
			details,
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
 * 拉取任意 ref 的文件行窗(N1 · LLM 拉真实代码上下文)
 *
 * 用于 LLM 评审时拉变更行附近上下文(被改函数实现 / 调用方 / 历史版本)。
 * Prompt 强约束「评论前必读」:对某文件发出行内评论前必须先调本工具读取相关行窗,
 * 否则会被 `run.ts:scanForBlockers` 拦截为「无依据评论」blocker。
 *
 * 工具内部通过 `safeReadFile` 做两层防护:
 * - **二进制后缀跳过**(`.png` / `.lock` 等)→ 返回 placeholder,不发请求节省 token
 * - **行窗读取**(默认 500 行,单次最多 1000 行)→ 未取够时按返回提示续读
 * - **size cap**(env `FLOWER_MAX_FILE_SIZE`,默认 50KB)→ 超出截断 + 加 ⚠️ HTML 注释
 *
 * LLM 永远不会默认拿到整份大文件,杜绝 context window 被单文件吃掉的情况。
 */
export const gitlabGetFileContentTool = defineTool({
	name: "gitlab_get_file_content",
	label: "拉取文件行窗",
	description:
		"拉任意 ref 下的文件行窗(UTF-8 文本)。默认返回 1-500 行;可传 startLine/endLine 读取指定 1-based 闭区间,单次最多 1000 行,未取够时按返回的续读提示读取下一段。`ref` 可省略 — 省略 / 空字符串 / `'HEAD'` 时自动兜底到当前 MR 的 source branch(`CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`),覆盖大多数评审场景;看 target 版本或历史 commit 时显式传对应 ref。**不要传字面 'HEAD'**:GitLab REST API 不识别该别名,会被解析为 default branch。文件窗口超过 50KB 会被截断,二进制 / 锁文件会被跳过。",
	parameters: Type.Object({
		path: Type.String({ description: "仓库内相对路径(如 `internal/auth/sign_verify.go`)" }),
		ref: Type.Optional(
			Type.String({
				description:
					"ref(branch / tag / commit sha)。省略时自动兜底到当前 MR 的 source branch;**不要**传 'HEAD' 或空字符串(会触发兜底,但属于不规范输入)",
			}),
		),
		startLine: Type.Optional(Type.Number({ description: "起始行号(1-based,闭区间);不传时从第 1 行开始" })),
		endLine: Type.Optional(Type.Number({ description: "结束行号(1-based,闭区间);不传时默认读取 500 行" })),
	}),
	async execute(_id, params) {
		const { projectId } = readEnv();
		// 先归一化 ref:兜底 source branch / 透传显式 ref / 无 CI env 时抛中文错误(由 catch 包成 content 返回 LLM)
		let ref: string;
		try {
			ref = normalizeRef(params.ref);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `拉取文件失败:${message}` }],
				details: { path: params.path, ref: params.ref ?? "(missing)", length: 0, error: true },
			};
		}
		try {
			const content = await safeReadFile({
				projectId,
				path: params.path,
				ref,
				startLine: params.startLine,
				endLine: params.endLine,
			});
			const details: {
				path: string;
				ref: string;
				startLine?: number;
				endLine?: number;
				length: number;
				error?: boolean;
			} = {
				path: params.path,
				ref,
				...(params.startLine !== undefined ? { startLine: params.startLine } : {}),
				...(params.endLine !== undefined ? { endLine: params.endLine } : {}),
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
			const details: {
				path: string;
				ref: string;
				startLine?: number;
				endLine?: number;
				length: number;
				error?: boolean;
			} = {
				path: params.path,
				ref,
				...(params.startLine !== undefined ? { startLine: params.startLine } : {}),
				...(params.endLine !== undefined ? { endLine: params.endLine } : {}),
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
 * 列出允许范围内的 GitLab group 项目。
 *
 * 用于 reviewer 在需要跨项目业务上下文时发现同组 harness / UI / 服务仓库。
 * 工具只读 GitLab API,不会 clone 仓库。
 */
export const gitlabListGroupProjectsTool = defineTool({
	name: "gitlab_list_group_projects",
	label: "列出 GitLab group 项目",
	description:
		"列出允许 namespace 下 GitLab group 的项目摘要。用于需要跨项目上下文时发现 harness/UI/服务仓库。只读 API,不会 clone 仓库;项目必须在 FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES 或当前 CI namespace 允许范围内。",
	parameters: Type.Object({
		group: Type.String({ description: "GitLab group 路径,例如 `digital-biz-projects/iqs`" }),
		includeSubgroups: Type.Optional(Type.Boolean({ description: "是否包含子 group 项目,默认 true" })),
		search: Type.Optional(Type.String({ description: "可选项目名搜索词,例如 `harness`" })),
	}),
	async execute(_id, params) {
		const group = normalizeGroupPath(params.group);
		assertAllowedGroup(group);
		const projects = await gitlabClient().listGroupProjects(group, {
			includeSubgroups: params.includeSubgroups,
			search: params.search,
		});
		const text =
			projects.length === 0
				? "未找到项目"
				: projects
						.map(
							(project) =>
								`${project.id}\t${project.path_with_namespace}\t${project.default_branch ?? "(no default branch)"}\t${project.web_url ?? ""}`,
						)
						.join("\n");
		return {
			content: [{ type: "text", text }],
			details: { count: projects.length, group },
		};
	},
});

/**
 * 列出允许范围内项目的分支。
 *
 * 用于 reviewer 在准备 harness 工作区前确认版本分支是否存在。
 */
export const gitlabListProjectBranchesTool = defineTool({
	name: "gitlab_list_project_branches",
	label: "列出 GitLab 项目分支",
	description:
		"列出允许项目的分支摘要。用于准备跨项目文档工作区前确认 ref,例如 harness 是否存在 `v1.4` 分支。只读 API,不会 clone 仓库。",
	parameters: Type.Object({
		project: Type.String({ description: "GitLab 项目路径,例如 `digital-biz-projects/iqs/iqs-harness`" }),
		search: Type.Optional(Type.String({ description: "可选分支搜索词,例如 `v1.4`" })),
	}),
	async execute(_id, params) {
		const project = normalizeProjectPath(params.project);
		assertAllowedProject(project);
		const branches = await gitlabClient().listProjectBranches(project, { search: params.search });
		const text =
			branches.length === 0
				? "未找到分支"
				: branches
						.map(
							(branch) =>
								`${branch.name}\tdefault=${branch.default}\tprotected=${branch.protected}\tcommit=${branch.commit_short_id ?? ""}\t${branch.committed_date ?? ""}\t${branch.title ?? ""}`,
						)
						.join("\n");
		return {
			content: [{ type: "text", text }],
			details: { count: branches.length, project },
		};
	},
});

/**
 * 按需准备允许项目的本地只读工作区。
 *
 * 工具会 shallow fetch 指定 ref 到固定临时目录,返回路径后 reviewer 应继续用 `bash` + `rg`
 * 搜索该路径。token 只在工具内部传递给 git,不会出现在返回值中。
 */
export const gitlabPrepareProjectWorkspaceTool = defineTool({
	name: "gitlab_prepare_project_workspace",
	label: "准备跨项目本地工作区",
	description:
		"按需把允许项目的指定 ref shallow fetch 到固定本地目录,返回可用 `rg` 搜索的路径和实际 commit。用于读取 harness 等权威业务文档;不会在 job 启动时无条件 clone,也不会返回 token。",
	parameters: Type.Object({
		project: Type.String({ description: "GitLab 项目路径,例如 `digital-biz-projects/iqs/iqs-harness`" }),
		ref: Type.String({ description: "branch / tag / commit sha,例如 `master` 或 `v1.4`" }),
		alias: Type.String({ description: "本地目录别名,例如 `iqs-harness`;只能包含安全字符" }),
		depth: Type.Optional(Type.Number({ description: "shallow fetch depth,默认 1,最大 100" })),
	}),
	async execute(_id, params) {
		const project = normalizeProjectPath(params.project);
		assertAllowedProject(project);
		const workspace = await gitlabClient().prepareProjectWorkspace({
			project,
			ref: params.ref,
			alias: params.alias,
			depth: params.depth,
		});
		const text = [
			`path: ${workspace.path}`,
			`project: ${workspace.project}`,
			`ref: ${workspace.ref}`,
			`commit: ${workspace.commit}`,
			`reused: ${workspace.reused}`,
		].join("\n");
		return {
			content: [{ type: "text", text }],
			details: workspace,
		};
	},
});

/**
 * 归一化 LLM 传入的 ref 参数
 *
 * **背景**:LLM 受 git CLI 习惯影响常传 `"HEAD"`,GitLab REST API 不识别该别名,
 * 会被解析为 default branch(若 MR source 文件在 default branch 还不存在 → HTTP 404)。
 * 此外 LLM 在反复试错时也会出现 `""` / 不传 ref → tool schema 校验失败 / 4xx。
 * 工具层兜底比 prompt 教育更稳:无副作用工具直接接受 LLM 的偷懒输入。
 *
 * 规则:
 * - `undefined` / 空字符串 / `"HEAD"` → 兜底到 `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`(MR 评审主路径)
 * - 真实 ref(branch / tag / sha)→ 透传
 * - 兜底场景无 CI env(本地调试)→ 抛中文 Error,提示显式传 ref
 *
 * @param rawRef LLM 传入的 ref 参数原值
 * @returns 归一化后的 ref(非空字符串)
 * @throws 当需要兜底但 CI env 缺失时抛 Error(由 tool execute catch 包成 LLM 可读 content)
 */
export function normalizeRef(rawRef: string | undefined): string {
	const trimmed = rawRef?.trim();
	if (!trimmed || trimmed === "HEAD") {
		const sourceBranch = process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME?.trim();
		if (sourceBranch) {
			// 仅当 LLM 显式传 "HEAD" / 空字符串(已学到的反模式)时 warn 教育别这么干;
			// rawRef === undefined(完全不传)是新 prompt 教育后的预期默认行为,无声兜底,避免 trace 噪音。
			if (rawRef !== undefined) {
				console.warn(
					`[gitlab_get_file_content] ref="${rawRef}" 自动兜底到 source branch "${sourceBranch}";后续请省略 ref 或传具体分支名`,
				);
			}
			return sourceBranch;
		}
		throw new Error(
			`ref 缺失或为 "HEAD" / 空字符串,且环境变量 CI_MERGE_REQUEST_SOURCE_BRANCH_NAME 未设置无法兜底。请显式传 ref(branch / tag / commit sha)。`,
		);
	}
	return trimmed;
}

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
	pi.registerTool(gitlabListGroupProjectsTool);
	pi.registerTool(gitlabListProjectBranchesTool);
	pi.registerTool(gitlabPrepareProjectWorkspaceTool);
}
