/**
 * GitLab REST API 轻量客户端
 *
 * 故意不引入 @gitbeaker/rest 之类的重型 SDK,因为我们只用 5-6 个 endpoint,
 * 自己包一层更可控、二进制更小、错误信息更清晰。
 *
 * 设计要点:
 * - **PRIVATE-TOKEN** header 鉴权(GitLab 标准,而非 Bearer)
 * - **encodeURIComponent(projectId)**:group path 含 `/`,必须 encode(如 `digital-independent-projects/srm-esign`)
 * - 错误信息含 HTTP code + 响应体前 200 字符(便于排错,防 token / 内部信息全量泄漏)
 * - 10s 超时
 * - 5xx + 网络错误**重试 1 次**(sleep 2s);429 不重试(限流意味着配额耗尽,继续重试火上浇油)
 * - **severity marker**:仅 blocker 自动写入 `<!-- severity: blocker -->` HTML 注释,用户视图不显示
 * - **severity 词表**`blocker | major | minor`(对齐 prompts.ts 模板 + render 函数;
 *   Phase 2 起统一,旧的 `info | warning` 已下线)
 * - **changes 内部缓存** per-MR(复用 diff_refs 与变更文件 diff,避免每次发评论都拉 changes)
 * - **bot username 自查**:通过 `GET /api/v4/user` 一次 + 缓存,避免硬编码 env
 * - **gitlab_get_file_content**(N1):拉任意 ref 的文件原始内容,供 LLM 拿真实代码上下文
 */

import {
	type PreparedProjectWorkspace,
	type PrepareProjectWorkspaceInput,
	prepareProjectWorkspace,
} from "./workspace.js";

/**
 * 严重程度(对齐 prompts.ts 模板与 render 函数词表)
 *
 * - `blocker`:阻塞 MR 合并(安全 / 合规 / 明显 bug);run.ts `scanForBlockers` 凭此 fail pipeline
 * - `major`:重要但非阻塞(性能 / 逻辑缺陷 / 缺关键日志)
 * - `minor`:轻量建议(命名 / 风格 / 可选优化)
 */
export type Severity = "blocker" | "major" | "minor";

/**
 * 行内评论参数
 */
export interface LineCommentInput {
	file: string;
	line: number;
	body: string;
	severity: Severity;
}

/**
 * 行内评论发表结果。
 */
export interface LineCommentResult {
	/** 实际发表位置:`line` 表示行内评论,`note_fallback` 表示降级为整体评论 */
	posted: "line" | "note_fallback";
	/** 降级原因,仅 `posted === "note_fallback"` 时存在 */
	reason?: string | undefined;
	/** LLM 原计划评论的新文件行号 */
	originalLine?: number | undefined;
	/** 实际挂载的新文件行号;仅行内评论成功时存在 */
	actualLine?: number | undefined;
	/** 是否由工具自动从原目标行重定位到最近可评论行 */
	relocated?: boolean | undefined;
}

/**
 * 单个变更文件的元数据(用于 E2 churn 排序 / cap)
 */
export interface MrFileChange {
	/** 文件路径(deleted_file 取 old_path,否则取 new_path) */
	path: string;
	/** 新增行数(diff 中以 `+` 起头但非 `+++` 文件头) */
	additions: number;
	/** 删除行数(diff 中以 `-` 起头但非 `---` 文件头) */
	deletions: number;
}

/**
 * 之前的 bot 评论记录
 */
export interface BotComment {
	id: number;
	body: string;
	file: string | undefined;
	line: number | undefined;
}

/**
 * GitLab 项目摘要。
 */
export interface GitlabProjectSummary {
	id: number;
	path_with_namespace: string;
	default_branch: string | undefined;
	web_url: string | undefined;
}

/**
 * GitLab 分支摘要。
 */
export interface GitlabBranchSummary {
	name: string;
	default: boolean;
	protected: boolean;
	commit_short_id: string | undefined;
	committed_date: string | undefined;
	title: string | undefined;
}

/**
 * GitLab 客户端
 */
export interface GitlabClient {
	getMrDiff(projectId: string, mrIid: number): Promise<string>;
	getMrFiles(projectId: string, mrIid: number): Promise<string[]>;
	/**
	 * 列出 MR 变更文件 + 每个文件的 churn(+/- 行数,用于 E2 cap 排序)
	 *
	 * 不需要重新请求 `/changes`,内部复用 changes 缓存机制(同 MR 多次调用走缓存)。
	 */
	getMrFileChanges(projectId: string, mrIid: number): Promise<MrFileChange[]>;
	postMrComment(projectId: string, mrIid: number, body: string, severity: Severity): Promise<void>;
	postMrLineComment(projectId: string, mrIid: number, input: LineCommentInput): Promise<LineCommentResult>;
	getBotComments(projectId: string, mrIid: number): Promise<BotComment[]>;
	/**
	 * 列出指定 group 下的项目摘要。
	 *
	 * @param group GitLab group 路径
	 * @param options.includeSubgroups 是否包含子 group
	 * @param options.search 可选项目名搜索词
	 * @returns 项目摘要列表
	 */
	listGroupProjects(
		group: string,
		options?: { includeSubgroups?: boolean | undefined; search?: string | undefined },
	): Promise<GitlabProjectSummary[]>;
	/**
	 * 列出指定项目的分支摘要。
	 *
	 * @param project GitLab 项目路径或 ID
	 * @param options.search 可选分支搜索词
	 * @returns 分支摘要列表
	 */
	listProjectBranches(project: string, options?: { search?: string | undefined }): Promise<GitlabBranchSummary[]>;
	/**
	 * 准备跨项目只读本地工作区。
	 *
	 * @param input 工作区准备参数
	 * @returns 本地路径与实际 commit
	 */
	prepareProjectWorkspace(input: PrepareProjectWorkspaceInput): Promise<PreparedProjectWorkspace>;
	/**
	 * 拉任意 ref 下的文件原始内容(N1 · LLM 拉真实代码上下文)
	 *
	 * 用于 LLM 评审时拉变更文件相关行窗 + 上下文(被改函数实现 / 调用方 / 历史版本)。
	 * `path` 不需要预先 encode,client 内部统一 encodeURIComponent。
	 *
	 * @param projectId 项目 ID(数字或 namespace/path 形式)
	 * @param path 仓库内相对路径(如 `internal/auth/sign_verify.go`)
	 * @param ref 任意 ref(branch / tag / commit sha)
	 * @returns 文件原始文本(UTF-8;二进制由调用方判断后跳过)
	 * @throws `FileNotFoundError` 当 404 时(`path` 不存在或 `ref` 不存在);不重试
	 * @throws `AuthError` 当 401 / 403 时;整个评审应该 abort
	 * @throws Error(含 HTTP code + 响应片段)其他 4xx;`RetryableError` 当 5xx 时
	 */
	getFileContent(projectId: string, path: string, ref: string): Promise<string>;
}

/**
 * 文件未找到错误(404):path 不存在或 ref 不存在
 *
 * client 内部明确不重试 —— 404 是确定性结果,重试也没意义。
 */
export class FileNotFoundError extends Error {
	override readonly name = "FileNotFoundError";
}

/**
 * 鉴权错误(401 / 403):token 过期或权限不足
 *
 * 评审上层应当 abort,而不是 retry。
 */
export class AuthError extends Error {
	override readonly name = "AuthError";
}

/**
 * 可重试错误(5xx):服务端瞬时故障
 *
 * client 内部已经做了 1 次重试;若仍失败,抛该错误让上层决定是否继续。
 */
export class RetryableError extends Error {
	override readonly name = "RetryableError";
}

/**
 * MR 的 diff_refs(行内评论 position 必填)
 *
 * @internal
 */
interface DiffRefs {
	base_sha: string;
	start_sha: string;
	head_sha: string;
}

/**
 * GitLab API 返回的单条 change 项
 *
 * @internal
 */
interface ChangeItem {
	new_path: string;
	old_path: string;
	new_file: boolean;
	deleted_file: boolean;
	diff: string;
}

/**
 * `/changes` 接口的响应体形状
 *
 * @internal
 */
interface ChangesResponse {
	diff_refs: DiffRefs;
	changes: ChangeItem[];
}

/**
 * notes 接口返回的单条评论
 *
 * @internal
 */
interface NoteItem {
	id: number;
	body: string;
	author: { username: string };
	position?: { new_path?: string; new_line?: number };
}

interface ProjectItem {
	id: number;
	path_with_namespace?: string;
	default_branch?: string;
	web_url?: string;
}

interface BranchItem {
	name: string;
	default?: boolean;
	protected?: boolean;
	commit?: {
		short_id?: string;
		committed_date?: string;
		title?: string;
	};
}

/**
 * MR diff 中可用于 `new_line` 的行。
 *
 * @internal
 */
interface CommentableLine {
	line: number;
	kind: "add" | "context";
}

/**
 * 距离原目标行多远以内允许自动重定位。
 *
 * 该值只覆盖同一小段 hunk 附近的模型行号漂移,避免把评论挂到明显无关的位置。
 *
 * @internal
 */
const LINE_RELOCATION_MAX_DISTANCE = 12;

let cachedClient: GitlabClient | undefined;

/**
 * 获取(或惰性创建)GitLab 客户端
 *
 * 依赖 env:
 * - `GITLAB_TOKEN`(必填):有 `api` scope 的 PAT
 * - `GITLAB_HOST`(可选,默认 `https://gitlab.com`):实例地址
 *
 * @throws 当 `GITLAB_TOKEN` 未设置时抛错(fail-fast)
 */
export function gitlabClient(): GitlabClient {
	if (cachedClient) return cachedClient;
	const host = process.env.GITLAB_HOST ?? "https://gitlab.com";
	const token = process.env.GITLAB_TOKEN;
	if (!token) {
		throw new Error("GITLAB_TOKEN 环境变量未设置");
	}
	cachedClient = createRealClient(host, token);
	return cachedClient;
}

/**
 * 仅供单元测试重置模块级缓存
 *
 * @internal
 */
export function _resetClientForTests(): void {
	cachedClient = undefined;
}

/**
 * GitLab REST fetch helper
 *
 * 统一鉴权、超时、错误处理、5xx 重试。
 *
 * 错误分类(在 `classifyError=true` 时启用,默认 false 保持向后兼容):
 * - 401 / 403 → `AuthError`
 * - 404 → `FileNotFoundError`(语义:resource 不存在)
 * - 5xx 重试 1 次仍失败 → `RetryableError`
 *
 * 默认(classifyError=false)所有非 2xx → 普通 `Error`,信息含 HTTP code + 响应体前 200 字符。
 *
 * @param host GitLab host(如 `http://gitlab.xhgjdev.com`)
 * @param token PAT
 * @param path API 路径(以 `/api/v4/...` 起头)
 * @param init fetch RequestInit
 * @param options.classifyError 是否启用类型化错误分类(默认 false)
 * @returns 已通过 `resp.ok` 校验的 Response
 *
 * @internal
 */
async function gitlabFetch(
	host: string,
	token: string,
	path: string,
	init: RequestInit = {},
	options: { classifyError?: boolean } = {},
): Promise<Response> {
	const url = `${host}${path}`;
	const doFetch = (): Promise<Response> =>
		fetch(url, {
			...init,
			headers: {
				"PRIVATE-TOKEN": token,
				"Content-Type": "application/json",
				...(init.headers ?? {}),
			},
			signal: AbortSignal.timeout(10_000),
		});

	// 第一次尝试;网络错误(fetch 抛)时进入 catch 走重试分支
	let resp: Response;
	try {
		resp = await doFetch();
	} catch {
		await sleep(2_000);
		resp = await doFetch();
	}

	if (resp.ok) return resp;

	// 5xx 重试 1 次(429 / 4xx 不重试)
	let retried = false;
	if (resp.status >= 500) {
		await sleep(2_000);
		resp = await doFetch();
		retried = true;
		if (resp.ok) return resp;
	}

	const errText = await resp.text();
	const method = init.method ?? "GET";
	const baseMsg = `GitLab ${method} ${path} 失败:HTTP ${resp.status} ${errText.slice(0, 200)}`;

	if (options.classifyError) {
		if (resp.status === 401 || resp.status === 403) {
			throw new AuthError(baseMsg);
		}
		if (resp.status === 404) {
			throw new FileNotFoundError(baseMsg);
		}
		if (resp.status >= 500 && retried) {
			throw new RetryableError(baseMsg);
		}
	}
	throw new Error(baseMsg);
}

/**
 * 简单 sleep
 *
 * @internal
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 统计 unified diff 文本里的增量 / 删除行
 *
 * 规则:
 * - 行首 `+` 且非 `+++ b/...` 文件头 → additions++
 * - 行首 `-` 且非 `--- a/...` 文件头 → deletions++
 * - 其他行(`@@ ...`、context line、`\ No newline at end of file` 等)忽略
 *
 * GitLab `/changes` 接口返回的每个 file 的 `diff` 字段通常**不含** `--- a/...` /
 * `+++ b/...` 文件头(那些头由 `getMrDiff` 在拼接时单独加),但保守起见仍排除。
 *
 * @internal 仅供 client.ts 与单测使用
 */
export function countDiffChurn(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++")) continue;
		if (line.startsWith("---")) continue;
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

/**
 * 解析 GitLab unified diff,返回含类型的可评论新文件行。
 *
 * @param diff GitLab `/changes` 返回的单文件 diff
 * @returns 可评论行列表,按 diff 中出现顺序排列
 *
 * @internal
 */
function collectCommentableLineDetails(diff: string): CommentableLine[] {
	const lines: CommentableLine[] = [];
	let newLine: number | undefined;
	for (const rawLine of diff.split("\n")) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
		if (hunk) {
			const parsed = Number.parseInt(hunk[1] ?? "", 10);
			newLine = Number.isNaN(parsed) ? undefined : parsed;
			continue;
		}
		if (newLine === undefined || rawLine.startsWith("\\") || rawLine.length === 0) {
			continue;
		}
		if (rawLine.startsWith("-")) {
			continue;
		}
		if (rawLine.startsWith("+")) {
			lines.push({ line: newLine, kind: "add" });
			newLine += 1;
			continue;
		}
		if (rawLine.startsWith(" ")) {
			lines.push({ line: newLine, kind: "context" });
			newLine += 1;
		}
	}
	return lines;
}

/**
 * 解析 GitLab unified diff 中可用于 `new_line` 行内评论的位置。
 *
 * GitLab 只接受 diff hunk 内的新增行和上下文行作为 `new_line`;纯删除行没有
 * new_line,不应尝试发变更后行内评论。解析失败时返回空集合,调用方可降级整体评论。
 *
 * @param diff GitLab `/changes` 返回的单文件 diff
 * @returns 可评论的变更后行号集合
 */
export function collectCommentableNewLines(diff: string): Set<number> {
	return new Set(collectCommentableLineDetails(diff).map((line) => line.line));
}

/**
 * 给 MR diff hunk 行加上新文件行号和类型标记,帮助 LLM 选择可评论行。
 *
 * @param diff GitLab `/changes` 返回的单文件 diff
 * @returns 带 `add` / `ctx` / `del` 标记的 diff 文本
 *
 * @internal
 */
function annotateDiffNewLines(diff: string): string {
	const output: string[] = [];
	let oldLine: number | undefined;
	let newLine: number | undefined;
	for (const rawLine of diff.split("\n")) {
		if (rawLine.length === 0) {
			output.push(rawLine);
			continue;
		}
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
		if (hunk) {
			const parsedOldLine = Number.parseInt(hunk[1] ?? "", 10);
			const parsedNewLine = Number.parseInt(hunk[2] ?? "", 10);
			oldLine = Number.isNaN(parsedOldLine) ? undefined : parsedOldLine;
			newLine = Number.isNaN(parsedNewLine) ? undefined : parsedNewLine;
			output.push(rawLine);
			continue;
		}
		if (rawLine.startsWith("\\") || (oldLine === undefined && newLine === undefined)) {
			output.push(rawLine);
			continue;
		}
		if (rawLine.startsWith("-")) {
			output.push(formatAnnotatedDiffLine("-", oldLine, "del", rawLine.slice(1)));
			if (oldLine !== undefined) oldLine += 1;
			continue;
		}
		if (rawLine.startsWith("+")) {
			output.push(formatAnnotatedDiffLine("+", newLine, "add", rawLine.slice(1)));
			if (newLine !== undefined) newLine += 1;
			continue;
		}
		if (rawLine.startsWith(" ")) {
			output.push(formatAnnotatedDiffLine(" ", newLine, "ctx", rawLine.slice(1)));
			if (oldLine !== undefined) oldLine += 1;
			if (newLine !== undefined) newLine += 1;
			continue;
		}
		output.push(rawLine);
	}
	return output.join("\n");
}

/**
 * 格式化带行号标记的 diff 行。
 *
 * @param prefix 原 diff 前缀:`+` / `-` / 空格
 * @param line 行号;删除行是旧文件行号,新增 / 上下文行是新文件行号
 * @param kind 行类型标记
 * @param content 原始行内容(不含 diff 前缀)
 * @returns 带标记的单行文本
 *
 * @internal
 */
function formatAnnotatedDiffLine(
	prefix: "+" | "-" | " ",
	line: number | undefined,
	kind: string,
	content: string,
): string {
	const marker = line === undefined ? "----" : String(line).padStart(4, " ");
	return `${prefix}${marker} ${kind}  ${content}`;
}

/**
 * 判断评论体是否包含 GitLab suggestion 代码块。
 *
 * @param body 评论 Markdown body
 * @returns `true` 表示包含 suggestion 块
 *
 * @internal
 */
function hasSuggestionBlock(body: string): boolean {
	return /```suggestion\b/i.test(body);
}

/**
 * 查找距离目标行最近的可评论候选行。
 *
 * @param lines 可评论行列表
 * @param targetLine 目标新文件行号
 * @param limit 返回候选数量
 * @returns 距离优先、行号升序的候选行
 *
 * @internal
 */
function findNearestCommentableLines(lines: CommentableLine[], targetLine: number, limit = 3): CommentableLine[] {
	return [...lines]
		.sort((a, b) => {
			const distance = Math.abs(a.line - targetLine) - Math.abs(b.line - targetLine);
			if (distance !== 0) return distance;
			return a.line - b.line;
		})
		.slice(0, limit);
}

/**
 * 构造不可行内评论时的候选行展示文案。
 *
 * @param file 文件路径
 * @param candidates 候选可评论行
 * @returns 展示用文案
 *
 * @internal
 */
function formatCandidateLines(file: string, candidates: CommentableLine[]): string {
	if (candidates.length === 0) return "无";
	return candidates.map((line) => `\`${file}:${line.line}\``).join("、");
}

/**
 * 创建真实 GitLab REST 客户端
 *
 * 内部封装:`/changes` 拉 diff + diff_refs,缓存避免重复请求;bot username 自查 + 缓存。
 *
 * @internal
 */
function createRealClient(host: string, token: string): GitlabClient {
	// per-MR changes 缓存,key = `${projectId}:${mrIid}`
	const changesCache = new Map<string, ChangesResponse>();
	// bot 自身 username 缓存(每个 client 实例独立)
	let cachedBotUsername: string | undefined;

	async function getChanges(projectId: string, mrIid: number): Promise<ChangesResponse> {
		const key = `${projectId}:${mrIid}`;
		const cached = changesCache.get(key);
		if (cached) return cached;
		const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/changes`;
		const resp = await gitlabFetch(host, token, path);
		const body = (await resp.json()) as ChangesResponse;
		changesCache.set(key, body);
		return body;
	}

	async function getBotUsername(): Promise<string> {
		if (cachedBotUsername !== undefined) return cachedBotUsername;
		const resp = await gitlabFetch(host, token, "/api/v4/user");
		const body = (await resp.json()) as { username?: unknown };
		if (typeof body.username !== "string") {
			throw new Error("GitLab GET /api/v4/user 响应缺 username 字段");
		}
		cachedBotUsername = body.username;
		return cachedBotUsername;
	}

	async function postMrCommentInternal(
		projectId: string,
		mrIid: number,
		body: string,
		severity: Severity,
	): Promise<void> {
		const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`;
		// 仅 blocker 写 HTML 注释 marker,供 run.ts:scanForBlockers regex 识别;
		// 用 <!-- severity: blocker --> 而非 [severity:blocker] 字面前缀,GitLab markdown 渲染时
		// HTML 注释不显示,用户视图完全干净;severity 等级由模板内 emoji + 加粗标签表达
		const wrapped = severity === "blocker" ? `<!-- severity: blocker -->\n${body}` : body;
		await gitlabFetch(host, token, path, {
			method: "POST",
			body: JSON.stringify({ body: wrapped }),
		});
	}

	return {
		async getMrDiff(projectId, mrIid) {
			const { changes } = await getChanges(projectId, mrIid);
			// 拼接每个 file 的 diff,加上 `--- a/path / +++ b/path` 头便于 LLM 区分文件
			return changes
				.map((c) => {
					const filePath = c.deleted_file ? c.old_path : c.new_path;
					return `--- a/${filePath}\n+++ b/${filePath}\n${annotateDiffNewLines(c.diff)}`;
				})
				.join("\n");
		},

		async getMrFiles(projectId, mrIid) {
			const { changes } = await getChanges(projectId, mrIid);
			return changes.map((c) => (c.deleted_file ? c.old_path : c.new_path));
		},

		async getMrFileChanges(projectId, mrIid) {
			const { changes } = await getChanges(projectId, mrIid);
			return changes.map((c) => {
				const path = c.deleted_file ? c.old_path : c.new_path;
				const { additions, deletions } = countDiffChurn(c.diff);
				return { path, additions, deletions };
			});
		},

		async postMrComment(projectId, mrIid, body, severity) {
			await postMrCommentInternal(projectId, mrIid, body, severity);
		},

		async postMrLineComment(projectId, mrIid, input) {
			const changesBody = await getChanges(projectId, mrIid);
			const refs = changesBody.diff_refs;
			const changedFile = changesBody.changes.find((change) => !change.deleted_file && change.new_path === input.file);
			const commentableLines = changedFile === undefined ? [] : collectCommentableLineDetails(changedFile.diff);
			const commentableLineSet = new Set(commentableLines.map((line) => line.line));
			const isCommentable =
				Number.isInteger(input.line) && changedFile !== undefined && commentableLineSet.has(input.line);
			const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions`;
			let body = input.body;
			let actualLine = input.line;
			if (!isCommentable) {
				const reason = `目标行不在 MR diff 的可评论 new_line 中:${input.file}:${input.line}`;
				const candidates = Number.isInteger(input.line) ? findNearestCommentableLines(commentableLines, input.line) : [];
				const nearest = candidates[0];
				const suggestionBlocked = hasSuggestionBlock(input.body);
				if (
					nearest !== undefined &&
					!suggestionBlocked &&
					Number.isInteger(input.line) &&
					Math.abs(nearest.line - input.line) <= LINE_RELOCATION_MAX_DISTANCE
				) {
					actualLine = nearest.line;
					body = [
						`定位调整：原目标 \`${input.file}:${input.line}\` 不在 MR diff 可评论行中，已挂到最近可评论行 \`${input.file}:${actualLine}\`。`,
						"",
						input.body,
					].join("\n");
				} else {
					const fallbackBody = [
						`原计划行内评论位置不可用：\`${input.file}:${input.line}\`。`,
						`原因：${suggestionBlocked ? "评论包含 suggestion，未自动重定位，避免建议应用到错误行。" : "目标行不在 MR diff 的可评论 new_line 中。"}`,
						`最近可评论行：${formatCandidateLines(input.file, candidates)}。`,
						"",
						input.body,
					].join("\n");
					await postMrCommentInternal(projectId, mrIid, fallbackBody, input.severity);
					return { posted: "note_fallback", reason, originalLine: input.line };
				}
			}
			const wrapped = input.severity === "blocker" ? `<!-- severity: blocker -->\n${body}` : body;
			await gitlabFetch(host, token, path, {
				method: "POST",
				body: JSON.stringify({
					body: wrapped,
					position: {
						position_type: "text",
						base_sha: refs.base_sha,
						start_sha: refs.start_sha,
						head_sha: refs.head_sha,
						new_path: input.file,
						new_line: actualLine,
					},
				}),
			});
			if (actualLine !== input.line) {
				return { posted: "line", originalLine: input.line, actualLine, relocated: true };
			}
			return { posted: "line", actualLine };
		},

		async getBotComments(projectId, mrIid) {
			const botUsername = await getBotUsername();
			// per_page=100 + sort=asc:一次拉完(单 MR 评论很少超过 100),按时间升序便于上层做 snapshot diff
			const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes?per_page=100&sort=asc`;
			const resp = await gitlabFetch(host, token, path);
			const notes = (await resp.json()) as NoteItem[];
			return notes
				.filter((n) => n.author.username === botUsername)
				.map((n) => ({
					id: n.id,
					body: n.body,
					file: n.position?.new_path,
					line: n.position?.new_line,
				}));
		},

		async listGroupProjects(group, options = {}) {
			const params = new URLSearchParams({
				simple: "true",
				per_page: "100",
				order_by: "path",
				sort: "asc",
				include_subgroups: String(options.includeSubgroups ?? true),
			});
			if (options.search?.trim()) {
				params.set("search", options.search.trim());
			}
			const path = `/api/v4/groups/${encodeURIComponent(group)}/projects?${params.toString()}`;
			const resp = await gitlabFetch(host, token, path, {}, { classifyError: true });
			const projects = (await resp.json()) as ProjectItem[];
			return projects.map((project) => ({
				id: project.id,
				path_with_namespace: project.path_with_namespace ?? "",
				default_branch: project.default_branch,
				web_url: project.web_url,
			}));
		},

		async listProjectBranches(project, options = {}) {
			const params = new URLSearchParams({ per_page: "100" });
			if (options.search?.trim()) {
				params.set("search", options.search.trim());
			}
			const path = `/api/v4/projects/${encodeURIComponent(project)}/repository/branches?${params.toString()}`;
			const resp = await gitlabFetch(host, token, path, {}, { classifyError: true });
			const branches = (await resp.json()) as BranchItem[];
			return branches.map((branch) => ({
				name: branch.name,
				default: branch.default ?? false,
				protected: branch.protected ?? false,
				commit_short_id: branch.commit?.short_id,
				committed_date: branch.commit?.committed_date,
				title: branch.commit?.title,
			}));
		},

		async prepareProjectWorkspace(input) {
			return prepareProjectWorkspace(host, token, input);
		},

		async getFileContent(projectId, filePath, ref) {
			// path 必须整段 encodeURIComponent(GitLab 要求 `/` → `%2F`,即使是文件路径)
			// 路径示例:`internal/auth/sign_verify.go` → `internal%2Fauth%2Fsign_verify.go`
			const encodedPath = encodeURIComponent(filePath);
			const apiPath = `/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`;
			// classifyError=true:本 endpoint 调用方需要区分 404(文件不存在) / 401 / 5xx
			const resp = await gitlabFetch(host, token, apiPath, {}, { classifyError: true });
			// 200 响应:整 body 即 raw 文件(非 JSON),按 UTF-8 解码
			return await resp.text();
		},
	};
}
