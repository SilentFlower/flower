#!/usr/bin/env node
/**
 * code-reviewer CLI 入口
 *
 * 设计:
 * 1. 解析命令行参数,确定要评审的 MR
 * 2. 根据 MR 修改的文件类型,挑选合适的 skill
 * 3. 由共享运行时调度 pi SDK 会话
 * 4. pi 跑完后扫描评论,如果有 blocker 就 exit 1
 */

import { parseArgs } from "./args.js";

/**
 * 拼装 exit 1 前的预告日志文案
 *
 * 让 trace 读者明白下方 Runner `Job failed` 是 reviewer 设计上的门卫信号(发现 blocker 主动 exit 1),
 * 而非脚本崩溃。文案按两条独立 exit 1 触发路径分段拼接:
 * - `blockerCount`:LLM 发出的 blocker 级 line_comment 数
 * - `unsupportedFileCount`:「无依据评论」触发的 blocker 涉及文件数
 *
 * 抽成 export 纯函数便于单测;`main` 仅负责调本函数 + `console.log` + `process.exit`。
 *
 * @param result `runReview` 返回的评审结果(只用到两条计数字段)
 * @returns 完整的 console.log 文案
 */
export function formatExit1Notice(result: { blockerCount: number; unsupportedFileCount: number }): string {
	const parts: string[] = [];
	if (result.blockerCount > 0) {
		parts.push(`${result.blockerCount} 个 blocker 评论`);
	}
	if (result.unsupportedFileCount > 0) {
		parts.push(`${result.unsupportedFileCount} 个无依据评论触发的 blocker`);
	}
	return `[code-reviewer] 评审完成:发现 ${parts.join(" + ")},按设计 exit 1(下方 Runner "Job failed" 是预期信号,不是脚本崩溃)`;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	// 参数错误和帮助可直接返回，评审时再加载宿主及 SDK。
	const { runReview } = await import("./run.js");
	const result = await runReview(args);
	if (result.exitCode === 1 && result.blockerCount + result.unsupportedFileCount > 0) {
		console.log(formatExit1Notice(result));
	}
	process.exit(result.exitCode);
}

// 由 Node 判断入口，兼容 npm 安装的符号链接，并让导入此模块的单元测试继续运行。
if (import.meta.main) {
	main().catch((err) => {
		console.error("[code-reviewer] 运行失败:", err);
		process.exit(2);
	});
}
