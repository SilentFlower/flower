const attachmentPattern = /^attachment:[a-f\d]{64}$/;

/**
 * 长路径保留末尾的目录与文件名，超出时以省略号开头。
 * @param {string} path 工作区相对路径
 * @param {number} limit 最多保留的字符数
 * @returns {string} 适合展示的路径
 */
export function shortPath(path, limit = 120) {
	const characters = Array.from(path);
	if (characters.length <= limit) return path;
	// 文件名比上级目录更能说明对象，截断时从左侧舍弃。
	return `…${characters.slice(characters.length - limit + 1).join("")}`;
}

/**
 * 为工作区工具调用生成展示目标。只读取路径类参数，不保留报告正文等大参数。
 * @param {string} toolName 工具名
 * @param {unknown} args 模型给出的工具参数
 * @param {(id: string) => string | undefined} attachmentName 按 asset: 编号查附件名
 * @returns {string | undefined} 工作区相对路径、附件名，或无目标
 */
export function describeToolCall(toolName, args, attachmentName) {
	if (!args || typeof args !== "object") return undefined;
	const field = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
	const display = (path) => {
		if (!path) return undefined;
		if (attachmentPattern.test(path)) return attachmentName(path.replace("attachment:", "asset:")) ?? "对话附件";
		return shortPath(path.replaceAll("\\", "/"));
	};
	if (toolName === "list_workspace") {
		const directory = field(args.directory);
		return !directory || directory === "." ? "工作区" : display(directory);
	}
	if (toolName === "write_report") return display(field(args.input));
	const target = display(field(args.path));
	const sheet = toolName === "analyze_excel" ? field(args.sheet) : undefined;
	return target && sheet ? `${target} · ${sheet}` : target;
}
