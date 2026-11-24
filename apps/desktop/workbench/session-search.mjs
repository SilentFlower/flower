const snippetRadius = 30;
const unfinished = new Set(["interrupted", "queued", "running", "cancelling"]);

/**
 * 从会话记录文件中取出可搜索的轮次：提问取桌面保存的原话，回复取正文，不含工具结果。
 * @param {object | undefined} snapshot 会话记录文件内容
 * @returns {{requestId: string, input: string, text: string, status: string}[]} 轮次
 */
export function searchableTurns(snapshot) {
	const messages = snapshot?.desktopMessages ?? {};
	return (Array.isArray(snapshot?.requests) ? snapshot.requests : []).map((record) => ({
		requestId: record.requestId,
		input:
			typeof messages[record.requestId]?.input === "string" ? messages[record.requestId].input : (record.input ?? ""),
		text: typeof record.text === "string" ? record.text : "",
		status: record.status,
	}));
}

/**
 * 在一个会话的轮次中查找关键词，返回命中片段：命中前后各约 30 字，空白折叠为单个空格。
 * @param {ReturnType<typeof searchableTurns>} turns 会话轮次
 * @param {string} query 关键词，调用方已去除首尾空白
 * @param {number} [limit] 片段上限
 * @returns {{requestId: string, field: "input" | "text", before: string, match: string, after: string}[]} 片段
 */
export function searchSnippets(turns, query, limit = 3) {
	const needle = query.toLocaleLowerCase();
	const snippets = [];
	const tidy = (value) => value.replace(/\s+/g, " ");
	for (const turn of turns) {
		for (const field of ["input", "text"]) {
			const value = turn[field];
			const lower = value.toLocaleLowerCase();
			// 小写化改变长度的罕见字符无法回映原文位置，跳过该字段。
			if (lower.length !== value.length) continue;
			const index = lower.indexOf(needle);
			if (index < 0) continue;
			const start = Math.max(0, index - snippetRadius);
			const end = index + needle.length;
			snippets.push({
				requestId: turn.requestId,
				field,
				before: `${start > 0 ? "…" : ""}${tidy(value.slice(start, index)).trimStart()}`,
				match: value.slice(index, end),
				after: `${tidy(value.slice(end, end + snippetRadius)).trimEnd()}${end + snippetRadius < value.length ? "…" : ""}`,
			});
			if (snippets.length >= limit) return snippets;
		}
	}
	return snippets;
}

/**
 * 判断会话上次是否被中断：最后一条请求为中断，或记录文件中仍停在排队、运行中（尚未经运行时修正）。
 * @param {ReturnType<typeof searchableTurns>} turns 会话轮次
 * @returns {boolean} 是否中断
 */
export function interruptedTurns(turns) {
	return unfinished.has(turns.at(-1)?.status);
}
