/**
 * `prompts.ts` 单元测试:GitLab 版本动态切换 alert 块 + 行窗上下文约束都在 prompt 里
 *
 * 覆盖 implement.md §Phase 2 关键改动:
 * - 第 7 条约束(评论前必读 gitlab_get_file_content 行窗)写进 prompt
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
	it("第 7 条:评论前必须读取相关行窗", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("gitlab_get_file_content");
		expect(prompt).toContain("评论前");
		expect(prompt).toContain("相关行窗");
		expect(prompt).toContain("无依据评论");
		expect(prompt).toContain("scanForBlockers");
		expect(prompt).not.toContain("拉完整内容");
	});

	it("severity 词表用 blocker / major / minor(不是 info / warning)", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		// 风格 / 命名 / 建议性问题打 major 或 minor(已对齐 Phase 2 词表)
		expect(prompt).toContain("\\`major\\` 或 \\`minor\\`".replace(/\\/g, ""));
		expect(prompt).not.toContain("`info`");
		expect(prompt).not.toContain("`warning`");
	});

	it("工作流程含按行窗读取上下文步骤(`gitlab_get_file_content` 在编号步骤里)", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("基于 diff 初筛风险点");
		expect(prompt).toContain("不要为了覆盖率把所有变更文件无脑读取一遍");
		expect(prompt).toMatch(/5\.\s+.*相关行窗/);
		expect(prompt).toContain("startLine");
		expect(prompt).toContain("endLine");
		expect(prompt).toContain("续读提示");
	});

	it("评论 markdown 样式段落含原有约束 + 测试说明 + 真实上下文约束", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("4 段式");
		expect(prompt).toContain("walkthrough");
		expect(prompt).toContain("无问题代码评审评论");
		expect(prompt).toContain("面向测试的变更说明");
		expect(prompt).toContain("quick action 禁令");
		expect(prompt).toContain("GLFM 兼容");
		expect(prompt).toContain("🔴 **阻塞**");
		expect(prompt).toContain("真实代码上下文约束");
	});

	// AC1.6 · Fix A 教育:LLM 必须显式传 ref(从 prompt 注入的 source branch),严禁 HEAD/省略
	it("AC1.6 · 工作流第 5 步要求 LLM 显式传 ref = source branch,严禁 HEAD/空/省略", () => {
		const prompt = buildPrompt({
			skillFilePath,
			dryRun: false,
			sourceBranch: "try/code-review-onboarding",
		});
		// 注入的 source branch name 出现在 prompt(LLM 能直接照抄)
		expect(prompt).toContain("try/code-review-onboarding");
		// 「必须传」强约束措辞
		expect(prompt).toMatch(/必须传/);
		// 严禁 HEAD / 省略
		expect(prompt).toMatch(/严禁.*HEAD|不要传.*HEAD/);
	});

	it("AC1.6b · 不传 sourceBranch 时 prompt 有降级 placeholder(本地调试场景)", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		// 没有 sourceBranch 时用 placeholder,LLM 看到提示去查 env
		expect(prompt).toMatch(/MR source branch.*env CI_MERGE_REQUEST_SOURCE_BRANCH_NAME/);
	});

	it("上下文读取预算默认 500 行 / 最大 1000 行 / 每轮 5 个行窗", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("默认 500 行");
		expect(prompt).toContain("最多返回 1000 行");
		expect(prompt).toContain("每一轮最多读取 **5** 个行窗");
	});

	it("上下文读取预算可由 buildPrompt 入参注入", () => {
		const prompt = buildPrompt({
			skillFilePath,
			dryRun: false,
			contextReadBatchSize: 3,
			contextReadDefaultLines: 200,
			contextReadMaxLines: 800,
		});
		expect(prompt).toContain("默认 200 行");
		expect(prompt).toContain("最多返回 800 行");
		expect(prompt).toContain("每一轮最多读取 **3** 个行窗");
	});

	// AC2.5 · Fix B 教育:「工具优先级」段落已经写进 prompt
	it("AC2.5 · prompt 含「工具优先级」段,告知 bash 白名单边界", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("## 工具优先级");
		// 鼓励 rg(modern unix 推荐)
		expect(prompt).toContain("rg");
		expect(prompt).toContain(".gitignore");
		// 显式禁用 env / curl
		expect(prompt).toContain("env");
		expect(prompt).toContain("可能泄漏 secret");
		expect(prompt).toContain("禁用");
		expect(prompt).toContain("curl");
		expect(prompt).toContain("网络外发");
	});

	it("跨项目上下文引导:包含 3 个工具名、本地 rg、旧 doc 降权和开放式按需 harness 规则", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("跨项目上下文");
		expect(prompt).toContain("gitlab_list_group_projects");
		expect(prompt).toContain("gitlab_list_project_branches");
		expect(prompt).toContain("gitlab_prepare_project_workspace");
		expect(prompt).toContain("业务 / 需求事实优先查配置的 harness 仓库");
		expect(prompt).toContain("当前 MR 项目的 `doc/`、`*.md`、`*.csv` 默认只作历史线索");
		expect(prompt).toContain("bash + `rg`");
		expect(prompt).toContain("gitlab_search_project_blobs");
		expect(prompt).toContain("**不使用** `gitlab_search_project_blobs`");
		expect(prompt).toContain("不要求每个 MR 固定准备 harness 工作区");
		expect(prompt).toContain("不是封闭白名单");
		expect(prompt).toContain("字段含义、权限规则、导入导出模板、业务状态机、跨端约定、版本需求等只是典型例子");
		expect(prompt).toContain("未找到权威需求依据");
	});
});

describe("buildPrompt · 面向测试的变更说明评论", () => {
	function extractTestChangeExampleBlock(prompt: string): string {
		const match = prompt.match(/### 示例 8[\s\S]*?```markdown([\s\S]*?)```/);
		return match?.[1] ?? "";
	}

	it("AC1/AC8 · 工作流程要求 walkthrough 后再发第二条测试说明整体评论", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toMatch(/8\.\s+全部评审完后.*第一条整体评论:代码评审 walkthrough/);
		expect(prompt).toMatch(/9\.\s+\*\*必须再\*\*调用一次 `gitlab_post_comment`/);
		expect(prompt).toContain("发送第二条整体评论:`面向测试的变更说明`");
		expect(prompt).toContain("不得**塞进代码评审 walkthrough");
	});

	it("AC8b · 第二条测试说明整体评论默认折叠", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		const example = extractTestChangeExampleBlock(prompt);
		expect(prompt).toContain("这条评论的整个 body 也**必须**包在 `<details>` 里默认折叠");
		expect(prompt).toContain("不要加 `open` 属性");
		expect(prompt).toContain("<summary>:test_tube: <b>面向测试的变更说明</b></summary>");
		expect(example).toMatch(/^\s*<details>/);
		expect(example).toContain("<summary>:test_tube: <b>面向测试的变更说明</b></summary>");
		expect(example).toContain("</details>");
		expect(example).not.toContain("<details open");
	});

	it("AC9 · 测试说明模板固定包含 4 项 MVP 字段", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		const example = extractTestChangeExampleBlock(prompt);
		expect(example).toContain("## 面向测试的变更说明");
		expect(example).toContain("### 变更摘要");
		expect(example).toContain("### 影响范围");
		expect(example).toContain("### 测试关注点");
		expect(example).toContain("### 需求/依据");
	});

	it("AC14 · 测试说明要求用测试人员可读的业务/行为语言,不能只写实现细节", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("测试人员易懂");
		expect(prompt).toContain("业务 / 用户行为 / 接口表现 / 数据变化语言");
		expect(prompt).toContain("文件名、函数名、实现细节只能作为依据补充,不能作为主体");
		expect(prompt).toContain("不要只输出文件名、函数名、内部实现或技术摘要");
	});

	it("AC2/AC11 · 测试关注点覆盖低风险变更,允许无需专项测试或基础回归", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("低风险变更");
		expect(prompt).toContain("也要输出完整四项");
		expect(prompt).toContain("无需专项测试");
		expect(prompt).toContain("建议基础回归");
	});

	it("AC3/AC4 · 需求依据要求标注 harness 路径和 ref/commit,未找到时明确降级", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		const example = extractTestChangeExampleBlock(prompt);
		expect(prompt).toContain("harness 文档路径 + ref / commit");
		expect(prompt).toContain("如果依据来自 harness,测试说明的`需求/依据`中简短说明依据文件路径和 ref / commit");
		expect(example).toContain("devops-infra/docs/auth-signature.md");
		expect(example).toContain("ref: `release/2026-06`");
		expect(example).toContain("commit: `abc1234`");
		expect(prompt).toContain("未找到权威需求依据");
		expect(prompt).toContain("不作为权威业务结论");
	});

	it("AC10 · 无问题场景不能只发一条轻量结论,仍要发送第二条测试说明", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).not.toContain("只发一条整体评论");
		expect(prompt).not.toContain("正文 ≤ 3 行");
		expect(prompt).toContain("第一条整体评论可保持简洁,但不能作为唯一评论");
		expect(prompt).toContain("随后仍必须发送第二条测试说明");
	});

	it("AC12 · harness 是按需开放式业务依据判断,不是固定 prepare 或封闭关键词列表", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("不要求每个 MR 固定准备 harness 工作区");
		expect(prompt).toContain("只有当 diff 暗示需要外部业务 / 需求事实支撑时");
		expect(prompt).toContain("不是封闭白名单");
		expect(prompt).toContain("只要 diff 体现出需要权威业务依据");
	});

	it("AC13 · 测试说明不设硬性句数上限,改用信息聚焦规则控制噪声", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("不硬性限制句数或条目数");
		expect(prompt).toContain("信息密度和测试可执行性");
		expect(prompt).toContain("避免重复代码评审 walkthrough");
		expect(prompt).toContain("复述完整 diff");
		expect(prompt).not.toContain("1-3 句");
		expect(prompt).not.toContain("2-3 句");
	});
});

describe("buildPrompt · 文件变更表关注等级", () => {
	function extractWalkthroughExampleBlock(prompt: string): string {
		const match = prompt.match(/### 示例 1[\s\S]*?```markdown([\s\S]*?)```/);
		return match?.[1] ?? "";
	}

	it("AC15 · 关注等级列只能使用稳定中文枚举", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("关注等级`列只能使用这四个稳定中文枚举");
		expect(prompt).toContain("`🔴 阻塞` / `🟠 重要` / `🔵 建议` / `⚪ 仅说明`");
		expect(prompt).toContain("禁止**使用 GitLab shortcode");
		expect(prompt).toContain("或英文等级");
	});

	it("AC16 · 文件变更表示例不再包含 GitLab shortcode 或英文等级", () => {
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		const example = extractWalkthroughExampleBlock(prompt);
		expect(example).toContain("| `internal/auth/sign_verify.go` | 新增签名验证主流程 | 🔴 阻塞 |");
		expect(example).toContain("| `internal/auth/sign_verify_test.go` | 单测覆盖 happy path | 🔵 建议 |");
		expect(example).toContain("| `cmd/server/main.go` | 注册 sign verify middleware | 🔵 建议 |");
		expect(example).not.toContain(":large_orange_circle:");
		expect(example).not.toContain(":white_circle:");
		expect(example).not.toMatch(/\|\s*:[a-z_]+:\s*(?:major|minor|blocker)\s*\|/);
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
	it("truncation 未传 → 无截断说明段(第 9 条约束本身存在,但具体元数据 section 不存在)", () => {
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

	it("第 9 条硬约束(E2 cap)始终在 prompt(即使未触发截断)", () => {
		// 第 9 条本身是 prompt 的一部分,不依赖 truncation
		const prompt = buildPrompt({ skillFilePath, dryRun: false });
		expect(prompt).toContain("MR diff size cap");
		expect(prompt).toContain("按 churn(增量 + 删除行数)排序");
		expect(prompt).toContain("本次仅评 <shown>/<total>");
	});
});
