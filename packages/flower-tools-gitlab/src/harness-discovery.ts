/**
 * harness 仓库就近自动发现。
 *
 * 背景(2026-06-10 诊断):reviewer prompt 只说"查配置的 harness 仓库",但运行时从未注入
 * harness 位置,模型靠猜 → 大量评审直接写"未找到权威需求依据"(job 17580 实测 0 次跨项目
 * 工具调用)。本模块在 run 启动阶段沿 `CI_PROJECT_NAMESPACE` 祖先链**就近**探测 harness,
 * 把"模型自己猜在哪"变成"宿主直接告诉它在哪":
 *
 * - IQS 平铺结构:第一跳(自身 namespace `digital-biz-projects/iqs`)即命中 `iqs-harness`
 * - SRM 嵌套结构:第一跳 `…/srm/fronts` 未命中 → 上钻 `…/srm` 命中 `srm-harness`
 * - 边界与跨项目白名单同源(业务组级即止,见 `resolveNamespaceAncestors`),
 *   构造性满足 `assertAllowedGroup`,不会探测到白名单之外
 *
 * 降级语义:发现失败**永不抛错**(评审主流程不能被探测阻塞),三态返回:
 * - `null`:完全无法探测(无 CI env / 白名单为空 / 调用方 catch)→ prompt 不注入或注明降级
 * - `{ project: null, searchedGroups }`:已探测未发现 → prompt 注明"已自动探测未发现"
 * - `{ project, branches, ... }`:命中 → prompt 注入完整事实
 */

import { type GitlabProjectSummary, gitlabClient } from "./client.js";
import { assertAllowedGroup, resolveNamespaceAncestors } from "./workspace.js";

/** group projects API 的 harness 搜索词(服务端模糊匹配 name/path) */
const HARNESS_SEARCH_TERM = "harness";

/** 注入 prompt 的分支清单上限,防超大仓库分支数撑爆 prompt */
const MAX_BRANCHES = 50;

/**
 * harness 自动发现结果。
 */
export interface HarnessDiscoveryResult {
	/** 命中的 harness 项目路径(主选);`null` = 已探测但未发现 */
	project: string | null;
	/** 主选项目的 default branch;未知时为 null */
	defaultBranch: string | null;
	/** 主选项目分支名清单(default 在首位,上限 {@link MAX_BRANCHES} 条) */
	branches: string[];
	/** 分支清单是否因超上限被截断 */
	branchesTruncated: boolean;
	/** 同跳命中多个 harness 时的其余候选项目路径(全部注入由模型按需选择) */
	candidates: string[];
	/** 实际探测过的 group 链(近→远),"未发现"时供模型如实引用 */
	searchedGroups: string[];
}

/**
 * 沿当前 CI 项目 namespace 的祖先链就近发现 harness 仓库。
 *
 * 算法:
 * 1. `resolveNamespaceAncestors(CI_PROJECT_NAMESPACE)` 得到探测链(近→远,业务组级即止),
 *    并过滤掉不在跨项目白名单内的 group(显式收紧 `FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES`
 *    时探测范围同步收紧)
 * 2. 逐跳 `listGroupProjects(group, { search: "harness", includeSubgroups: true })`,
 *    就近子树优先;排除当前 MR 项目自身(防项目名含 harness 时自指)
 * 3. 同跳多命中时优先 `<group尾段>-harness` 精确命名(如 `srm` 组下选 `srm-harness`),
 *    其余进 candidates
 * 4. 对主选项目顺带拉分支清单(default 置首,上限 50;失败不影响主结果)
 * 5. 单跳 API 失败 warn 后继续下一跳;全链未命中返回 `{ project: null, searchedGroups }`
 *
 * @returns 发现结果;完全无法探测(无 CI namespace / 白名单为空)时返回 `null`
 */
export async function discoverHarnessProject(): Promise<HarnessDiscoveryResult | null> {
	const namespace = resolveCurrentNamespace();
	if (!namespace) return null;
	const selfProject = normalizePath(process.env.CI_PROJECT_PATH ?? "");
	const chain = resolveNamespaceAncestors(namespace).filter((group) => isAllowedGroup(group));
	if (chain.length === 0) return null;

	const searchedGroups: string[] = [];
	for (const group of chain) {
		searchedGroups.push(group);
		let projects: GitlabProjectSummary[];
		try {
			projects = await gitlabClient().listGroupProjects(group, {
				search: HARNESS_SEARCH_TERM,
				includeSubgroups: true,
			});
		} catch (err) {
			// 单跳失败(403/404/网络)不终止:上钻下一跳仍可能命中;错误信息由 client 截断且不含 token
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[harness-discovery] 探测 group "${group}" 失败,继续上钻:${message}`);
			continue;
		}
		// 服务端 search 也会匹配描述等字段,客户端兜底只认项目名(尾段)含 harness 的结果
		const hits = projects.filter(
			(project) =>
				project.path_with_namespace !== selfProject &&
				lastSegment(project.path_with_namespace).toLowerCase().includes(HARNESS_SEARCH_TERM),
		);
		if (hits.length === 0) continue;

		const primary = pickPrimaryHarness(hits, group);
		const candidates = hits
			.filter((hit) => hit.path_with_namespace !== primary.path_with_namespace)
			.map((hit) => hit.path_with_namespace);
		const { branches, truncated } = await listBranchesSafe(primary);
		return {
			project: primary.path_with_namespace,
			defaultBranch: primary.default_branch ?? null,
			branches,
			branchesTruncated: truncated,
			candidates,
			searchedGroups,
		};
	}
	return { project: null, defaultBranch: null, branches: [], branchesTruncated: false, candidates: [], searchedGroups };
}

/**
 * 解析当前 CI 项目的 namespace。
 *
 * 优先级与白名单默认值推导一致:`CI_PROJECT_NAMESPACE` > `CI_PROJECT_PATH` 去掉项目名尾段。
 *
 * @returns namespace 路径;本地无 CI env 时返回空字符串
 */
function resolveCurrentNamespace(): string {
	const namespace = normalizePath(process.env.CI_PROJECT_NAMESPACE ?? "");
	if (namespace) return namespace;
	const projectPath = normalizePath(process.env.CI_PROJECT_PATH ?? "");
	const lastSlash = projectPath.lastIndexOf("/");
	return lastSlash > 0 ? projectPath.slice(0, lastSlash) : "";
}

/**
 * 同跳多命中时选主选 harness:优先 `<group尾段>-harness` 精确命名,否则取第一个
 * (API 已按 path 升序,结果确定性)。
 *
 * @param hits 候选项目(非空)
 * @param group 当前探测的 group 路径
 * @returns 主选项目
 */
function pickPrimaryHarness(hits: GitlabProjectSummary[], group: string): GitlabProjectSummary {
	const preferredName = `${lastSegment(group)}-harness`.toLowerCase();
	const exact = hits.find((hit) => lastSegment(hit.path_with_namespace).toLowerCase() === preferredName);
	// biome-ignore lint/style/noNonNullAssertion: 调用方保证 hits 非空
	return exact ?? hits[0]!;
}

/**
 * 拉取主选 harness 的分支清单(default 置首,截断到上限)。
 *
 * @param project 主选项目摘要
 * @returns 分支名清单与截断标记;API 失败时返回空清单(warn,不影响主结果)
 */
async function listBranchesSafe(project: GitlabProjectSummary): Promise<{ branches: string[]; truncated: boolean }> {
	try {
		const summaries = await gitlabClient().listProjectBranches(project.path_with_namespace, {});
		// default 分支置首:模型无版本匹配时的兜底 ref 应最显眼
		const names = summaries.sort((a, b) => Number(b.default) - Number(a.default)).map((branch) => branch.name);
		return { branches: names.slice(0, MAX_BRANCHES), truncated: names.length > MAX_BRANCHES };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[harness-discovery] 拉取 "${project.path_with_namespace}" 分支清单失败:${message}`);
		return { branches: [], truncated: false };
	}
}

/**
 * 判断 group 是否在跨项目白名单内(不在时静默跳过,不抛)。
 *
 * @param group group 路径
 * @returns 是否允许探测
 */
function isAllowedGroup(group: string): boolean {
	try {
		assertAllowedGroup(group);
		return true;
	} catch {
		return false;
	}
}

/**
 * 去除首尾斜杠的路径归一化(与 workspace.ts 内部 normalizeNamespace 同语义)。
 */
function normalizePath(value: string): string {
	return value.trim().replace(/^\/*/, "").replace(/\/*$/, "");
}

/**
 * 取路径最后一段(项目名 / group 名)。
 */
function lastSegment(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(idx + 1) : path;
}
