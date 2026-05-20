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
 * - **diff_refs 内部缓存** per-MR(行内评论需 base_sha/start_sha/head_sha,避免每次发评论都拉 changes)
 * - **bot username 自查**:通过 `GET /api/v4/user` 一次 + 缓存,避免硬编码 env
 */

/**
 * 行内评论参数
 */
export interface LineCommentInput {
	file: string;
	line: number;
	body: string;
	severity: "info" | "warning" | "blocker";
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
	postMrComment(projectId: string, mrIid: number, body: string, severity: "info" | "warning" | "blocker"): Promise<void>;
	postMrLineComment(projectId: string, mrIid: number, input: LineCommentInput): Promise<void>;
	getBotComments(projectId: string, mrIid: number): Promise<BotComment[]>;
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
 * @param host GitLab host(如 `http://gitlab.xhgjdev.com`)
 * @param token PAT
 * @param path API 路径(以 `/api/v4/...` 起头)
 * @param init fetch RequestInit
 * @returns 已通过 `resp.ok` 校验的 Response
 * @throws 当 4xx/5xx 或网络错误时抛 Error,信息含 HTTP code + 响应体前 200 字符
 *
 * @internal
 */
async function gitlabFetch(host: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
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
	if (resp.status >= 500) {
		await sleep(2_000);
		resp = await doFetch();
		if (resp.ok) return resp;
	}

	const errText = await resp.text();
	const method = init.method ?? "GET";
	throw new Error(`GitLab ${method} ${path} 失败:HTTP ${resp.status} ${errText.slice(0, 200)}`);
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

		async postMrComment(projectId, mrIid, body, severity) {
			const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`;
			await gitlabFetch(host, token, path, {
				method: "POST",
				body: JSON.stringify({ body: `[severity:${severity}] ${body}` }),
			});
		},

		async postMrLineComment(projectId, mrIid, input) {
			const refs = await getDiffRefs(projectId, mrIid);
			const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions`;
			await gitlabFetch(host, token, path, {
				method: "POST",
				body: JSON.stringify({
					body: `[severity:${input.severity}] ${input.body}`,
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
	};
}
