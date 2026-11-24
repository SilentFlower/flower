import { join } from "node:path";
import { readJson, writeJson } from "./storage.mjs";

const attachmentHint = "\n\n已选择的工作区相对路径：";

/** 为共享核心提供桌面会话存储，并在同一份快照中保留每条请求的展示信息。
 * @param directory 当前本机工作台的记录目录
 * @returns 会话存储、请求提交及历史展示入口
 */
export function createRequestHistory(directory) {
	const saved = new Map();
	const pending = new Map();
	const submissionTails = new Map();

	function display(sessionId, record) {
		const message = saved.get(sessionId)?.messages[record.requestId];
		// 旧版记录没有附件来源字段。原样显示才能保留用户亲自输入的同形文字。
		return typeof message?.input === "string" ? { ...record, input: message.input, file: message.file } : record;
	}

	return {
		store: {
			async load({ sessionId }) {
				const stored = await readJson(join(directory, `${sessionId}.json`));
				if (!stored) return undefined;
				const { desktopMessages, ...snapshot } = stored;
				saved.set(sessionId, { count: snapshot.requests.length, messages: desktopMessages ?? {} });
				return snapshot;
			},
			async save({ sessionId }, snapshot) {
				const before = saved.get(sessionId) ?? { count: 0, messages: {} };
				const count = snapshot.requests.length;
				let { messages } = before;
				if (count !== before.count) {
					const message = pending.get(sessionId);
					const request = snapshot.requests.at(-1);
					// 核心只追加请求。当前提交串行到入队落盘，状态更新和恢复沿用已保存的请求数。
					if (!message || count !== before.count + 1 || request.status !== "queued")
						throw new Error("无法关联桌面请求与原始输入");
					messages = { ...messages, [request.requestId]: message };
				}
				await writeJson(join(directory, `${sessionId}.json`), { ...snapshot, desktopMessages: messages });
				saved.set(sessionId, { count, messages });
			},
		},
		async submit(sessionId, message, enqueue) {
			const previous = submissionTails.get(sessionId) ?? Promise.resolve();
			const submitted = previous.then(async () => {
				pending.set(sessionId, message);
				try {
					const { input, file } = message;
					const prompt = input.trim() + (file ? attachmentHint + JSON.stringify(file) : "");
					return display(sessionId, await enqueue(prompt));
				} finally {
					pending.delete(sessionId);
				}
			});
			const tail = submitted.catch(() => {});
			submissionTails.set(sessionId, tail);
			try {
				return await submitted;
			} finally {
				if (submissionTails.get(sessionId) === tail) submissionTails.delete(sessionId);
			}
		},
		display,
	};
}

/**
 * 推导最近一次压缩（自动或手动）在时间线中的位置：检查点之后第一条成功请求之前；全部已归纳时在最后一条成功请求之后。
 * @param {object} snapshot 会话快照
 * @returns {{before?: string, after?: string, trigger?: "auto" | "manual"} | undefined} 分隔所在的请求与压缩方式，无法确定时为空
 */
export function compactionMark(snapshot) {
	const through = snapshot.contextCheckpoint?.through;
	if (!Number.isSafeInteger(through) || through < 1) return;
	// 早期记录没有 userMessageIndex，按消息上的 flowerRequestId 找回位置。
	const tagged = new Map(
		snapshot.messages.flatMap((message, index) => (message.flowerRequestId ? [[message.flowerRequestId, index]] : [])),
	);
	const trigger = snapshot.contextCheckpoint.trigger;
	const succeeded = snapshot.requests.filter(({ status }) => status === "succeeded");
	for (const record of succeeded) {
		const index = record.userMessageIndex ?? tagged.get(record.requestId);
		// 位置字段与检查点同时引入，缺位置的只会是会话开头的旧轮次，跳过后按后续轮次定位。
		if (index === undefined) continue;
		if (index >= through) return { before: record.requestId, trigger };
	}
	const last = succeeded.at(-1);
	return last && { after: last.requestId, trigger };
}
