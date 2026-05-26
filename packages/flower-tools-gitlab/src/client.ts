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
 * - **severity 前缀**:`[severity:<level>] ` 写进真实评论 body —— `run.ts` 的 blocker 扫描凭此 regex 识别
 * - **severity 词表**`blocker | major | minor`(对齐 prompts.ts 模板 + render 函数;
 *   Phase 2 起统一,旧的 `info | warning` 已下线)
 * - **diff_refs 内部缓存** per-MR(行内评论需 base_sha/start_sha/head_sha,避免每次发评论都拉 changes)
 * - **bot username 自查**:通过 `GET /api/v4/user` 一次 + 缓存,避免硬编码 env
 * - **gitlab_get_file_content**(N1):拉任意 ref 的文件原始内容,供 LLM 拿真实代码上下文
 */

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
 * GitLab 客户端
 */
export interface GitlabClient {
	getMrDiff(projectId: string, mrIid: number): Promise<string>;
	getMrFiles(projectId: string, mrIid: number): Promise<string[]>;
	/**
	 * 列出 MR 变更文件 + 每个文件的 churn(+/- 行数,用于 E2 cap 排序)
	 *
	 * 不需要重新请求 `/changes`,内部复用 diff_refs 缓存机制(同 MR 多次调用走缓存)。
	 */
	getMrFileChanges(projectId: string, mrIid: number): Promise<MrFileChange[]>;
	postMrComment(projectId: string, mrIid: number, body: string, severity: Severity): Promise<void>;
	postMrLineComment(projectId: string, mrIid: number, input: LineCommentInput): Promise<void>;
	getBotComments(projectId: string, mrIid: number): Promise<BotComment[]>;
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
 * 创建真实 GitLab REST 客户端
 *
 * 内部封装:`/changes` 拉 diff + diff_refs,缓存避免重复请求;bot username 自查 + 缓存。
 *
 * @internal
 */
function createRealClient(host: string, token: string): GitlabClient {
	// per-MR diff_refs 缓存,key = `${projectId}:${mrIid}`
	const diffRefsCache = new Map<string, DiffRefs>();
	// bot 自身 username 缓存(每个 client 实例独立)
	let cachedBotUsername: string | undefined;

	async function getChanges(projectId: string, mrIid: number): Promise<ChangesResponse> {
		const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/changes`;
		const resp = await gitlabFetch(host, token, path);
		const body = (await resp.json()) as ChangesResponse;
		diffRefsCache.set(`${projectId}:${mrIid}`, body.diff_refs);
		return body;
	}

	async function getDiffRefs(projectId: string, mrIid: number): Promise<DiffRefs> {
		const cached = diffRefsCache.get(`${projectId}:${mrIid}`);
		if (cached) return cached;
		const { diff_refs } = await getChanges(projectId, mrIid);
		return diff_refs;
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

	return {
		async getMrDiff(projectId, mrIid) {
			const { changes } = await getChanges(projectId, mrIid);
			// 拼接每个 file 的 diff,加上 `--- a/path / +++ b/path` 头便于 LLM 区分文件
			return changes
				.map((c) => {
					const filePath = c.deleted_file ? c.old_path : c.new_path;
					return `--- a/${filePath}\n+++ b/${filePath}\n${c.diff}`;
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
			const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`;
			// 仅 blocker 写 HTML 注释 marker,供 run.ts:scanForBlockers regex 识别;
			// 用 <!-- severity: blocker --> 而非 [severity:blocker] 字面前缀,GitLab markdown 渲染时
			// HTML 注释不显示,用户视图完全干净;severity 等级由模板内 emoji + 加粗标签表达
			const wrapped = severity === "blocker" ? `<!-- severity: blocker -->\n${body}` : body;
			await gitlabFetch(host, token, path, {
				method: "POST",
				body: JSON.stringify({ body: wrapped }),
			});
		},

		async postMrLineComment(projectId, mrIid, input) {
			const refs = await getDiffRefs(projectId, mrIid);
			const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions`;
			const wrapped = input.severity === "blocker" ? `<!-- severity: blocker -->\n${input.body}` : input.body;
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
						new_line: input.line,
					},
				}),
			});
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
