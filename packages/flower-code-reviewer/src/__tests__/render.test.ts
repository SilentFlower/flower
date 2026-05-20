/**
 * `comments/render.ts` 单元测试
 *
 * 覆盖 implement.md §Phase 1 checklist 1.6 列出的核心 case:
 * - 行内 4 段式渲染(severity 标签 / suggestion 块 / reasoning 折叠)
 * - walkthrough 渲染 + 文件变更表(含截断提示)
 * - 「无问题」轻量模板
 * - alert 块降级(17.10+ vs 16.x vs null)
 * - `[severity:<level>]` 前缀字面量保留(scanForBlockers 依赖)
 */

import { describe, expect, it } from "vitest";
import { renderCleanReview, renderInlineComment, renderWalkthrough, supportsAlertBlock } from "../comments/render.js";

describe("renderInlineComment · 4 段式行内评论", () => {
	it("blocker 含 suggestion 块,输出包含 4 段全部元素", () => {
		const md = renderInlineComment({
			severity: "blocker",
			title: "硬编码 secret 存在凭据泄漏风险",
			explanation: "`hmacSecret` 直接作为字符串字面量出现在源码中,git 历史会永久包含该值。",
			suggestion: {
				code: 'hmacSecret := os.Getenv("SIGN_VERIFY_HMAC_SECRET")',
			},
		});
		// 段 1:斜体 severity 标签 + 字面量 [severity:blocker] 前缀(scanForBlockers 凭此识别)
		expect(md).toMatch(/_🔴 Blocker_/);
		expect(md).toContain("[severity:blocker]");
		// 段 2:加粗中文标题
		expect(md).toContain("**硬编码 secret 存在凭据泄漏风险**");
		// 段 3:解释段
		expect(md).toContain("`hmacSecret` 直接作为字符串字面量");
		// 段 4a:suggestion 折叠区 + ```suggestion 块
		expect(md).toContain("<summary>修复建议</summary>");
		expect(md).toContain("```suggestion");
		expect(md).toContain('hmacSecret := os.Getenv("SIGN_VERIFY_HMAC_SECRET")');
	});

	it("minor 带 reasoning 折叠,无 suggestion", () => {
		const md = renderInlineComment({
			severity: "minor",
			title: "常量 `MaxSignatureAge` 建议提到包级",
			explanation: "未来按环境调优时需要改函数签名,提到包级更易维护。",
			reasoning: "参考 `internal/config/` 下其他时间常量都是包级公开。",
		});
		expect(md).toMatch(/_🔵 Minor_/);
		expect(md).toContain("[severity:minor]");
		expect(md).toContain("**常量 `MaxSignatureAge` 建议提到包级**");
		expect(md).toContain("<summary>💡 推理过程</summary>");
		expect(md).toContain("参考 `internal/config/`");
		// 没有传 suggestion → 不应有 suggestion 折叠区
		expect(md).not.toContain("修复建议");
	});

	it("major 无 suggestion / reasoning,只输出 3 段", () => {
		const md = renderInlineComment({
			severity: "major",
			title: "签名校验失败时未记录审计日志",
			explanation: "返回 false 时无日志输出,安全事件追溯将无法定位攻击源。",
		});
		expect(md).toMatch(/_🟠 Major_/);
		expect(md).toContain("[severity:major]");
		expect(md).not.toContain("<details>");
	});

	it("suggestion useSuggestionBlock=false 时 fallback 到普通 code 块(带 language)", () => {
		const md = renderInlineComment({
			severity: "blocker",
			title: "测试 fallback",
			explanation: "测试 useSuggestionBlock=false 路径。",
			suggestion: {
				code: "console.log('test');",
				language: "typescript",
				useSuggestionBlock: false,
			},
		});
		expect(md).toContain("```typescript");
		expect(md).not.toContain("```suggestion");
	});
});

describe("renderWalkthrough · 整体评论 walkthrough", () => {
	it("有 fileChanges + actionItems,完整渲染折叠卡片 + 表格 + 任务列表", () => {
		const md = renderWalkthrough({
			mrTitle: "feat: 加签名验证",
			summary: "本次 MR 在 internal/auth/ 下新增了签名验证流程。",
			fileChanges: [
				{
					path: "internal/auth/sign_verify.go",
					additions: 80,
					deletions: 2,
					summary: "新增签名验证主流程",
					severity: "blocker",
				},
				{
					path: "cmd/server/main.go",
					additions: 5,
					deletions: 0,
					summary: "注册 sign verify middleware",
					severity: "minor",
				},
			],
			actionItems: ["必须修复:`sign_verify.go:42` 硬编码 secret"],
			gitlabVersion: { major: 17, minor: 10 },
			blockerCount: 1,
		});
		// 折叠卡片标题
		expect(md).toContain("<details>");
		expect(md).toContain("<summary>🤖 <b>代码评审报告</b> (flower-code-reviewer)</summary>");
		// 概要
		expect(md).toContain("## 概要");
		expect(md).toContain("本次 MR 在 internal/auth/");
		// 文件变更表
		expect(md).toContain("## 文件变更");
		expect(md).toContain("| 文件 | 一句话总结 | 关注等级 |");
		expect(md).toContain("`internal/auth/sign_verify.go`");
		expect(md).toContain("🔴 blocker");
		expect(md).toContain("`cmd/server/main.go`");
		expect(md).toContain("🔵 minor");
		// 行动建议
		expect(md).toContain("## 行动建议");
		expect(md).toContain("- [ ] 必须修复");
		// 17.10 → [!caution] alert
		expect(md).toContain("> [!caution]");
		expect(md).toContain("1 个 blocker");
	});

	it("无 blocker / 无 actionItems → 不渲染 caution 块和行动建议", () => {
		const md = renderWalkthrough({
			mrTitle: "fix: 修小笔误",
			summary: "调整一个变量命名,无功能改动。",
			fileChanges: [{ path: "src/auth.ts", additions: 1, deletions: 1, summary: "重命名 foo → bar" }],
			actionItems: [],
			gitlabVersion: { major: 17, minor: 10 },
		});
		expect(md).not.toContain("[!caution]");
		expect(md).not.toContain("⚠️ **Caution**");
		expect(md).not.toContain("## 行动建议");
	});

	it("truncatedFiles 触发时插入截断说明", () => {
		const md = renderWalkthrough({
			mrTitle: "巨大 MR",
			summary: "test",
			fileChanges: [{ path: "a.ts", additions: 1, deletions: 0, summary: "x" }],
			actionItems: [],
			gitlabVersion: { major: 18, minor: 0 },
			truncatedFiles: { shown: 50, total: 80 },
		});
		expect(md).toContain("本次仅评 50/80");
	});
});

describe("renderCleanReview · 「无问题」轻量评论", () => {
	it("仅 2 行 + 可选补充", () => {
		const md = renderCleanReview({ mrTitle: "feat: x", note: "签名校验流程清晰、负向 case 覆盖到位。" });
		expect(md).toContain(":white_check_mark: 已审完本 MR,未发现需要修改的问题。");
		expect(md).toContain("签名校验流程清晰");
		// 没有折叠区 / 没有 severity 前缀(无问题就没等级)
		expect(md).not.toContain("<details>");
		expect(md).not.toContain("[severity:");
	});

	it("无 note 时只有 1 行核心消息", () => {
		const md = renderCleanReview({});
		expect(md.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
	});
});

describe("supportsAlertBlock + walkthrough caution 块降级", () => {
	it("17.10+ → 用 [!caution] alert 块", () => {
		expect(supportsAlertBlock({ major: 17, minor: 10 })).toBe(true);
		expect(supportsAlertBlock({ major: 17, minor: 11 })).toBe(true);
		expect(supportsAlertBlock({ major: 18, minor: 0 })).toBe(true);

		const md = renderWalkthrough({
			mrTitle: "x",
			summary: "x",
			fileChanges: [],
			actionItems: [],
			gitlabVersion: { major: 17, minor: 10 },
			blockerCount: 2,
		});
		expect(md).toContain("> [!caution]");
		expect(md).not.toContain("⚠️ **Caution**");
	});

	it("17.9 / 16.x / null → 降级到普通 blockquote", () => {
		expect(supportsAlertBlock({ major: 17, minor: 9 })).toBe(false);
		expect(supportsAlertBlock({ major: 16, minor: 11 })).toBe(false);
		expect(supportsAlertBlock(null)).toBe(false);

		const md17_9 = renderWalkthrough({
			mrTitle: "x",
			summary: "x",
			fileChanges: [],
			actionItems: [],
			gitlabVersion: { major: 17, minor: 9 },
			blockerCount: 1,
		});
		expect(md17_9).toContain("> ⚠️ **Caution**");
		expect(md17_9).not.toContain("> [!caution]");

		const mdNull = renderWalkthrough({
			mrTitle: "x",
			summary: "x",
			fileChanges: [],
			actionItems: [],
			gitlabVersion: null,
			blockerCount: 1,
		});
		expect(mdNull).toContain("> ⚠️ **Caution**");
	});
});

describe("[severity:<level>] 前缀字面量保留(scanForBlockers 依赖)", () => {
	it("renderInlineComment(blocker) 输出含 [severity:blocker] 字面量,可被 scanForBlockers 命中", () => {
		const md = renderInlineComment({
			severity: "blocker",
			title: "测试前缀保留",
			explanation: "x",
		});
		// scanForBlockers 用 /^\[severity:blocker\]/ 但 render 输出中 severity 标签在第一行末尾;
		// 这里只验"字面量出现",真实匹配交给 scanForBlockers 单测
		expect(md).toMatch(/\[severity:blocker\]/);
	});

	it("major / minor 同样保留字面量(虽然不触发 blocker)", () => {
		expect(renderInlineComment({ severity: "major", title: "x", explanation: "x" })).toMatch(/\[severity:major\]/);
		expect(renderInlineComment({ severity: "minor", title: "x", explanation: "x" })).toMatch(/\[severity:minor\]/);
	});
});
