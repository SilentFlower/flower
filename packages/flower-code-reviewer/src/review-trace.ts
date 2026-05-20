/**
 * 评审过程的 tool call 追踪
 *
 * 为什么独立成 module:
 * - extension.ts(pi 注册顺序敏感)与 run.ts(评审主流程)需要共享同一份运行期状态
 * - 状态本身是评审业务规则("评论文件必须先读"),不属于通用 compliance
 * - 抽出来便于 scanForBlockers 的"无依据评论"逻辑单测
 *
 * 行为:
 * - `ReviewTrace` 是 module-level 单例,extension 注册的 `tool_call` 监听往 trace 里推
 * - run.ts 在 piMain 返回后读 trace,判断每条 `gitlab_post_line_comment` 评论的 `file`
 *   是否都在 `readFiles`(`gitlab_get_file_content` 拉过)中
 * - 多次评审之间需手动 `resetTrace()`(目前一个进程只跑一次,够用;若改成常驻服务再细化)
 */

/**
 * 行内评论投递记录(仅 LLM 通过 `gitlab_post_line_comment` 发出的)
 *
 * 记录在 tool_call 阶段(发出请求时)— 即使工具 execute 失败,意图仍算"对该 file 发了评论",
 * 应当被"无依据评论"检查覆盖。
 */
export interface PostedLineComment {
	/** LLM 想评论的文件路径(取自 tool input.file) */
	file: string;
	/** LLM 想评论的行号(留作后续推断 source 用,目前 scan 只看 file) */
	line: number;
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
 * @param file 评论目标文件路径
 * @param line 评论目标行号
 */
export function recordLineComment(file: string, line: number): void {
	trace.lineComments.push({ file, line });
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
