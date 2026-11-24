/**
 * cli.ts 单元测试
 *
 * 覆盖退出提示文案和经 npm 风格符号链接启动的 CLI 入口。
 *
 * 对应 PRD AC3.1-AC3.4(Fix C · exit 1 预告日志)。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { formatExit1Notice } from "../cli.js";

it.skipIf(process.platform === "win32")("通过 npm 风格的符号链接运行 CLI 会显示帮助", () => {
	const cwd = mkdtempSync(join(tmpdir(), "flower-review-"));
	try {
		const entry = join(cwd, "flower-review");
		symlinkSync(fileURLToPath(new URL("../cli.ts", import.meta.url)), entry);
		const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx"));
		const help = execFileSync(process.execPath, ["--import", tsx.href, entry, "--help"], {
			cwd,
			encoding: "utf8",
		});
		expect(help).toContain("flower-review");
		expect(help).toContain("--dry-run");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

describe("formatExit1Notice · exit 1 预告日志文案拼接", () => {
	it("AC3.1 · blockerCount=3 + unsupportedFileCount=0 → 只显示 line_comment 路径", () => {
		const notice = formatExit1Notice({ blockerCount: 3, unsupportedFileCount: 0 });
		expect(notice).toContain("3 个 blocker 评论");
		expect(notice).toContain("按设计 exit 1");
		expect(notice).not.toContain("无依据评论触发");
		expect(notice).not.toContain("0 个"); // 缺一边不能拼出 "0 个 ..." 误导
	});

	it("AC3.3 · blockerCount=0 + unsupportedFileCount=2 → 只显示无依据评论路径", () => {
		const notice = formatExit1Notice({ blockerCount: 0, unsupportedFileCount: 2 });
		expect(notice).toContain("2 个无依据评论触发的 blocker");
		expect(notice).toContain("按设计 exit 1");
		expect(notice).not.toContain("0 个 blocker 评论"); // 关键断言:不拼出 "0 个 blocker 评论"
		expect(notice).not.toContain("blocker 评论 +"); // 没有 + 号拼接
	});

	it("AC3.4 · blockerCount=2 + unsupportedFileCount=1 → 两条路径用 ' + ' 拼接", () => {
		const notice = formatExit1Notice({ blockerCount: 2, unsupportedFileCount: 1 });
		expect(notice).toContain("2 个 blocker 评论 + 1 个无依据评论触发的 blocker");
		expect(notice).toContain("按设计 exit 1");
	});

	it("文案含 Runner 行为说明,帮 trace 读者理解 'Job failed' 是预期信号", () => {
		const notice = formatExit1Notice({ blockerCount: 1, unsupportedFileCount: 0 });
		expect(notice).toContain('Runner "Job failed" 是预期信号');
		expect(notice).toContain("不是脚本崩溃");
	});

	it("文案以 [code-reviewer] 前缀开头(便于 trace grep 定位)", () => {
		const notice = formatExit1Notice({ blockerCount: 5, unsupportedFileCount: 0 });
		expect(notice.startsWith("[code-reviewer]")).toBe(true);
	});

	// AC3.2 · exitCode=0 时根本不该调本函数 — 此条由 main() 控制,纯函数层面无法断言
	// 在 Phase 6 e2e 中,无 blocker 跑会观察到 trace 倒数第 2 行不再有此预告(只有 Runner 自身的 "Job succeeded")
});
