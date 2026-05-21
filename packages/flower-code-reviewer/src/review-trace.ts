/**
 * 评审过程的 tool call 追踪
 *
 * 为什么独立成 module:
 * - extension.ts(pi 注册顺序敏感)与 run.ts(评审主流程)需要共享同一份运行期状态
 * - 状态本身是评审业务规则("评论文件必须先读" + "本轮自审 blocker 列表"),不属于通用 compliance
 * - 抽出来便于 scanForBlockers 的"无依据评论"逻辑单测,以及 reviewer_list_my_blockers 工具的真值读取
 *
 * 行为:
 * - `ReviewTrace` 是 module-level 单例,extension 注册的 `tool_call` 监听往 trace 里推
 * - run.ts 在 piMain 返回后读 trace,判断每条 `gitlab_post_line_comment` 评论的 `file`
 *   是否都在 `readFiles`(`gitlab_get_file_content` 拉过)中
 * - `reviewer_list_my_blockers` 工具 execute 直接读 `trace.lineComments` 过滤 blocker 返回真值
 * - 多次评审之间需手动 `resetTrace()`(目前一个进程只跑一次,够用;若改成常驻服务再细化)
 */

import type { Severity } from "@flower-ai/flower-tools-gitlab";

/**
 * 行内评论投递记录(仅 LLM 通过 `gitlab_post_line_comment` 发出的)
 *
 * 记录在 tool_call 阶段(发出请求时)— 即使工具 execute 失败,意图仍算"对该 file 发了评论",
 * 应当被"无依据评论"检查覆盖。
 *
 * 字段扩展(2026-05-21 · walkthrough 一致化 v2):加 `severity` + `title`,供
 * `reviewer_list_my_blockers` 工具读取本轮 blocker 真值;`title` 在 record 时一次性抽好存进 trace,
 * 工具 execute 直接读,避免每次工具调用重复抽取。
 */
export interface PostedLineComment {
	/** LLM 想评论的文件路径(取自 tool input.file) */
	file: string;
	/** LLM 想评论的行号(取自 tool input.line) */
	line: number;
	/** 评论严重程度(取自 tool input.severity);用于 reviewer_list_my_blockers 过滤 blocker */
	severity: Severity;
	/** 一句话标题(从 tool input.body 第一行去 emoji + 加粗等级前缀);用于 walkthrough alert 块列表 */
	title: string;
}

/**
 * 评审 trace 状态(纯数据,可序列化)
 */
export interface ReviewTrace {
	/** LLM 通过 `gitlab_get_file_content` 拉过的文件 path 集合(去重) */
	readFiles: Set<string>;
	/** LLM 通过 `gitlab_post_line_comment` 发的行内评论列表 */
	lineComments: PostedLineComment[];
}

let trace: ReviewTrace = {
	readFiles: new Set(),
	lineComments: [],
};

/**
 * 重置 trace(同一进程内再次评审时调用)
 */
export function resetTrace(): void {
	trace = {
		readFiles: new Set(),
		lineComments: [],
	};
}

/**
 * 获取当前 trace 快照(返回引用,call site 可读 Set / Array)
 */
export function getTrace(): ReviewTrace {
	return trace;
}

/**
 * 记录一次 `gitlab_get_file_content` 调用(LLM 想读 `path`)
 *
 * 注:即使工具 execute 失败,这次"读意图"也算数;失败本身由 tool result 透传给 LLM,
 * 但是否"为评论该文件提供了依据"?保守做法 — 失败不算依据,
 * 所以 trace 只记录 tool_call(意图),scan 时也得识别失败 read 不算依据。
 *
 * 当前实现:成功 / 失败都记到 trace —— Phase 2 已经在 `safe-read.ts` 里把网络错误透传;
 * 后续若发现"LLM 失败后绕弯说 '我读不到所以猜'"问题,再细化 trace 用 tool_result 区分。
 *
 * @param path 仓库内相对路径(取自 tool input.path)
 */
export function recordFileRead(path: string): void {
	trace.readFiles.add(path);
}

/**
 * 记录一次 `gitlab_post_line_comment` 调用(LLM 想评论 `file:line`)
 *
 * 对象签名(2026-05-21 升级):一并记录 `severity` 和从 `body` 抽出来的 `title`,
 * 供 `reviewer_list_my_blockers` 工具读取本轮 blocker 真值。
 *
 * @param input 行内评论记录:`{file, line, severity, body}`,内部抽取 title 存入 trace
 */
export function recordLineComment(input: { file: string; line: number; severity: Severity; body: string }): void {
	trace.lineComments.push({
		file: input.file,
		line: input.line,
		severity: input.severity,
		title: extractBlockerTitle(input.body),
	});
}

/**
 * 从行内评论 body 抽取一句话标题
 *
 * 兼容 spec `flower-code-reviewer/frontend/index.md` §1 的中文等级格式:
 * - `🔴 **阻塞** · 硬编码 secret` → `"硬编码 secret"`
 * - `🟠 **重要** 性能问题` → `"性能问题"`(等级与标题间无 `·`,容忍空格)
 * - `🔵 **建议** · 命名优化\n详细...` → `"命名优化"`
 * - HTML 注释 marker(`<!-- severity: blocker -->\n`)由 `flower-tools-gitlab` 在 post 时
 *   自动注入到 body 首行,这里需先剥离
 * - 提取失败 fallback `"(无标题)"`,保证 walkthrough alert 块仍能渲染
 *
 * @param body 行内评论 markdown body(取自 tool input.body,**包含**等级首行)
 * @returns 标题字符串(已 trim,空时为 `"(无标题)"`)
 */
export function extractBlockerTitle(body: string): string {
	// 1. 剥离 HTML 注释 marker(`<!-- severity: blocker -->\n`)
	const stripped = body.replace(/^<!--\s*severity:\s*\S+\s*-->\s*\n?/u, "");
	// 2. 取第一行
	const firstLine = stripped.split("\n", 1)[0] ?? "";
	// 3. 去 emoji + 加粗等级前缀(兼容 `·` / `•` / 空格分隔)
	//    `u` flag 必须:🔴 / 🟠 / 🔵 是 U+1F534 等 surrogate pair codepoint,
	//    无 `u` flag 时字符类只匹配单个 codeunit,会漏匹配
	const title = firstLine.replace(/^[🔴🟠🔵]\s*\*\*\S+\*\*\s*[·•]?\s*/u, "").trim();
	return title || "(无标题)";
}

/**
 * 找出"无依据评论":LLM 评论了某文件但没读过该文件
 *
 * 纯函数,便于单测覆盖。
 *
 * @param readFiles 已读文件集合
 * @param lineComments 已发行内评论列表
 * @returns 无依据评论涉及的文件路径(去重 + 排序便于稳定输出)
 */
export function findUnsupportedComments(readFiles: Set<string>, lineComments: PostedLineComment[]): string[] {
	const unsupported = new Set<string>();
	for (const comment of lineComments) {
		if (!readFiles.has(comment.file)) {
			unsupported.add(comment.file);
		}
	}
	return [...unsupported].sort();
}
