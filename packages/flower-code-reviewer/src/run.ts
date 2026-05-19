/**
 * 评审流程主控
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { main as piMain } from "@earendil-works/pi-coding-agent";
import extensionFactory from "./extension.js";
import { buildPrompt } from "./prompts.js";
import { pickSkill } from "./skill-selector.js";
import type { CliArgs } from "./args.js";

/**
 * 评审结果
 */
export interface ReviewResult {
	exitCode: 0 | 1 | 2;
	skillUsed: string;
}

/**
 * 运行一次评审
 *
 * @param args - CLI 参数
 */
export async function runReview(args: CliArgs): Promise<ReviewResult> {
	const mrIid = args.mrIid ?? Number.parseInt(process.env.CI_MERGE_REQUEST_IID ?? "", 10);
	if (Number.isNaN(mrIid)) {
		throw new Error("未指定 MR IID,且 CI_MERGE_REQUEST_IID 环境变量也没有");
	}

	// 1. 选 skill
	const skill = args.skill ?? (await pickSkill());
	console.log(`[code-reviewer] 使用 skill: ${skill}`);

	// 2. 构造 prompt
	const skillFilePath = join(getSkillsDir(), `${skill}.md`);
	const prompt = buildPrompt({ skillFilePath, dryRun: args.dryRun });

	// 3. 调 pi-coding-agent 的 print 模式
	//    通过 extensionFactories 注入我们的扩展
	await piMain(["-p", prompt], {
		extensionFactories: [extensionFactory],
	});

	// TODO: pi 退出后,从 GitLab 拉本次发的评论,扫描 severity=blocker
	//       目前先返回 0
	return { exitCode: 0, skillUsed: skill };
}

/**
 * 获取 skills 目录的绝对路径
 */
function getSkillsDir(): string {
	// 假设 dist 与 skills 是同级目录
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "skills");
}
