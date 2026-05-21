/**
 * `prompts.ts` 单元测试:GitLab 版本动态切换 alert 块 + 7 条硬约束都在 prompt 里
 *
 * 覆盖 implement.md §Phase 2 关键改动:
 * - 第 7 条约束(每变更文件必读 gitlab_get_file_content)写进 prompt
 * - §6.6 alert 块根据 gitlabVersion 动态切换(17.10+ vs 旧版本)
 * - severity 词表 `blocker | major | minor`(不是 `info | warning`)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../prompts.js";

// 拿一个真实存在的 skill 文件路径,避免 readSkill 走 fallback
const here = dirname(fileURLToPath(import.meta.url));
const skillFilePath = join(here, "..", "..", "skills", "general.md");

describe("buildPrompt · 7 条硬约束", () => {
	it("第 7 条:每变更文件必读 gitlab_get_file_content", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("gitlab_get_file_content");
		expect(prompt).toContain("每个变更文件");
		expect(prompt).toContain("无依据评论");
		expect(prompt).toContain("scanForBlockers");
	});

	it("severity 词表用 blocker / major / minor(不是 info / warning)", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		// 风格 / 命名 / 建议性问题打 major 或 minor(已对齐 Phase 2 词表)
		expect(prompt).toContain("\\`major\\` 或 \\`minor\\`".replace(/\\/g, ""));
		expect(prompt).not.toContain("`info`");
		expect(prompt).not.toContain("`warning`");
	});

	it("工作流程含拉文件内容步骤(`gitlab_get_file_content` 在编号步骤里)", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		// 步骤 4 / 5 提到拉文件内容
		expect(prompt).toMatch(/4\.\s+\*\*每个变更文件\*\*/);
		expect(prompt).toMatch(/5\.\s+.*相关上下文/);
	});

	it("评论 markdown 样式段落含 6 项原有约束 + 第 7 项新约束", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		// 6 项原有约束的关键字段
		expect(prompt).toContain("4 段式");
		expect(prompt).toContain("walkthrough");
		expect(prompt).toContain("「无问题」轻量评论");
		expect(prompt).toContain("quick action 禁令");
		expect(prompt).toContain("GLFM 兼容");
		expect(prompt).toContain("🔴 **阻塞**");
		// 第 7 项
		expect(prompt).toContain("真实代码上下文约束");
	});
});

describe("buildPrompt · §6.6 alert 块动态切换", () => {
	/**
	 * 提取 §6.6 示例 markdown 代码块内的内容(true source of truth,
	 * 因为说明文字里也可能提到对应/对立语法,不应影响判定)
	 */
	function extractAlertExampleBlock(prompt: string): string {
		// 模板里 §6.6 的 ```markdown ... ``` 块紧跟在 "示例 6" 标题后
		const match = prompt.match(/### 示例 6[\s\S]*?```markdown([\s\S]*?)```/);
		return match?.[1] ?? "";
	}

	it("GitLab 17.10+ → 示例代码块中用 `> [!caution]` GitHub-style alert", () => {
		const prompt = buildPrompt({
			skillFilePath,
			dryRun: false,
			gitlabVersion: { major: 17, minor: 10 },
		});
		const example = extractAlertExampleBlock(prompt);
		expect(example).toContain("> [!caution]");
		expect(example).not.toContain("> ⚠️ **Caution**");
	});

	it("GitLab 17.9 → 示例代码块中降级到 `> ⚠️ **Caution**` blockquote", () => {
		const prompt = buildPrompt({
			skillFilePath,
			dryRun: false,
			gitlabVersion: { major: 17, minor: 9 },
		});
		const example = extractAlertExampleBlock(prompt);
		// LLM 看到的示例代码块**不含** [!caution] 字面量,避免学错
		expect(example).not.toContain("> [!caution]");
		expect(example).toContain("> ⚠️ **Caution**");
	});

	it("GitLab 18.0 → 用 alert 块(major>17 短路)", () => {
		const prompt = buildPrompt({
			skillFilePath,
			dryRun: false,
			gitlabVersion: { major: 18, minor: 0 },
		});
		const example = extractAlertExampleBlock(prompt);
		expect(example).toContain("> [!caution]");
	});

	it("gitlabVersion=null(探测失败)→ 降级到 blockquote", () => {
		const prompt = buildPrompt({
			skillFilePath,
			dryRun: false,
			gitlabVersion: null,
		});
		const example = extractAlertExampleBlock(prompt);
		expect(example).toContain("> ⚠️ **Caution**");
		expect(example).not.toContain("> [!caution]");
	});

	it("gitlabVersion 未传 → 默认降级", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		const example = extractAlertExampleBlock(prompt);
		expect(example).toContain("> ⚠️ **Caution**");
	});
});

describe("buildPrompt · walkthrough 一致化(reviewer_list_my_blockers)", () => {
	it("AC4.1 · prompt 含 reviewer_list_my_blockers 字串(对 LLM 提及工具名)", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("reviewer_list_my_blockers");
	});

	it("AC4.2 · prompt 含强约束『必须』+『逐条照抄』+『严禁』", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("必须");
		expect(prompt).toContain("逐条照抄");
		expect(prompt).toContain("严禁");
	});

	it("AC4.3 · prompt 含反例 + stress test 真实案例(N=3 vs 实际 4)", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("反例");
		expect(prompt).toContain("stress test");
		expect(prompt).toContain("漏列");
		// 反例的关键证据:N=3 不一致 + 真实漏掉的文件路径
		expect(prompt).toContain("3 个 blocker");
		expect(prompt).toContain("exportHelper.ts");
	});

	it("步骤 7(校对 blocker 真值)+ 步骤 8(发整体评论)编号正确", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		// 步骤 7 是 reviewer_list_my_blockers 校对(在原步骤 7 之前插入,推后原 step 至 8)
		expect(prompt).toMatch(/7\.\s+\*\*校对本轮 blocker 真值/);
		expect(prompt).toMatch(/8\.\s+全部评审完后/);
	});

	it("示例 7 · 正例 walkthrough alert 块(4 blocker 4 列表逐条照抄)", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("示例 7");
		// 正例 4 条具体 path:line 内容
		expect(prompt).toContain("src/api/auth.ts:12");
		expect(prompt).toContain("src/utils/exportHelper.ts:18");
		expect(prompt).toContain("src/db/seed.ts:45");
		expect(prompt).toContain("src/api/auth.ts:67");
	});
});

describe("buildPrompt · dryRun hint", () => {
	it("dryRun=true 时含 dry-run 提示", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: true });
		expect(prompt).toContain("dry-run 模式");
	});

	it("dryRun=false 时不含 dry-run 提示", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).not.toContain("dry-run 模式");
	});
});

describe("buildPrompt · E2 truncation hint", () => {
	it("truncation 未传 → 无截断说明段(第 8 条约束本身存在,但具体元数据 section 不存在)", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		// 没有 ### MR 文件截断说明 标题段
		expect(prompt).not.toMatch(/### MR 文件截断说明/);
		// 没有 FLOWER_MAX_FILES 这个 env 标识(出现在元数据段里)
		expect(prompt).not.toContain("FLOWER_MAX_FILES");
		// 没有「已按 churn」这段截断元数据(出现在元数据段里)
		expect(prompt).not.toContain("已按 churn");
	});

	it("truncation 传 50/51 → prompt 含截断说明段 + 文件清单", () => {
		const prompt = buildPrompt({
			skillFilePath,
			dryRun: false,
			truncation: {
				shown: 50,
				total: 51,
				files: ["src/big.ts", "src/medium.ts", "README.md"],
			},
		});
		// 有 ### 标题段(独立 section)
		expect(prompt).toMatch(/### MR 文件截断说明/);
		// 数字代入
		expect(prompt).toContain("**51**");
		expect(prompt).toContain("top **50**");
		// 文件路径代入(各文件都列出)
		expect(prompt).toContain("`src/big.ts`");
		expect(prompt).toContain("`src/medium.ts`");
		expect(prompt).toContain("`README.md`");
	});

	it("truncation 传 100/200 → 数字正确替换", () => {
		const prompt = buildPrompt({
			skillFilePath,
			dryRun: false,
			truncation: { shown: 100, total: 200, files: ["a.ts"] },
		});
		expect(prompt).toContain("**200**");
		expect(prompt).toContain("top **100**");
	});

	it("第 8 条硬约束(E2 cap)始终在 prompt(即使未触发截断)", () => {
		// 第 8 条本身是 prompt 的一部分,不依赖 truncation
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("MR diff size cap");
		expect(prompt).toContain("按 churn(增量 + 删除行数)排序");
		expect(prompt).toContain("本次仅评 <shown>/<total>");
	});
});
