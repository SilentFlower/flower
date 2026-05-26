/**
 * 评审流程主控
 *
 * 关键流程:
 * 1. 决定 MR IID(CLI 参数 / `CI_MERGE_REQUEST_IID` env)
 * 2. 选 skill(args.skill / `pickSkill()` 自动选)
 * 3. 拉跑前 bot 评论 id 集合作为 snapshot(用于跑后 diff 出新评论)
 * 4. 调 `buildPiCliArgs` 把 env 翻译成 pi-coding-agent CLI argv
 * 5. 调 `piMain` 跑 LLM 评审(extensionFactories 注入合规 / 工具 / provider)
 * 6. 跑后拉评论,diff 出本次新增的部分,扫 `[severity:blocker]` 前缀决定 exitCode
 *
 * exitCode 语义(与 `quality-guidelines.md` 一致):
 * - `0` 评审完成,无 blocker
 * - `1` 至少一条 blocker(让 pipeline fail)
 * - `2` 留给 `cli.ts` 顶层 catch-all 处理(本函数不返回 2)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as piMain } from "@earendil-works/pi-coding-agent";
import { buildPiCliArgs } from "@flower-ai/flower-providers";
import {
	AuthError,
	type BotComment,
	FileNotFoundError,
	gitlabClient,
	type MrFileChange,
} from "@flower-ai/flower-tools-gitlab";
import type { CliArgs } from "./args.js";
import { detectGitlabVersion, type GitlabVersion } from "./comments/index.js";
import extensionFactory from "./extension.js";
import { preparePiSettings } from "./pi-settings.js";
import { buildPrompt } from "./prompts.js";
import { findUnsupportedComments, getTrace, resetTrace } from "./review-trace.js";
import { resolveReviewRuntimeConfig } from "./runtime-config.js";
import { pickSkill } from "./skill-selector.js";

/**
 * E2 · MR diff 文件数上限(env `FLOWER_MAX_FILES` override,默认 50)
 *
 * 取值规则:
 * - env 缺失 → 默认 50
 * - 非数字 / 负数 / 0 → 退回默认 50(保守,避免 env 配错炸 LLM)
 *
 * @internal 暴露给单测验证 env override 行为
 */
export function resolveMaxFiles(): number {
	const raw = process.env.FLOWER_MAX_FILES;
	if (raw === undefined) return 50;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 50;
	return parsed;
}

/**
 * E2 · 按 churn(additions + deletions)降序对文件排序后取 top N
 *
 * 抽成纯函数便于单测:不依赖 GitLab client,直接对 `MrFileChange[]` 操作。
 *
 * @param all 全部 MR 变更文件
 * @param maxFiles 上限(通常 `resolveMaxFiles()` 返回值)
 * @returns 截断元数据:
 *  - `shown`:本次保留的文件数(min(all.length, maxFiles))
 *  - `total`:MR 真实文件总数
 *  - `files`:保留后的文件路径列表(按 churn 降序)
 *  - `truncated`:是否触发截断(`all.length > maxFiles`)
 *
 * @internal 暴露给单测
 */
export function applyDiffCap(
	all: MrFileChange[],
	maxFiles: number,
): { shown: number; total: number; files: string[]; truncated: boolean } {
	// 按 churn 降序;churn 相同保持原顺序(稳定排序)
	const sorted = [...all].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
	const kept = sorted.slice(0, maxFiles);
	return {
		shown: kept.length,
		total: all.length,
		files: kept.map((c) => c.path),
		truncated: all.length > maxFiles,
	};
}

/**
 * E1 · 判定 error 是否为「LLM 网关失败」(可 fail open 的范畴)
 *
 * 与 GitLab API 错误(`AuthError` / `FileNotFoundError` / 业务 schema 错)区分:
 * - LLM 网关失败 → fail open(post warning + exit 0,pipeline 不阻塞)
 * - GitLab API 错 / 配置错 → fail close(正常抛错,exit ≠ 0)
 *
 * 判定规则(按优先级):
 * 1. GitLab 已知错误类(AuthError / FileNotFoundError)→ 非 LLM 失败
 * 2. error.message 含 "LLM" / "model" / "anthropic" / "openai" / "gemini" / "provider" 等关键字 → LLM 失败
 * 3. message 含 "ECONNREFUSED" / "ETIMEDOUT" / "AbortError" / "timeout" 等网络关键字 → LLM 失败(保守,假设是 LLM 调用阶段)
 * 4. message 含 HTTP 5xx / 429 关键字 → LLM 失败(限流 / 服务端故障)
 * 5. 其他 → 非 LLM 失败(默认 fail close,避免吞掉真实 bug)
 *
 * 注:本判定是**保守 + 经验式**的;`piMain` 抛错的形态不固定(可能是 SDK Error / 自定义类),
 * 用 message 关键字 + 黑名单 GitLab 错误类来兜底。后续踩到边界 case 再细化。
 *
 * @internal 暴露给单测
 */
export function isLlmFailure(err: unknown): boolean {
	// 1. GitLab 错误类:明确非 LLM 失败
	if (err instanceof AuthError) return false;
	if (err instanceof FileNotFoundError) return false;

	if (!(err instanceof Error)) return false;
	const message = err.message.toLowerCase();
	const errorName = err.name.toLowerCase();

	// 2. 关键字命中 LLM / provider 相关 → LLM 失败
	const llmKeywords = [
		"llm",
		"provider",
		"anthropic",
		"openai",
		"gemini",
		"model",
		"stream",
		"completion",
		"havefun",
		"sse",
		"finish_reason",
		"message_stop",
	];
	if (llmKeywords.some((k) => message.includes(k) || errorName.includes(k))) {
		return true;
	}

	// 3. 网络 / 超时关键字
	const networkKeywords = [
		"econnrefused",
		"etimedout",
		"aborterror",
		"timeout",
		"fetch failed",
		"network",
		"no data",
		"empty response",
		"ended without",
		"stream ended",
		"terminated",
		"socket hang up",
		"body_timeout",
	];
	if (networkKeywords.some((k) => message.includes(k) || errorName.includes(k))) {
		return true;
	}

	// 4. HTTP 5xx / 429
	if (/\b5\d\d\b/.test(message)) return true;
	if (/\b429\b/.test(message)) return true;

	// 5. 默认非 LLM 失败(fail close)
	return false;
}

/**
 * reviewer 总评审软超时错误
 *
 * 用独立错误类让 fail-open 文案能区分「LLM 网关异常」与「自动评审超时」。
 */
export class ReviewSoftTimeoutError extends Error {
	override readonly name = "ReviewSoftTimeoutError";

	/**
	 * @param timeoutMs 触发软超时的毫秒数
	 */
	constructor(readonly timeoutMs: number) {
		super(`自动评审超时:${timeoutMs}ms 内 piMain 未完成`);
	}
}

/**
 * 评审结果
 *
 * - `blockerCount`:本轮 LLM 发出的 blocker 级 line_comment 数量(从 `review-trace.ts` 单例取,与
 *   `reviewer_list_my_blockers` 工具同源真值;exit 1 时供 cli.ts 写入预告日志)
 * - `unsupportedFileCount`:本轮「无依据评论」涉及的文件数(LLM 评论了但没读过)
 *
 * 两条字段在 cli.ts 中拼装出双路径文案 `N 个 blocker 评论 + M 个无依据评论触发的 blocker`,
 * 让 trace 读者直接区分 exit 1 是哪条路径触发(避免 unsupported-only 时显示 "0 个 blocker" 反而误导)。
 */
export interface ReviewResult {
	exitCode: 0 | 1 | 2;
	skillUsed: string;
	blockerCount: number;
	unsupportedFileCount: number;
}

/**
 * `scanForBlockers` 入参(对象形式,便于增量加字段)
 *
 * Phase 2 起统一改用对象签名;旧的位置参数形式 `scanForBlockers(beforeIds, after)`
 * 由重载兼容(见下方 overload 声明)。
 */
export interface ScanForBlockersInput {
	/** 跑前 snapshot 的评论 id 集合(用于过滤本次新增) */
	beforeIds: Set<number>;
	/** 跑后拉到的全部 bot 评论 */
	after: BotComment[];
	/**
	 * 「无依据评论」涉及的文件路径(LLM 评论了但没读过的文件)
	 *
	 * 留空表示本次评审不做无依据检查(向后兼容、纯函数单测)。
	 */
	unsupportedCommentFiles?: string[];
}

/**
 * 扫描评论 list,判断是否含本次新增的 blocker(或「无依据评论」blocker)
 *
 * 抽成纯函数便于单测覆盖,不依赖 GitLab / pi-coding-agent。
 *
 * 两种 blocker 触发条件:
 * 1. **真实 blocker**:本次新增评论中至少有一条以 `[severity:blocker]` 起头
 * 2. **无依据评论**:LLM 评论了某文件但没读过该文件(`unsupportedCommentFiles` 非空)
 *
 * @returns 是否应当 fail pipeline(本次新增 blocker / 无依据评论 任一命中)
 */
export function scanForBlockers(input: ScanForBlockersInput): boolean;
/**
 * 旧的位置参数签名(向后兼容)
 *
 * @deprecated 新代码请用对象签名 `scanForBlockers({ beforeIds, after, ... })`
 */
export function scanForBlockers(beforeIds: Set<number>, after: BotComment[]): boolean;
export function scanForBlockers(
	inputOrBeforeIds: ScanForBlockersInput | Set<number>,
	maybeAfter?: BotComment[],
): boolean {
	// 重载分发:Set<number> + array 形式 → 旧位置参数;否则按 input 对象
	const input: ScanForBlockersInput =
		inputOrBeforeIds instanceof Set ? { beforeIds: inputOrBeforeIds, after: maybeAfter ?? [] } : inputOrBeforeIds;

	// 1. 真实 blocker:本次新增评论含 blocker marker
	//    - 新格式:HTML 注释 <!-- severity: blocker -->(藏起来不影响 GitLab 渲染观感)
	//    - 旧格式:[severity:blocker] 字面前缀(向后兼容旧评论)
	const blockerMarker = /<!--\s*severity:\s*blocker\s*-->|^\[severity:blocker\]/;
	const hasNewBlocker = input.after.filter((c) => !input.beforeIds.has(c.id)).some((c) => blockerMarker.test(c.body));
	if (hasNewBlocker) return true;

	// 2. 无依据评论:LLM 对某些文件发了评论但没读过这些文件
	if (input.unsupportedCommentFiles && input.unsupportedCommentFiles.length > 0) {
		return true;
	}

	return false;
}

/**
 * 运行一次评审
 *
 * @param args - CLI 参数
 * @returns 评审结果,含 exitCode(0/1)与实际使用的 skill 名
 * @throws 当 MR IID 既未指定也无 `CI_MERGE_REQUEST_IID` env 时抛错(由 cli.ts 顶层 catch 处理为 exitCode 2)
 */
export async function runReview(args: CliArgs): Promise<ReviewResult> {
	const mrIid = args.mrIid ?? Number.parseInt(process.env.CI_MERGE_REQUEST_IID ?? "", 10);
	if (Number.isNaN(mrIid)) {
		throw new Error("未指定 MR IID,且 CI_MERGE_REQUEST_IID 环境变量也没有");
	}
	const projectId = process.env.CI_PROJECT_ID;

	// 0. 重置 review-trace(同一进程内若再次运行,清掉上一次的 readFiles / lineComments)
	resetTrace();

	// 1. 选 skill
	const skill = args.skill ?? (await pickSkill());
	console.log(`[code-reviewer] 使用 skill: ${skill}`);

	// 2. 探测 GitLab 版本(决定 prompt 中 §6.6 alert 块降级路径)
	//    探测失败 → null,prompt 自动走 ⚠️ blockquote 兜底,LLM 学到的就是降级模板
	let gitlabVersion: GitlabVersion | null = null;
	if (process.env.GITLAB_TOKEN) {
		gitlabVersion = await detectGitlabVersion();
	}

	// 3. E2 · 拉 MR 文件 churn,触发 cap → 截断元数据进 prompt(让 LLM 知道"只看 top N")
	//    dryRun / 无 projectId → 跳过(本地测试无 GitLab 上下文)
	const enableBlockerScan = !args.dryRun && projectId !== undefined;
	let truncation: { shown: number; total: number; files: string[] } | undefined;
	if (enableBlockerScan && projectId !== undefined) {
		try {
			const all = await gitlabClient().getMrFileChanges(projectId, mrIid);
			const cap = applyDiffCap(all, resolveMaxFiles());
			if (cap.truncated) {
				truncation = { shown: cap.shown, total: cap.total, files: cap.files };
				console.warn(`[code-reviewer] MR 文件数 ${cap.total} 超 cap,本次只评 top ${cap.shown}`);
			}
		} catch (err) {
			// 失败不阻断评审:LLM 仍能跑,只是 prompt 没有截断提示
			console.warn("[code-reviewer] 拉取 MR 文件 churn 失败,跳过 diff cap 检查:", err);
		}
	}

	// 4. 构造 prompt(把 gitlabVersion + 截断元数据 + MR source branch 传入)
	// 注入 sourceBranch:LLM 在 prompt 里能看到具体 branch 名,主动显式传 ref(而非依赖工具兜底)
	const skillFilePath = join(getSkillsDir(), `${skill}.md`);
	const sourceBranch = process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME?.trim();
	const runtimeConfig = resolveReviewRuntimeConfig();
	const prompt = buildPrompt({
		skillFilePath,
		dryRun: args.dryRun,
		gitlabVersion,
		contextReadBatchSize: runtimeConfig.contextReadBatchSize,
		contextReadDefaultLines: runtimeConfig.contextReadDefaultLines,
		contextReadMaxLines: runtimeConfig.contextReadMaxLines,
		...(truncation !== undefined ? { truncation } : {}),
		...(sourceBranch ? { sourceBranch } : {}),
	});

	// 5. 跑前 snapshot bot 评论 id 集合(用于跑后 diff)
	//    缺 CI_PROJECT_ID(本地调试场景)或 dryRun 时跳过 — 此时 blocker 扫描也降级到不跑
	let beforeIds: Set<number> = new Set();
	if (enableBlockerScan && projectId !== undefined) {
		try {
			const before = await gitlabClient().getBotComments(projectId, mrIid);
			beforeIds = new Set(before.map((c) => c.id));
		} catch (err) {
			console.warn("[code-reviewer] 跑前评论 snapshot 失败,blocker 扫描将跳过:", err);
		}
	}

	// 6. env → pi CLI argv,7. 跑 pi-coding-agent print 模式 + E1 LLM fail open
	//    extensionFactories 注入 provider / compliance / tools / review-trace 监听器
	const piArgv = buildPiCliArgs({ prompt });
	const piAgentDir = preparePiSettings(runtimeConfig);
	console.log(
		`[code-reviewer] pi settings 已注入: agent_dir=${piAgentDir}, provider_timeout_ms=${runtimeConfig.llmRequestTimeoutMs}, provider_retries=${runtimeConfig.llmProviderMaxRetries}, agent_retries=${runtimeConfig.llmAgentMaxRetries}, review_timeout_ms=${runtimeConfig.reviewTimeoutMs}, context_lines=${runtimeConfig.contextReadDefaultLines}/${runtimeConfig.contextReadMaxLines}`,
	);
	try {
		await runPiMainWithSoftTimeout(
			() =>
				piMain(piArgv, {
					extensionFactories: [extensionFactory],
				}),
			runtimeConfig.reviewTimeoutMs,
		);
	} catch (err) {
		// E1:LLM 网关失败 → fail open(post warning 评论 + exit 0,pipeline 不阻塞)
		// 非 LLM 失败(GitLab API 错 / 配置错) → 正常抛错,由 cli.ts 顶层 catch 转 exit 2
		if (isLlmFailure(err)) {
			console.warn("[code-reviewer] LLM 网关失败,fail open + 发 warning 评论:", err);
			if (enableBlockerScan && projectId !== undefined) {
				try {
					await gitlabClient().postMrComment(projectId, mrIid, buildLlmFailureNotice(err), "minor");
				} catch (postErr) {
					console.warn("[code-reviewer] 发表 LLM 失败 warning 评论失败:", postErr);
				}
			}
			// **不**调 scanForBlockers(没有 LLM 评论可扫,blocker 不应虚报)
			return { exitCode: 0, skillUsed: skill, blockerCount: 0, unsupportedFileCount: 0 };
		}
		throw err;
	}

	// 8. 跑后扫 blocker(包含「无依据评论」检查)
	if (!enableBlockerScan || projectId === undefined) {
		return { exitCode: 0, skillUsed: skill, blockerCount: 0, unsupportedFileCount: 0 };
	}
	try {
		const after = await gitlabClient().getBotComments(projectId, mrIid);

		// 「无依据评论」:LLM 对哪些文件发了 line_comment 但没读过这些文件
		const trace = getTrace();
		const unsupportedFiles = findUnsupportedComments(trace.readFiles, trace.lineComments);
		// 本轮 blocker 级 line_comment 数量 — 与 reviewer_list_my_blockers 工具同源真值
		// (从 trace 单例取,不再二次 filter `after - beforeIds`,避免双源漂移)
		const lineBlockerCount = trace.lineComments.filter((c) => c.severity === "blocker").length;

		// 若有无依据评论,先发一条整体 blocker 评论让评审作者看见(并被纳入 scan)
		if (unsupportedFiles.length > 0) {
			const body = buildUnsupportedCommentNotice(unsupportedFiles);
			try {
				await gitlabClient().postMrComment(projectId, mrIid, body, "blocker");
			} catch (err) {
				console.warn("[code-reviewer] 发表「无依据评论」blocker 通知失败:", err);
			}
		}

		const hasBlocker = scanForBlockers({
			beforeIds,
			after,
			unsupportedCommentFiles: unsupportedFiles,
		});
		return {
			exitCode: hasBlocker ? 1 : 0,
			skillUsed: skill,
			blockerCount: lineBlockerCount,
			unsupportedFileCount: unsupportedFiles.length,
		};
	} catch (err) {
		// 评论已发,扫描失败不应反向定罪整个评审
		console.warn("[code-reviewer] 跑后评论拉取失败,blocker 扫描跳过:", err);
		return { exitCode: 0, skillUsed: skill, blockerCount: 0, unsupportedFileCount: 0 };
	}
}

/**
 * 拼装「无依据评论」blocker 通知正文(整体评论 body)
 *
 * 抽成函数便于单测覆盖 + 模板调整集中。
 *
 * @param files 无依据评论涉及的文件路径(已去重 + 排序)
 * @returns markdown body(注:不带 `[severity:blocker]` 前缀,前缀由 `postMrComment` 自动添加)
 */
export function buildUnsupportedCommentNotice(files: string[]): string {
	const list = files.map((f) => `- \`${f}\``).join("\n");
	return `无依据评论:对以下文件发出评论但未调用 \`gitlab_get_file_content\` 读取过相关代码上下文\n\n${list}\n\n请在读取该文件相关行窗后再评审。`;
}

/**
 * E1 · 拼装 LLM 网关失败 warning 评论正文
 *
 * 文案严格按 design.md §5.1:让评审人手工 review,告知错误已上报 SIEM。
 *
 * 抽成函数便于单测断言文本(且未来调整文案集中改一处)。
 *
 * @returns markdown body(注:不带 severity 前缀,前缀由 `postMrComment` 自动添加)
 */
export function buildLlmFailureNotice(err?: unknown): string {
	if (err instanceof ReviewSoftTimeoutError) {
		return "⚠️ flower-code-reviewer 自动评审超时,未能完成自动评审,请手工 review 本 MR。\n\n错误详情已上报 SIEM。";
	}
	return "⚠️ flower-code-reviewer 因 LLM 网关异常未能完成自动评审,请手工 review 本 MR。\n\n错误详情已上报 SIEM。";
}

/**
 * 带总评审软超时运行 piMain
 *
 * @param run 实际执行 piMain 的函数
 * @param timeoutMs 软超时毫秒数;0 表示关闭
 * @returns piMain 原始返回
 * @throws 超时时抛 `ReviewSoftTimeoutError`
 */
export async function runPiMainWithSoftTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
	if (timeoutMs <= 0) {
		return run();
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new ReviewSoftTimeoutError(timeoutMs)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/**
 * 获取 skills 目录的绝对路径
 *
 * 通过 `import.meta.url` 计算,容器里(`dist/`)和本地 dev(`src/`)都能正确解析。
 */
function getSkillsDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "skills");
}
