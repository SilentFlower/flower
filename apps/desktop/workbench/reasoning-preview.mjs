const sentences = new Intl.Segmenter("zh", { granularity: "sentence" });
const complete = /[。！？!?.…；;]\s*$/u;

/**
 * 取推理文本中最近一句完整的话，没有完整句时取正在生成的片段。
 * @param {string} text 最近的推理文本
 * @param {number} limit 最多保留的字符数
 * @returns {string} 适合单行展示的一句话
 */
export function latestSentence(text, limit = 120) {
	const parts = [...sentences.segment(text)].map(({ segment }) => segment.trim()).filter(Boolean);
	if (!parts.length) return "";
	// 最后一段常在生成中途，优先展示上一句完整的话，避免预览逐字跳动。
	const last = parts.at(-1);
	const chosen = complete.test(last) || parts.length === 1 ? last : parts.at(-2);
	const characters = Array.from(chosen.replace(/\s+/g, " "));
	return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("");
}

/**
 * 按会话累积推理分片，节流后输出最新一句。只在内存中保存末尾 2 KiB。
 * @param {(session: string, sentence: string) => void} publish 输出最新一句
 * @param {number} interval 两次输出的最短间隔，毫秒
 * @returns {{push(session: string, delta: string): void, clear(session: string): void}} 累积与清理接口
 */
export function createReasoningPreview(publish, interval = 1000) {
	const entries = new Map();
	function flush(session) {
		const entry = entries.get(session);
		if (!entry) return;
		entry.timer = undefined;
		entry.sentAt = Date.now();
		const sentence = latestSentence(entry.text);
		if (sentence && sentence !== entry.sent) {
			entry.sent = sentence;
			publish(session, sentence);
		}
	}
	return {
		push(session, delta) {
			if (!delta) return;
			let entry = entries.get(session);
			if (!entry) {
				// 首句立即输出，之后再按间隔节流。
				entry = { text: "", sent: "", sentAt: Number.NEGATIVE_INFINITY, timer: undefined };
				entries.set(session, entry);
			}
			entry.text = (entry.text + delta).slice(-2048);
			if (entry.timer) return;
			const wait = entry.sentAt + interval - Date.now();
			if (wait <= 0) flush(session);
			else entry.timer = setTimeout(() => flush(session), wait);
		},
		clear(session) {
			const entry = entries.get(session);
			if (entry?.timer) clearTimeout(entry.timer);
			entries.delete(session);
		},
	};
}
