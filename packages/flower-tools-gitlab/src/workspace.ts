/**
 * 跨项目只读工作区准备工具。
 *
 * 设计目标:
 * - 只允许白名单 namespace 下的项目,禁止任意 Git URL。
 * - token 只通过 git 进程环境传递,不出现在返回值和命令参数中。
 * - 仓库固定放在临时上下文目录,供 reviewer 后续用本地 `rg` 搜索。
 */

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_CONTEXT_ROOT = "/tmp/review-context/repos";
const DEFAULT_FETCH_DEPTH = 1;

/**
 * 跨项目工作区准备入参。
 */
export interface PrepareProjectWorkspaceInput {
	/** GitLab 项目路径,例如 `digital-biz-projects/iqs/iqs-harness` */
	project: string;
	/** branch / tag / commit sha */
	ref: string;
	/** 本地目录别名,只能包含安全字符 */
	alias: string;
	/** shallow fetch depth,默认 1 */
	depth?: number | undefined;
}

/**
 * 跨项目工作区准备结果。
 */
export interface PreparedProjectWorkspace {
	/** 本地工作区路径 */
	path: string;
	/** GitLab 项目路径 */
	project: string;
	/** 请求的 ref */
	ref: string;
	/** 实际 checkout commit sha */
	commit: string;
	/** 是否复用了已有本地仓库 */
	reused: boolean;
}

/**
 * 推导 namespace 的祖先链(业务组级即止,由近到远)。
 *
 * 跨项目白名单与 harness 自动发现共享同一边界:
 * - 保留段数 ≥ 2 的所有前缀;顶层 group(单段)不放行,业务组之间互相隔离
 *   (例:`digital-biz-projects/srm/fronts` → `[".../srm/fronts", ".../srm"]`,
 *   不包含 `digital-biz-projects`)
 * - namespace 本身只有 1 段时保留自身,否则连同组项目都不可读(保持旧行为)
 *
 * @param namespace GitLab namespace 路径,例如 `digital-biz-projects/srm/fronts`
 * @returns 由近到远的祖先 namespace 列表;入参为空时返回空数组
 */
export function resolveNamespaceAncestors(namespace: string): string[] {
	const normalized = normalizeNamespace(namespace);
	if (!normalized) return [];
	const segments = normalized.split("/");
	if (segments.length === 1) return [normalized];
	const ancestors: string[] = [];
	// 由近到远收集前缀,最少保留 2 段(业务组级):发现算法按此顺序就近探测
	for (let keep = segments.length; keep >= 2; keep--) {
		ancestors.push(segments.slice(0, keep).join("/"));
	}
	return ancestors;
}

/**
 * 从环境变量解析允许访问的项目 namespace 前缀。
 *
 * 优先级:
 * 1. `FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES`,逗号分隔(显式配置,可收紧或放宽)
 * 2. `CI_PROJECT_NAMESPACE` 的祖先链(业务组级即止,见 `resolveNamespaceAncestors`)
 * 3. `CI_PROJECT_PATH` 去掉最后一段项目名后的祖先链
 *
 * 默认值取祖先链而非单一 namespace:嵌套分组(如 `digital-biz-projects/srm/fronts`)
 * 的评审任务需要可达父分组下的 harness 仓库(`digital-biz-projects/srm/srm-harness`)。
 *
 * @returns 允许的 namespace 前缀列表
 */
export function resolveAllowedProjectPrefixes(): string[] {
	const configured = process.env.FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES;
	if (configured?.trim()) {
		return configured
			.split(",")
			.map((item) => normalizeNamespace(item))
			.filter((item) => item.length > 0);
	}
	const namespace = normalizeNamespace(process.env.CI_PROJECT_NAMESPACE ?? "");
	if (namespace) return resolveNamespaceAncestors(namespace);
	const projectPath = normalizeNamespace(process.env.CI_PROJECT_PATH ?? "");
	const lastSlash = projectPath.lastIndexOf("/");
	if (lastSlash > 0) {
		return resolveNamespaceAncestors(projectPath.slice(0, lastSlash));
	}
	return [];
}

/**
 * 校验跨项目路径是否位于允许 namespace 内。
 *
 * @param project GitLab 项目路径
 * @param allowedPrefixes 允许 namespace 前缀
 * @throws 当路径非法或不在允许范围内时抛错
 */
export function assertAllowedProject(project: string, allowedPrefixes = resolveAllowedProjectPrefixes()): void {
	const normalizedProject = normalizeProjectPath(project);
	if (allowedPrefixes.length === 0) {
		throw new Error("未配置跨项目上下文白名单:请设置 FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES 或 CI_PROJECT_NAMESPACE");
	}
	const allowed = allowedPrefixes.some((prefix) => normalizedProject.startsWith(`${prefix}/`));
	if (!allowed) {
		throw new Error(`项目不在跨项目上下文白名单内:${normalizedProject}`);
	}
}

/**
 * 校验 group 路径是否位于允许 namespace 内。
 *
 * @param group GitLab group 路径
 * @param allowedPrefixes 允许 namespace 前缀
 * @throws 当路径非法或不在允许范围内时抛错
 */
export function assertAllowedGroup(group: string, allowedPrefixes = resolveAllowedProjectPrefixes()): void {
	const normalizedGroup = normalizeGroupPath(group);
	if (allowedPrefixes.length === 0) {
		throw new Error("未配置跨项目上下文白名单:请设置 FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES 或 CI_PROJECT_NAMESPACE");
	}
	const allowed = allowedPrefixes.some(
		(prefix) => normalizedGroup === prefix || normalizedGroup.startsWith(`${prefix}/`),
	);
	if (!allowed) {
		throw new Error(`group 不在跨项目上下文白名单内:${normalizedGroup}`);
	}
}

/**
 * 归一化 GitLab group 路径。
 *
 * @param group 用户传入的 group 路径
 * @returns 去除首尾斜杠的 group 路径
 * @throws 当传入 URL、空路径或可疑路径时抛错
 */
export function normalizeGroupPath(group: string): string {
	const trimmed = normalizeNamespace(group);
	if (!trimmed) {
		throw new Error("group 不能为空");
	}
	if (/^[a-z]+:\/\//i.test(trimmed) || trimmed.includes("..") || trimmed.includes("\\") || trimmed.endsWith(".git")) {
		throw new Error("group 必须是 GitLab namespace/path,不能是 URL 或包含路径穿越");
	}
	return trimmed;
}

/**
 * 归一化 GitLab 项目路径。
 *
 * @param project 用户传入的项目路径
 * @returns 去除 `.git` 后缀和首尾斜杠的项目路径
 * @throws 当传入 URL、空路径或可疑路径时抛错
 */
export function normalizeProjectPath(project: string): string {
	const trimmed = project.trim().replace(/^\/*/, "").replace(/\/*$/, "");
	if (!trimmed) {
		throw new Error("project 不能为空");
	}
	if (/^[a-z]+:\/\//i.test(trimmed) || trimmed.includes("..") || trimmed.includes("\\")) {
		throw new Error("project 必须是 GitLab namespace/path,不能是 URL 或包含路径穿越");
	}
	const withoutGit = trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
	if (!withoutGit.includes("/")) {
		throw new Error("project 必须包含 namespace 和项目名");
	}
	return withoutGit;
}

/**
 * 校验并归一化本地目录别名。
 *
 * @param alias 用户传入的目录别名
 * @returns 可安全拼接到工作区根目录下的别名
 * @throws 当别名包含路径分隔符或危险字符时抛错
 */
export function normalizeWorkspaceAlias(alias: string): string {
	const trimmed = alias.trim();
	if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
		throw new Error("alias 只能包含字母、数字、点、下划线和短横线");
	}
	return trimmed;
}

/**
 * 构造 Git 仓库 HTTP URL。
 *
 * @param host GitLab host
 * @param project GitLab 项目路径
 * @returns 不含 token 的仓库 URL
 */
export function buildRepositoryUrl(host: string, project: string): string {
	const normalizedHost = host.replace(/\/+$/, "");
	const normalizedProject = normalizeProjectPath(project);
	return `${normalizedHost}/${normalizedProject}.git`;
}

/**
 * 构造 Git smart HTTP 可用的鉴权 header。
 *
 * GitLab REST API 支持 `PRIVATE-TOKEN`,但 `git fetch` 走 smart HTTP 时不会把该 header
 * 当作用户名密码,会退回交互式询问用户名。Basic `oauth2:<token>` 是 GitLab HTTP
 * 仓库访问的非交互鉴权路径,且不会把 token 写入 remote URL。
 *
 * @param token GitLab token
 * @returns 可传给 `http.extraHeader` 的 Authorization header
 */
export function buildGitAuthHeader(token: string): string {
	return `Authorization: Basic ${Buffer.from(`oauth2:${token}`, "utf8").toString("base64")}`;
}

/**
 * 对 git 错误信息做凭证脱敏。
 *
 * @param message 原始错误信息
 * @param token GitLab token
 * @returns 脱敏后的错误信息
 */
export function redactGitAuth(message: string, token: string): string {
	const basicHeader = buildGitAuthHeader(token);
	const basicValue = basicHeader.slice("Authorization: Basic ".length);
	return message
		.replaceAll(token, "[redacted]")
		.replaceAll(basicHeader, "[redacted]")
		.replaceAll(basicValue, "[redacted]");
}

/**
 * 准备跨项目本地工作区。
 *
 * @param host GitLab host
 * @param token GitLab token
 * @param input 工作区准备参数
 * @returns 本地路径与实际 commit
 */
export async function prepareProjectWorkspace(
	host: string,
	token: string,
	input: PrepareProjectWorkspaceInput,
): Promise<PreparedProjectWorkspace> {
	const project = normalizeProjectPath(input.project);
	assertAllowedProject(project);
	const alias = normalizeWorkspaceAlias(input.alias || basename(project));
	const ref = normalizeWorkspaceRef(input.ref);
	const depth = normalizeDepth(input.depth);
	const root = resolve(process.env.FLOWER_GITLAB_CONTEXT_ROOT ?? DEFAULT_CONTEXT_ROOT);
	const target = resolve(root, alias);
	if (!target.startsWith(`${root}${sep}`)) {
		throw new Error("alias 解析后的路径不在跨项目上下文目录内");
	}

	await mkdir(root, { recursive: true });
	const repoUrl = buildRepositoryUrl(host, project);
	const reused = await isGitRepository(target);
	if (!reused && (await exists(target))) {
		throw new Error(`目标目录已存在但不是 Git 仓库:${target}`);
	}
	if (!reused) {
		await mkdir(target, { recursive: true });
		await runGit(token, ["-C", target, "init"]);
		await runGit(token, ["-C", target, "remote", "add", "origin", repoUrl]);
	}
	if (reused) {
		await runGit(token, ["-C", target, "remote", "set-url", "origin", repoUrl]);
	}

	await runGit(token, ["-C", target, "fetch", "--depth", String(depth), "origin", ref]);
	await runGit(token, ["-C", target, "checkout", "--detach", "--force", "FETCH_HEAD"]);
	await runGit(token, ["-C", target, "clean", "-fdx"]);
	const commit = (await runGit(token, ["-C", target, "rev-parse", "HEAD"])).trim();
	return { path: target, project, ref, commit, reused };
}

function normalizeNamespace(value: string): string {
	return value.trim().replace(/^\/*/, "").replace(/\/*$/, "");
}

/**
 * 归一化跨项目 workspace 的 ref。
 *
 * @param value branch / tag / commit sha
 * @returns trim 后的 ref
 * @throws 当 ref 为空、像命令参数或包含可疑路径片段时抛错
 */
export function normalizeWorkspaceRef(value: string): string {
	const trimmed = value.trim();
	if (
		!trimmed ||
		trimmed.startsWith("-") ||
		trimmed.includes("..") ||
		trimmed.includes("\\") ||
		hasAsciiControlOrWhitespace(trimmed)
	) {
		throw new Error("ref 不能为空或包含可疑路径片段");
	}
	return trimmed;
}

function hasAsciiControlOrWhitespace(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 32 || code === 127) return true;
	}
	return false;
}

function normalizeDepth(value: number | undefined): number {
	if (value === undefined) return DEFAULT_FETCH_DEPTH;
	if (!Number.isInteger(value) || value < 1 || value > 100) {
		throw new Error("depth 必须是 1 到 100 之间的整数");
	}
	return value;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function isGitRepository(path: string): Promise<boolean> {
	try {
		const gitDir = await stat(resolve(path, ".git"));
		return gitDir.isDirectory();
	} catch {
		return false;
	}
}

async function runGit(token: string, args: string[]): Promise<string> {
	const authHeader = buildGitAuthHeader(token);
	try {
		const { stdout } = await execFileAsync("git", args, {
			env: {
				...process.env,
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "http.extraHeader",
				GIT_CONFIG_VALUE_0: authHeader,
			},
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		});
		return stdout;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`git 命令执行失败:${redactGitAuth(message, token)}`);
	}
}
