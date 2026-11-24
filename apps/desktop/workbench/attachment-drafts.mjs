import { posix } from "node:path";

/** 工作区文件的相对引用。@param path 文件相对路径 @returns 附件引用 */
export function fileReference(path) {
	return { id: `file:${path}`, name: posix.basename(path) };
}

/** 恢复当前草稿及旧版的单文件引用。@param owner 会话记录 @returns 可用的有序引用 */
export function draftAttachments(owner) {
	const refs = Array.isArray(owner.attachments) ? owner.attachments : owner.file ? [fileReference(owner.file)] : [];
	return refs
		.filter((ref) => typeof ref?.name === "string" && typeof ref.id === "string" && /^(file|asset):/.test(ref.id))
		.slice(0, 8);
}

/** 合并附件并保留首次选择顺序。@param owner 会话记录 @param incoming 新增引用 @returns 去重后的草稿 */
export function mergeAttachments(owner, incoming) {
	const entries = new Map(draftAttachments(owner).map((ref) => [ref.id, ref]));
	for (const ref of incoming) entries.set(ref.id, ref);
	if (entries.size > 8) throw new Error("每条消息最多添加 8 个附件。");
	return [...entries.values()];
}
