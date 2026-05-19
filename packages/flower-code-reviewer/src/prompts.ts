/**
 * 评审 prompt 构造
 *
 * 关键约束(必须写进 prompt 里,LLM 才会照做):
 * 1. 所有评审意见必须通过 gitlab_post_comment / gitlab_post_line_comment 发表
 * 2. 不要在 stdout 输出"评审报告"
 * 3. 优先用 gitlab_get_previous_review 看历史,避免重复评论
 * 4. severity 三档:info / warning / blocker(只对真问题打 blocker)
 */

import { readFileSync } from "node:fs";

/**
 * 构造 prompt 的输入
 */
export interface BuildPromptInput {
	/** skill 文件的绝对路径 */
	skillFilePath: string;
	/** 试跑模式 */
	dryRun: boolean;
}

/**
 * 构造完整的评审 prompt
 */
export function buildPrompt(input: BuildPromptInput): string {
	const skillContent = readSkill(input.skillFilePath);

	const dryRunHint = input.dryRun
		? "\n\n**注意:当前是 dry-run 模式,请仍然输出你打算发的评论(转 stdout),但不要调用 gitlab_post_* 工具。**"
		: "";

	return `你是资深代码评审 agent。请对当前 GitLab MR 做评审。

## 评审清单

${skillContent}

## 工作流程

1. 先调用 \`gitlab_get_previous_review\` 看自己之前在本 MR 发过哪些评论,**不要重复**。
2. 调用 \`gitlab_get_mr_files\` 看修改了哪些文件。
3. 调用 \`gitlab_get_mr_diff\` 看完整 diff。
4. 必要时用 \`read\` / \`grep\` 工具看上下文(只读)。
5. 对每个有问题的地方,调用 \`gitlab_post_line_comment\` 发行内评论。
6. 全部评审完后,如有总结性意见,调用 \`gitlab_post_comment\` 发整体评论。

## 严格要求

- **所有意见必须通过工具发表,不要在文本输出里给意见**。CI 日志没人看。
- severity 仅在以下情况打 \`blocker\`:
  - 安全漏洞(SQL 注入、XSS、敏感信息泄漏等)
  - 明显的逻辑错误会导致生产事故
  - 不符合团队/项目的硬性合规要求
- 风格 / 命名 / 建议性问题打 \`info\` 或 \`warning\`。
- 评论要给出**具体修改建议**,不要只说"这里不好"。
- 不确定的地方,宁可不发,不要发错的。${dryRunHint}

现在开始评审。`;
}

/**
 * 读取 skill 文件内容
 */
function readSkill(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch (err) {
		console.warn(`[code-reviewer] 无法读取 skill: ${path}, 使用空清单`);
		return "(未提供专项清单,按通用编码规范评审)";
	}
}
