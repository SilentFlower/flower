import { fileReference } from "./attachment-drafts.mjs";

/** 从确切的请求中取出附件，兼容单文件旧记录。
 * @param snapshot 核心及桌面层共同持久化的会话
 * @param requestId 所选历史消息
 * @param key 附件引用标识
 * @returns 绑定该消息的引用及记录
 */
export function historyReference(snapshot, requestId, key) {
	const record = snapshot?.requests.find((entry) => entry.requestId === requestId);
	const legacy = snapshot?.desktopMessages?.[requestId]?.file;
	// 插话的附件同样归属这条消息。
	const refs = [
		...(record?.attachments ?? (typeof legacy === "string" ? [fileReference(legacy)] : [])),
		...(record?.steers ?? []).flatMap((steer) => steer.attachments ?? []),
	];
	const ref = refs.find((entry) => entry.id === key);
	if (!record || !ref) throw new Error("附件不属于这条消息。");
	return { record, ref };
}

function matchesInput(message, record) {
	return (
		message?.role === "user" &&
		(typeof message.content === "string" ? message.content : message.content?.[0]?.text) === record.input
	);
}

function messageForRequest(snapshot, record) {
	const completed = snapshot.requests.filter((row) => row.status === "succeeded");
	const position = completed.indexOf(record);
	if (position < 0) return;
	if (record.userMessageIndex !== undefined) {
		const index = record.userMessageIndex;
		if (!Number.isSafeInteger(index) || index < 0) return;
		const message = snapshot.messages[index];
		if (message?.flowerRequestId === record.requestId && matchesInput(message, record)) return message;
		return;
	}

	const messages = snapshot.messages.filter((message) => message.role === "user");
	if (completed.length === messages.length) {
		const aligned = messages.every(
			(message, index) => message.flowerRequestId === undefined || message.flowerRequestId === completed[index].requestId,
		);
		return aligned ? messages[position] : undefined;
	}

	// 早期候选把未完成任务的回执写成了普通 user。原生成功轮次的用户消息紧接助手响应。
	const anchored = snapshot.messages.filter(
		(message, index) => message.role === "user" && snapshot.messages[index + 1]?.role === "assistant",
	);
	const tagged = new Set(
		snapshot.messages.filter((message) => message.role === "flowerToolReceipt").map(({ requestId }) => requestId),
	);
	if (anchored.length !== completed.length || messages.length <= anchored.length) return;
	const positions = new Map(messages.map((message, index) => [message, index]));
	let next = 0;
	let complete = 0;
	let possibleReceipts = 0;
	// 旧回执是独立字符串，且只能出现在对应的未完成请求所在的轮次间隔。
	const validGap = (end) =>
		end >= next &&
		end - next <= possibleReceipts &&
		messages
			.slice(next, end)
			.every((message) => typeof message.content === "string" && message.flowerRequestId === undefined);
	for (const row of snapshot.requests) {
		if (row.status !== "succeeded") {
			if (
				["failed", "cancelled", "interrupted"].includes(row.status) &&
				row.toolResults?.length &&
				!tagged.has(row.requestId)
			) {
				possibleReceipts += 1;
			}
			continue;
		}
		const message = anchored[complete++];
		const index = positions.get(message);
		if (
			!validGap(index) ||
			!matchesInput(message, row) ||
			(row.userMessageIndex !== undefined &&
				(snapshot.messages[row.userMessageIndex] !== message || message.flowerRequestId !== row.requestId))
		)
			return;
		next = index + 1;
		possibleReceipts = 0;
	}
	if (validGap(messages.length)) return anchored[position];
}

/** 从成功请求实际发送给模型的资料中还原旧截图和工作区图片。
 * @param snapshot 会话快照
 * @param record 已验证的请求
 * @param ref 图片引用
 * @returns 模型当时收到的图片，可用于原文件变更后的历史预览
 */
export function sentImage(snapshot, record, ref) {
	if (record.status !== "succeeded") return;
	const content = messageForRequest(snapshot, record)?.content;
	if (!Array.isArray(content) || content[0]?.text !== record.input) return;
	const images = record.attachments?.filter((entry) => /\.(png|jpe?g|jpe|jfif|webp)$/i.test(entry.name)) ?? [];
	const parts = content.filter((part) => part.type === "image");
	const position = images.findIndex((entry) => entry.id === ref.id && entry.name === ref.name);
	const part = parts[position];
	if (parts.length !== images.length || !part || !["image/png", "image/jpeg", "image/webp"].includes(part.mimeType))
		return;
	const label = content[content.indexOf(part) - 1];
	if (label?.type !== "text" || label.text !== `图片附件：${ref.name}` || typeof part.data !== "string") return;
	return { mime: part.mimeType, bytes: new Uint8Array(Buffer.from(part.data, "base64")) };
}
