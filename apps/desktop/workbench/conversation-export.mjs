import { Marked } from "marked";

const maximum = 2_000_000;
const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => entities[character]);
const markdown = new Marked({
	gfm: true,
	renderer: {
		html({ raw, block }) {
			return block ? `<p>${escapeHtml(raw)}</p>` : escapeHtml(raw);
		},
		image({ raw }) {
			return escapeHtml(raw);
		},
		link({ href, tokens }) {
			const label = this.parser.parseInline(tokens);
			const url = typeof href === "string" && /^https?:\/\//i.test(href) ? URL.parse(href) : undefined;
			if (!url?.hostname || url.username || url.password || /[\p{Cc}\\]/u.test(href)) return label;
			return `<a href="${escapeHtml(url.href)}" rel="noopener noreferrer">${label}</a>`;
		},
	},
});

function attachments(snapshot, record) {
	const name = snapshot.desktopMessages?.[record.requestId]?.file;
	return record.attachments?.map(({ name }) => name) ?? (name ? [name] : []);
}

/** 从本机已完成记录生成有序的导出轮次，按用户所选的请求 ID 取交集并校验归属。
 * @param snapshot 主进程读取的会话快照
 * @param ids 可选的请求 ID 数组
 * @returns 规范化的会话轮次
 */
export function exportTurns(snapshot, ids) {
	const records = (snapshot?.requests ?? []).filter(
		({ status, input, text }) => !["queued", "running", "cancelling"].includes(status) && (input || text),
	);
	const wanted = ids === undefined ? undefined : new Set(ids);
	const chosen = wanted ? records.filter(({ requestId }) => wanted.has(requestId)) : records;
	if (!chosen.length || (wanted && chosen.length !== wanted.size)) throw new Error("请选择本会话已结束的消息。");
	let size = 0;
	return chosen.map((record) => {
		const input = snapshot.desktopMessages?.[record.requestId]?.input ?? record.input ?? "";
		const text = record.text ?? "";
		const steers = (record.steers ?? []).map(({ input, attachments, textOffset }) => ({
			input,
			textOffset,
			names: (attachments ?? []).map(({ name }) => name),
		}));
		const names = attachments(snapshot, record);
		size +=
			input.length +
			text.length +
			names.join("").length +
			steers.reduce((sum, row) => sum + row.input.length + row.names.join("").length, 0);
		if (size > maximum) throw new Error("所选会话记录过长。请选择较少的消息。");
		return { requestId: record.requestId, input, text, names, steers };
	});
}

function ordered(turn) {
	const out = turn.input ? [{ kind: "user", index: 0, role: "你", text: turn.input, names: turn.names }] : [];
	let start = 0;
	for (const [index, { input, names, textOffset }] of turn.steers.entries()) {
		const cut = Math.min(
			turn.text.length,
			Math.max(start, Number.isSafeInteger(textOffset) ? textOffset : turn.text.length),
		);
		if (cut > start) out.push({ kind: "reply", index, role: "Flower", text: turn.text.slice(start, cut), names: [] });
		if (input) out.push({ kind: "steer", index, role: "插话", text: input, names });
		start = cut;
	}
	if (start < turn.text.length)
		out.push({ kind: "reply", index: turn.steers.length, role: "Flower", text: turn.text.slice(start), names: [] });
	return out.map((segment) => ({ requestId: turn.requestId, ...segment }));
}

/** 将会话拆成有序的提问、插话与回复，可用于复制图片。
 * @param turns 已校验的会话轮次
 * @returns 有角色、原文和附件名的片段
 */
export function exportSegments(turns) {
	return turns.flatMap(ordered);
}

const segmentKey = ({ requestId, kind, index }) => JSON.stringify([requestId, kind, index]);

/** 精确校验图片所选的可见消息，并按原会话顺序读出文本与附件显示名。
 * @param snapshot 当前会话快照
 * @param selection 已检查结构的消息标识
 * @returns 仅包含所选消息的分享数据
 */
export function exportSelectedSegments(snapshot, selection) {
	const requested = new Set(selection.map(segmentKey));
	if (requested.size !== selection.length) throw new Error("消息选择重复，请重新选择。");
	const turns = exportTurns(
		snapshot,
		selection.map(({ requestId }) => requestId),
	);
	const segments = exportSegments(turns).filter((segment) => requested.has(segmentKey(segment)));
	if (segments.length !== requested.size) throw new Error("部分所选消息已变化，请重新选择。");
	return segments.map(({ role, text, names }) => ({ role, text, names }));
}

/** 生成可粘贴的 Markdown 会话。
 * @param title 会话名称
 * @param turns 已校验的会话轮次
 * @returns 保留消息原文的 Markdown
 */
export function conversationMarkdown(title, turns) {
	const paragraphs = exportSegments(turns).map(({ role, text, names }) =>
		[`## ${role}`, text, ...(names.length ? [`附件：${names.join("、")}`] : [])].join("\n\n"),
	);
	return [`# ${title.replace(/[\r\n]/g, " ")}`, ...paragraphs].join("\n\n");
}

/** 生成离线、安全的 HTML 会话文档。
 * @param title 会话名称
 * @param turns 已校验的会话轮次
 * @returns 可保存为 UTF-8 的 HTML
 */
export function conversationHtml(title, turns) {
	const sections = exportSegments(turns).map(({ role, text, names }) => {
		const body = role === "Flower" ? markdown.parse(text) : `<p class="question">${escapeHtml(text)}</p>`;
		return `<article class="${role === "Flower" ? "reply" : "user"}"><h2>${role}</h2>${body}${names.length ? `<p class="files">附件：${names.map(escapeHtml).join("、")}</p>` : ""}</article>`;
	});
	return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--background:#f2f2ed;--surface:#fdfdf8;--line:#deded6;--text:#22221f;--muted:#676760;--accent:#2459d6}
@media(prefers-color-scheme:dark){:root{--background:#171917;--surface:#232623;--line:#3a3d39;--text:#f1f2ee;--muted:#b9bcb5;--accent:#aabfff}}
body{margin:0;padding:clamp(16px,5vw,54px);background:var(--background);color:var(--text);font:16px/1.65 system-ui,"Microsoft YaHei UI",sans-serif}
main{max-width:800px;margin:auto;overflow-wrap:anywhere}header{margin-bottom:28px}small,.files{color:var(--muted)}h1,h2{line-height:1.25}
article{padding:14px 20px;margin:0 0 16px;border-radius:14px}article.user{background:var(--surface);border:1px solid var(--line)}
article>h2{font-size:15px;margin:0 0 8px;color:var(--muted)}p{margin:.6em 0}.question{white-space:pre-wrap}
a{color:var(--accent)}pre{background:var(--surface);padding:12px;overflow:auto;border-radius:8px}table{display:block;overflow:auto;border-collapse:collapse}
th,td{border:1px solid var(--line);padding:5px 9px}blockquote{padding-left:12px;margin-left:0;border-left:2px solid var(--line)}
</style><main><header><small>Flower Desktop</small><h1>${escapeHtml(title)}</h1></header>${sections.join("\n")}</main></html>`;
}
