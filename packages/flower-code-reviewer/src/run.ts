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
import { type BotComment, gitlabClient } from "@flower-ai/flower-tools-gitlab";
import type { CliArgs } from "./args.js";
import extensionFactory from "./extension.js";
import { buildPrompt } from "./prompts.js";
import { pickSkill } from "./skill-selector.js";

/**
 * 评审结果
 */
export interface ReviewResult {
	exitCode: 0 | 1 | 2;
	skillUsed: string;
}

/**
 * 扫描评论 list,判断是否含本次新增的 blocker
 *
 * 抽成纯函数便于单测覆盖,不依赖 GitLab / pi-coding-agent。
 *
 * @param beforeIds - 跑前 snapshot 的评论 id 集合
 * @param after - 跑后拉到的全部评论
 * @returns 本次新增评论里**是否**至少有一条以 `[severity:blocker]` 起头
 */
export function scanForBlockers(beforeIds: Set<number>, after: BotComment[]): boolean {
	return after.filter((c) => !beforeIds.has(c.id)).some((c) => /^\[severity:blocker\]/.test(c.body));
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

	// 1. 选 skill
	const skill = args.skill ?? (await pickSkill());
	console.log(`[code-reviewer] 使用 skill: ${skill}`);

	// 2. 构造 prompt
	const skillFilePath = join(getSkillsDir(), `${skill}.md`);
	const prompt = buildPrompt({ skillFilePath, dryRun: args.dryRun });

	// 3. 跑前 snapshot bot 评论 id 集合(用于跑后 diff)
	//    缺 CI_PROJECT_ID(本地调试场景)或 dryRun 时跳过 — 此时 blocker 扫描也降级到不跑
	const enableBlockerScan = !args.dryRun && projectId !== undefined;
	let beforeIds: Set<number> = new Set();
	if (enableBlockerScan && projectId !== undefined) {
		try {
			const before = await gitlabClient().getBotComments(projectId, mrIid);
			beforeIds = new Set(before.map((c) => c.id));
		} catch (err) {
			console.warn("[code-reviewer] 跑前评论 snapshot 失败,blocker 扫描将跳过:", err);
		}
	}

	// 4. env → pi CLI argv(R4),5. 跑 pi-coding-agent print 模式
	//    extensionFactories 注入 provider / compliance / tools(具体注册顺序见 extension.ts)
	const piArgv = buildPiCliArgs({ prompt });
	await piMain(piArgv, {
		extensionFactories: [extensionFactory],
	});

	// 6. 跑后扫 blocker
	if (!enableBlockerScan || projectId === undefined) {
		return { exitCode: 0, skillUsed: skill };
	}
	try {
		const after = await gitlabClient().getBotComments(projectId, mrIid);
		const hasBlocker = scanForBlockers(beforeIds, after);
		return { exitCode: hasBlocker ? 1 : 0, skillUsed: skill };
	} catch (err) {
		// 评论已发,扫描失败不应反向定罪整个评审
		console.warn("[code-reviewer] 跑后评论拉取失败,blocker 扫描跳过:", err);
		return { exitCode: 0, skillUsed: skill };
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
