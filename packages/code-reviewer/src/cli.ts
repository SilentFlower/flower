#!/usr/bin/env node
/**
 * code-reviewer CLI 入口
 *
 * 设计:
 * 1. 解析命令行参数,确定要评审的 MR
 * 2. 根据 MR 修改的文件类型,挑选合适的 skill
 * 3. 调 pi-coding-agent 的 main(以 print 模式),挂上我们的扩展工厂
 * 4. pi 跑完后扫描评论,如果有 blocker 就 exit 1
 */

import { parseArgs } from "./args.js";
import { runReview } from "./run.js";

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const result = await runReview(args);
	process.exit(result.exitCode);
}

main().catch((err) => {
	console.error("[code-reviewer] 运行失败:", err);
	process.exit(2);
});
