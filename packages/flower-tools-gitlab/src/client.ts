/**
 * GitLab REST API 轻量客户端
 *
 * 故意不引入 @gitbeaker/rest 之类的重型 SDK,因为我们只用 5-6 个 endpoint,
 * 自己包一层更可控、二进制更小、错误信息更清晰。
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

let cachedClient: GitlabClient | undefined;

/**
 * 获取(或惰性创建)GitLab 客户端
 *
 * 当前是 stub,真实实现见每个方法的 TODO 注释。
 */
export function gitlabClient(): GitlabClient {
	if (cachedClient) return cachedClient;
	const host = process.env.GITLAB_HOST ?? "https://gitlab.com";
	const token = process.env.GITLAB_TOKEN;
	if (!token) {
		throw new Error("GITLAB_TOKEN 环境变量未设置");
	}
	cachedClient = createStubClient(host, token);
	return cachedClient;
}

/**
 * 测试 / 占位用客户端
 */
function createStubClient(host: string, _token: string): GitlabClient {
	return {
		async getMrDiff(projectId, mrIid) {
			// TODO: GET /api/v4/projects/{projectId}/merge_requests/{mrIid}/changes
			return `[Stub] diff for ${host} project=${projectId} mr=${mrIid}`;
		},
		async getMrFiles(projectId, mrIid) {
			// TODO: 同上,从 changes 接口提取 new_path 字段
			return [`stub-file-${projectId}-${mrIid}.ts`];
		},
		async postMrComment(projectId, mrIid, body, severity) {
			// TODO: POST /api/v4/projects/{projectId}/merge_requests/{mrIid}/notes
			console.log(`[Stub] post comment to ${projectId}/${mrIid} severity=${severity}: ${body}`);
		},
		async postMrLineComment(projectId, mrIid, input) {
			// TODO: POST /api/v4/projects/{projectId}/merge_requests/{mrIid}/discussions
			//       需要 position 参数,内含 base_sha / start_sha / head_sha / new_path / new_line
			console.log(`[Stub] line comment ${projectId}/${mrIid} ${input.file}:${input.line}`);
		},
		async getBotComments(_projectId, _mrIid) {
			// TODO: GET notes,过滤 author.username === bot user
			return [];
		},
	};
}
