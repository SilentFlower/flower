/**
 * 评论 markdown 渲染函数(CodeRabbit-like UX 模板)
 *
 * 为什么独立成 module:
 * - 模板是 N2 评论质量优化的核心产物,与 LLM 调用解耦后便于单测覆盖
 * - 后续 Phase(N1 拉真实代码)生成的 reasoning 也通过这里渲染,集中维护
 * - render 函数是**纯函数**,无 IO、无副作用,可在任意位置调用
 *
 * 设计要点:
 * - severity 词表为 `blocker | major | minor`,沿用 research/comment-style.md §6 模板的中文 PR bot 习惯
 *   (与 flower-tools-gitlab 工具 wrapper 的 `info | warning | blocker` 参数解耦,Phase 1 不动 wrapper)
 * - 行内评论体首行**必须**包含字面量 `[severity:<level>]`,`run.ts:scanForBlockers` 凭此正则识别 blocker
 * - emoji 用 unicode 字符(🟥 / 🟠 / 💡),不用 GLFM shortcode(`:red_square:`) — GitLab 渲染兼容性最高
 * - 整体评论 walkthrough **整 body 包在 `<details>` 里默认折叠**,避免刷屏
 * - 「无问题」轻量模板只发 2 行,避免无意义噪声
 */

/**
 * 评审严重程度(CodeRabbit-style 词表)
 *
 * - `blocker`:阻塞 MR 合并的严重问题(安全 / 合规 / 明显 bug)
 * - `major`:重要但非阻塞的问题(性能 / 逻辑缺陷 / 缺关键日志)
 * - `minor`:轻量建议(命名 / 风格 / 可选优化)
 */
export type Severity = "blocker" | "major" | "minor";

/**
 * 单文件变更摘要(整体评论里展示的「文件变更表」一行)
 */
export interface FileChange {
	/** 仓库内相对路径 */
	path: string;
	/** 新增行数 */
	additions: number;
	/** 删除行数 */
	deletions: number;
	/** 一句话总结(LLM 生成) */
	summary: string;
	/** 关注等级(可选;给视觉锚点) */
	severity?: Severity;
}

/**
 * 整体评论(walkthrough)渲染入参
 */
export interface WalkthroughInput {
	/** MR 标题(展示在折叠卡片标题里,便于复查) */
	mrTitle: string;
	/** 2-3 句的变更总览 */
	summary: string;
	/** 各文件变更摘要 */
	fileChanges: FileChange[];
	/** 必要行动建议(无问题时传空数组) */
	actionItems: string[];
	/** GitLab 服务端版本(决定 alert 块降级路径);传 null 走降级 */
	gitlabVersion: { major: number; minor: number } | null;
	/** 若 diff cap 触发截断,传 `{shown, total}`;不截断传 undefined */
	truncatedFiles?: { shown: number; total: number };
	/** blocker 数量(>0 时在顶部加 caution 卡片) */
	blockerCount?: number;
}

/**
 * 行内评论渲染入参(4 段式)
 */
export interface InlineCommentInput {
	/** 严重程度(决定 emoji + 英文标签) */
	severity: Severity;
	/** 加粗中文标题(一句话,讲 what) */
	title: string;
	/** 解释段(1-3 句,讲 why) */
	explanation: string;
	/** 可选的修复建议;支持 `suggestion` 块(传 diff 形式)或普通 code 块 */
	suggestion?: {
		/** suggestion 块内容(完整替换该行的新文本) */
		code: string;
		/** 语言(仅在 fallback 到普通 code 块时使用,如 `typescript`) */
		language?: string;
		/** 是否使用 GitLab `suggestion` 块(true)还是普通 ```code``` 块(false fallback) */
		useSuggestionBlock?: boolean;
	};
	/** 折叠 reasoning(可选) */
	reasoning?: string;
}

/**
 * 「无问题」轻量评论入参
 */
export interface CleanReviewInput {
	/** MR 标题(可选;仅用于一句话补充上下文) */
	mrTitle?: string;
	/** 可选的一句话补充(值得肯定的实现 / 关注点) */
	note?: string;
}

/**
 * severity 对应的视觉锚点
 *
 * emoji 选用与 research/comment-style.md §6 模板、§7 对照表一致的 unicode 字符
 * (🔴/🟠/🔵),GitHub / GitLab 直接渲染无需 emoji shortcode。
 */
const SEVERITY_META: Record<Severity, { emoji: string; englishLabel: string }> = {
	blocker: { emoji: "🔴", englishLabel: "Blocker" },
	major: { emoji: "🟠", englishLabel: "Major" },
	minor: { emoji: "🔵", englishLabel: "Minor" },
};

/**
 * 判断当前 GitLab 版本是否支持 GitHub-style alert 块(`> [!caution]` 等)
 *
 * 支持版本:GitLab 17.10+(2026-01 前后发布)。
 * 低版本会把 alert 块渲染成裸 `[!caution]` 字面文本,需走降级到普通 blockquote。
 *
 * @param version 形如 `{ major: 17, minor: 10 }`;探测失败传 null
 * @returns true 表示可用 alert 块语法
 */
export function supportsAlertBlock(version: { major: number; minor: number } | null): boolean {
	if (version === null) return false;
	if (version.major > 17) return true;
	if (version.major < 17) return false;
	return version.minor >= 10;
}

/**
 * 渲染 MR 整体评论(walkthrough)
 *
 * 输出结构:
 * - 顶部(若有 blocker)`[!caution]` alert 块 / 降级 blockquote
 * - 包在 `<details>` 默认折叠的主体:概要 / 文件变更表 / 行动建议
 * - 若 diff 截断,文件变更表后追加 ⚠️ 截断提示
 *
 * @param input 见 `WalkthroughInput`
 * @returns 完整 markdown 字符串(直接喂给 `gitlab_post_comment` 的 body 参数)
 */
export function renderWalkthrough(input: WalkthroughInput): string {
	const parts: string[] = [];
	const blockerCount = input.blockerCount ?? 0;

	// 顶部 caution 卡片(仅在有 blocker 时插入,作为整体评论里"必须修复"的视觉锚点)
	if (blockerCount > 0) {
		parts.push(renderCautionBlock(blockerCount, input.gitlabVersion));
		parts.push("");
	}

	// 主体折叠卡片
	parts.push(`<details>`);
	parts.push(`<summary>🤖 <b>代码评审报告</b> (flower-code-reviewer)</summary>`);
	parts.push("");

	// 概要段
	parts.push(`## 概要`);
	parts.push("");
	parts.push(input.summary);
	parts.push("");

	// 文件变更表
	parts.push(`## 文件变更`);
	parts.push("");
	parts.push(`| 文件 | 一句话总结 | 关注等级 |`);
	parts.push(`| --- | --- | --- |`);
	for (const change of input.fileChanges) {
		const sev = change.severity ? `${SEVERITY_META[change.severity].emoji} ${change.severity}` : "—";
		// 路径用反引号包,避免被误判为 quick action(防 `/path/...` 形式整行触发)
		parts.push(`| \`${change.path}\` | ${change.summary} | ${sev} |`);
	}

	// 截断提示(E2 cap mitigation 的预留位;Phase 1 仅渲染,本身不做 cap)
	if (input.truncatedFiles !== undefined) {
		parts.push("");
		parts.push(
			`> ⚠️ 本次仅评 ${input.truncatedFiles.shown}/${input.truncatedFiles.total} 个最大变更文件(按 churn 排序),其余请手工 review。`,
		);
	}

	// 行动建议
	if (input.actionItems.length > 0) {
		parts.push("");
		parts.push(`## 行动建议`);
		parts.push("");
		for (const item of input.actionItems) {
			parts.push(`- [ ] ${item}`);
		}
	}

	parts.push("");
	parts.push(`</details>`);

	return parts.join("\n");
}

/**
 * 渲染 caution 块(整体评论顶部展示 "本 MR 含 N 个 blocker 必须修复")
 *
 * 版本 ≥17.10 → 用 `> [!caution]` GitHub-style alert
 * 版本 <17.10 / null → 降级到普通 `> ⚠️ **Caution**` blockquote(语义不丢)
 *
 * @internal 由 `renderWalkthrough` 调用,不导出
 */
function renderCautionBlock(blockerCount: number, version: { major: number; minor: number } | null): string {
	const message = `本次评审发现 **${blockerCount} 个 blocker 级问题**,CI 将以非零退出码 fail。修复后请重新 push 触发自动重审。`;
	if (supportsAlertBlock(version)) {
		return `> [!caution]\n> ${message}`;
	}
	return `> ⚠️ **Caution**\n> ${message}`;
}

/**
 * 渲染 4 段式行内评论
 *
 * 4 段结构:
 * 1. severity 标签行(斜体 emoji + 英文标签)
 * 2. 加粗中文标题(一句话讲 what)
 * 3. 解释段(1-3 句讲 why)
 * 4. 可选折叠区(修复建议 + 推理过程)
 *
 * 输出**必须**包含字面量 `[severity:<level>]`,`scanForBlockers` 凭此识别 blocker。
 * 前缀放在标题行末尾(不污染斜体标签的视觉),GitLab 渲染时与正文紧贴。
 *
 * @param input 见 `InlineCommentInput`
 * @returns 完整 markdown 字符串(直接喂给 `gitlab_post_line_comment` 的 body 参数)
 */
export function renderInlineComment(input: InlineCommentInput): string {
	const meta = SEVERITY_META[input.severity];
	const parts: string[] = [];

	// 段 1:斜体 severity 标签行(`_<emoji> <english>_`)
	parts.push(`_${meta.emoji} ${meta.englishLabel}_ [severity:${input.severity}]`);
	parts.push("");

	// 段 2:加粗中文标题(末尾不加句号,LLM 自己控制语气)
	parts.push(`**${input.title}**`);
	parts.push("");

	// 段 3:解释段
	parts.push(input.explanation);

	// 段 4a:修复建议折叠
	if (input.suggestion !== undefined) {
		parts.push("");
		parts.push(`<details>`);
		parts.push(`<summary>修复建议</summary>`);
		parts.push("");
		const useSuggestion = input.suggestion.useSuggestionBlock !== false;
		const fence = useSuggestion ? "```suggestion" : `\`\`\`${input.suggestion.language ?? ""}`;
		parts.push(fence);
		parts.push(input.suggestion.code);
		parts.push("```");
		parts.push("");
		parts.push(`</details>`);
	}

	// 段 4b:推理过程折叠
	if (input.reasoning !== undefined) {
		parts.push("");
		parts.push(`<details>`);
		parts.push(`<summary>💡 推理过程</summary>`);
		parts.push("");
		parts.push(input.reasoning);
		parts.push("");
		parts.push(`</details>`);
	}

	return parts.join("\n");
}

/**
 * 渲染「无问题」轻量评论(MR 干净时使用,避免刷屏)
 *
 * 输出 ≤ 3 行,不折叠,不带 severity 前缀(因为没问题就没等级)。
 *
 * @param input 见 `CleanReviewInput`
 * @returns 完整 markdown 字符串
 */
export function renderCleanReview(input: CleanReviewInput): string {
	const lines: string[] = [];
	lines.push(`:white_check_mark: 已审完本 MR,未发现需要修改的问题。`);
	if (input.note !== undefined && input.note.length > 0) {
		lines.push(input.note);
	}
	return lines.join("\n");
}
