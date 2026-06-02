/**
 * GitLab 服务端版本探测
 *
 * 为什么本模块在 flower-code-reviewer 而非 flower-tools-gitlab:
 * - Phase 1 严格不动 flower-tools-gitlab(N1 范畴)
 * - 版本探测只为评论模板 alert 块降级服务,本身与 GitLab "工具"语义不耦合
 * - 后续 Phase 若发现复用需求,再迁移到 client.ts
 *
 * 行为:
 * - `detectGitlabVersion`:`GET /api/v4/version` 一次性拉取,**module 级缓存**
 *   后续调用直接返回缓存,不会重复请求 GitLab
 * - 探测失败(网络抖动 / 401 / 字段缺失)→ 返回 null,caller 走降级路径
 * - **故意不抛错** — 版本探测是 "best-effort",失败不阻塞评审主流程
 */

/** 已解析的 GitLab 版本(major + minor) */
export interface GitlabVersion {
	major: number;
	minor: number;
}

/**
 * Module-level cache。
 *
 * 三态:
 * - `undefined`:从未探测,首次调用会发请求
 * - `null`:探测过但失败(或字段缺失),后续调用直接返回 null 不重试
 * - `GitlabVersion`:探测成功,直接复用
 */
let cachedVersion: GitlabVersion | null | undefined;

/**
 * 探测 GitLab 服务端版本(用于决定 alert 块降级)
 *
 * 行为参考 `flower-tools-gitlab/client.ts:gitlabFetch`:
 * - 用 `PRIVATE-TOKEN` header 鉴权
 * - 10 秒超时
 * - 任何失败(网络 / HTTP 非 200 / JSON 格式错 / `version` 字段缺失)→ 返回 null
 *
 * @param env 从 `process.env` 注入的鉴权信息(便于单测 mock)
 * @returns 探测成功返回 `{ major, minor }`;失败返回 null
 */
export async function detectGitlabVersion(env?: {
	gitlabHost?: string;
	gitlabToken?: string;
}): Promise<GitlabVersion | null> {
	if (cachedVersion !== undefined) {
		return cachedVersion;
	}

	const host =
		env !== undefined ? (env.gitlabHost ?? "https://gitlab.com") : (process.env.GITLAB_HOST ?? "https://gitlab.com");
	const token = env !== undefined ? env.gitlabToken : process.env.GITLAB_TOKEN;
	if (!token) {
		// 无 token 也不抛错(评审本地 dry-run 场景可能没 token);直接走降级
		cachedVersion = null;
		return null;
	}

	try {
		const resp = await fetch(`${host}/api/v4/version`, {
			headers: { "PRIVATE-TOKEN": token },
			signal: AbortSignal.timeout(10_000),
		});
		if (!resp.ok) {
			cachedVersion = null;
			return null;
		}
		const body = (await resp.json()) as { version?: unknown };
		if (typeof body.version !== "string") {
			cachedVersion = null;
			return null;
		}
		const parsed = parseVersionString(body.version);
		cachedVersion = parsed;
		return parsed;
	} catch {
		// 网络错误 / timeout / JSON parse 错 — 一律降级
		cachedVersion = null;
		return null;
	}
}

/**
 * 解析 GitLab `version` 字段(形如 `17.10.0-ee` / `16.11.5` / `18.2.0-pre`)
 *
 * 正则只取前两段数字 major.minor。解析失败返回 null。
 *
 * @param raw GitLab API 返回的版本字符串
 * @returns 解析成功返回 `{ major, minor }`;解析失败返回 null
 *
 * @internal 仅本 module 用,导出给单测覆盖
 */
export function parseVersionString(raw: string): GitlabVersion | null {
	const match = raw.match(/^(\d+)\.(\d+)/);
	if (!match) return null;
	// 正则带 2 个捕获组,match[1] / match[2] 必定存在;`noUncheckedIndexedAccess` 下显式断言
	const majorStr = match[1];
	const minorStr = match[2];
	if (majorStr === undefined || minorStr === undefined) return null;
	const major = Number.parseInt(majorStr, 10);
	const minor = Number.parseInt(minorStr, 10);
	if (Number.isNaN(major) || Number.isNaN(minor)) return null;
	return { major, minor };
}

/**
 * 仅供单元测试重置模块级缓存
 *
 * @internal
 */
export function _resetVersionCacheForTests(): void {
	cachedVersion = undefined;
}
