import { join } from "node:path";
import { copyStoredAttachment, importAttachmentImage } from "./attachment-assets.mjs";
import { fileReference } from "./attachment-drafts.mjs";
import { messageForRequest, sentImage } from "./attachment-history.mjs";

const actions = new Set(["edit", "rewind", "fork"]);
const active = new Set(["queued", "running", "cancelling"]);

function originalAttachments(snapshot, record) {
	const file = snapshot.desktopMessages?.[record.requestId]?.file;
	return record.attachments ?? (typeof file === "string" ? [fileReference(file)] : []);
}

/** 解析已完成请求的会话切点，保留来源会话的稳定请求归属。
 * @param snapshot 当前选中会话的持久快照
 * @param requestId 目标轮次
 * @param mode 修订方式
 * @returns 轮次区间及模型消息的结束位置
 */
export function planSessionRevision(snapshot, requestId, mode) {
	if (!actions.has(mode)) throw new Error("会话操作无效。");
	if (!snapshot?.requests || snapshot.requests.some(({ status }) => active.has(status)))
		throw new Error("请等待本会话的任务结束。");
	const index = snapshot.requests.findIndex((row) => row.requestId === requestId && row.status === "succeeded");
	if (index < 0) throw new Error("只能从已成功的消息开始此操作。");
	const record = snapshot.requests[index];
	const start = snapshot.messages.indexOf(messageForRequest(snapshot, record));
	if (start < 0) throw new Error("此历史消息的模型位置未能核对。");
	const count = mode === "edit" ? index : index + 1;
	let end = start;
	if (mode !== "edit") {
		const next = snapshot.requests.slice(index + 1).find(({ status }) => status === "succeeded");
		const limit = next ? snapshot.messages.indexOf(messageForRequest(snapshot, next)) : snapshot.messages.length;
		if (limit <= start) throw new Error("相邻历史消息的顺序未能核对。");
		// 未完成请求的回执可夹在两轮之间。将切点放在所选轮次最后一条助手响应之后。
		for (let i = start + 1; i < limit; i++) if (snapshot.messages[i].role === "assistant") end = i + 1;
		if (end === start) throw new Error("未找到这条消息的完整回答。");
	}
	return {
		end,
		count,
		record,
		input: snapshot.desktopMessages?.[requestId]?.input ?? record.input,
		retained: snapshot.requests.slice(0, count),
		excluded: snapshot.requests.slice(count),
	};
}

/** 复制会话前缀及已绑定的历史附件。来源快照和工作区文件供原会话继续使用。
 * @param directory 本机 sessions 目录
 * @param source 来源会话 ID
 * @param destination 目标会话 ID
 * @param snapshot 来源快照
 * @param plan 已核对的切点
 * @param mode 修订方式
 * @returns 新快照及可编辑重发的附件
 */
export async function copySessionPrefix(directory, source, destination, snapshot, plan, mode) {
	const copied = new Map();
	async function transfer(ref) {
		if (!ref.id.startsWith("asset:")) return ref;
		const key = JSON.stringify([ref.id, ref.name]);
		if (!copied.has(key)) copied.set(key, await copyStoredAttachment(directory, source, destination, ref));
		return copied.get(key);
	}
	const requests = structuredClone(plan.retained);
	for (const request of requests) {
		if (request.attachments?.length) request.attachments = await Promise.all(request.attachments.map(transfer));
		for (const steer of request.steers ?? []) {
			if (steer.attachments?.length) steer.attachments = await Promise.all(steer.attachments.map(transfer));
		}
	}
	const messageRefs = new Map([...copied].map(([key, ref]) => [JSON.parse(key)[0].slice(6), ref.id.slice(6)]));
	const messages = structuredClone(snapshot.messages.slice(0, plan.end));
	const rebind = (text) =>
		text.replace(/\battachment:([a-f\d]{64})\b/g, (reference, id) =>
			messageRefs.has(id) ? `attachment:${messageRefs.get(id)}` : reference,
		);
	// 只更新派生会话的模型上下文。原会话和界面展示的消息原文保留。
	for (const message of messages) {
		if (!messageRefs.size || !Array.isArray(message.content)) continue;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") part.text = rebind(part.text);
				if (part.type !== "toolCall") continue;
				for (const field of ["path", "input"]) {
					const value = part.arguments?.[field];
					if (typeof value === "string" && /^attachment:[a-f\d]{64}$/.test(value)) part.arguments[field] = rebind(value);
				}
			}
		}
		if (message.role === "user") {
			for (const part of message.content.slice(1)) {
				if (part.type === "text" && /^对话附件：[^\n]*；文件工具使用引用 attachment:[a-f\d]{64}。$/u.test(part.text))
					part.text = rebind(part.text);
			}
		}
	}
	const attachments = [];
	if (mode === "edit") {
		for (const ref of originalAttachments(snapshot, plan.record)) {
			if (!ref.id.startsWith("clip:")) {
				attachments.push(await transfer(ref));
				continue;
			}
			const image = sentImage(snapshot, plan.record, ref);
			if (image?.mime !== "image/png") throw new Error("此旧截图不能重发。原会话中仍可预览。");
			attachments.push(await importAttachmentImage(directory, destination, image.bytes, ref.name));
		}
	}
	const kept = new Set(requests.map(({ requestId }) => requestId));
	const checkpoint = snapshot.contextCheckpoint;
	const desktopMessages = Object.fromEntries(
		Object.entries(snapshot.desktopMessages ?? {}).filter(([requestId]) => kept.has(requestId)),
	);
	return {
		attachments,
		snapshot: {
			version: 1,
			workspaceId: snapshot.workspaceId ?? requests[0]?.workspaceId ?? plan.record.workspaceId,
			lastSequence: snapshot.lastSequence,
			requests,
			messages,
			...(checkpoint?.through <= plan.end && !messageRefs.size && { contextCheckpoint: checkpoint }),
			artifacts: [],
			operations: [],
			desktopMessages,
		},
	};
}

/** 返回未公布的派生会话私有文件位置。
 * @param directory sessions 目录
 * @param id 主进程生成的会话 ID
 * @returns 私有记录与附件目录
 */
export function revisionPaths(directory, id) {
	return [join(directory, `${id}.json`), join(directory, "attachment-assets", id)];
}
