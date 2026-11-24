import { randomUUID } from "node:crypto";

const queueLimit = 20;
const inputLimit = 16000;

function validInput(input) {
	if (typeof input !== "string" || !input.trim() || input.length > inputLimit) {
		throw new Error(`请输入有效任务说明，最多 ${inputLimit} 字符`);
	}
	return input;
}

/** 读取会话记录中的有效排队消息。@param owner 会话记录 @returns 排队消息 */
export function storedQueue(owner) {
	return (Array.isArray(owner?.queue) ? owner.queue : []).filter(
		(item) =>
			typeof item?.id === "string" &&
			typeof item.input === "string" &&
			(item.attachments === undefined || Array.isArray(item.attachments)),
	);
}

/**
 * 会话排队消息：运行、待批准或压缩中发送的消息先在本机排队，当前任务结束后按顺序发送。
 * 用户停止运行、工作进程退出或应用重启后暂停，点继续或再次发送时恢复。
 * @param {object} host 宿主能力
 * @param {(id: string) => object | undefined} host.find 按 ID 取会话记录
 * @param {() => object[]} host.list 全部会话记录
 * @param {() => Promise<void>} host.persist 保存全部会话记录
 * @param {(id: string, item: {input: string, attachments?: object[]}) => Promise<object>} host.submit 直接提交给运行时
 * @param {(id: string, runId: string, item: object) => Promise<void>} host.steer 向当前运行插话
 * @param {(id: string) => {runId: string} | undefined} host.running 会话当前运行中的请求
 * @param {(id: string) => boolean} host.busy 会话是否有运行、排队、待批准或压缩中的任务
 * @param {(id: string, text: string) => void} host.notify 向界面发送错误提示
 * @param {(action: () => Promise<unknown>) => Promise<unknown>} host.serialize 与其他会话变更同序执行
 * @returns {object} 队列操作
 */
export function createSessionQueue({ find, list, persist, submit, steer, running, busy, notify, serialize }) {
	// 已交给运行时、尚未确认送达的插话，只在本次运行期间有效。
	const steering = new Map();
	// 界面正在行内编辑的消息（会话 ID → 消息 ID），编辑结束前不派发，避免把修改前的原文发出。
	const editing = new Map();

	function owner(id) {
		const found = find(id);
		if (!found) throw new Error("没有找到对应的本机会话。");
		return found;
	}

	async function save(record, queue, paused) {
		const before = { queue: record.queue, paused: record.queuePaused };
		if (queue.length) record.queue = queue;
		else delete record.queue;
		if (paused && queue.length) record.queuePaused = true;
		else delete record.queuePaused;
		try {
			await persist();
		} catch (error) {
			record.queue = before.queue;
			record.queuePaused = before.paused;
			throw error;
		}
	}

	function item(record, itemId) {
		const found = storedQueue(record).find(({ id }) => id === itemId);
		if (!found) throw new Error("这条排队消息已发送或已删除。");
		if (steering.has(itemId)) throw new Error("这条消息正在插话，送达后会从队列移除。");
		return found;
	}

	async function dispatch(id) {
		const record = find(id);
		const [next] = storedQueue(record);
		if (!next || record.queuePaused || busy(id) || editing.get(id) === next.id) return;
		try {
			await submit(id, next);
		} catch (error) {
			// 队首保留，暂停后由用户处理，避免反复失败。
			await save(record, storedQueue(record), true).catch(() => {});
			notify(id, `排队消息未能发送：${error?.message ?? "请稍后重试"}`);
			return;
		}
		await save(
			record,
			storedQueue(record).filter(({ id: queued }) => queued !== next.id),
			record.queuePaused,
		).catch(() => {});
	}

	function schedule(id) {
		void serialize(() => dispatch(id)).catch(() => {});
	}

	return {
		/**
		 * 会话空闲且队列为空时直接提交，否则加入队尾；暂停中的队列随之恢复。
		 * @param {object} record 会话记录
		 * @param {string} input 消息原文
		 * @param {object[]} attachments 附件引用
		 * @returns {Promise<object>} 运行时请求记录，或 {queued: 排队消息 ID}
		 */
		async accept(record, input, attachments = []) {
			validInput(input);
			const queue = storedQueue(record);
			if (!busy(record.id) && !queue.length && !record.queuePaused) return submit(record.id, { input, attachments });
			if (queue.length >= queueLimit) throw new Error(`排队消息最多 ${queueLimit} 条，请等待当前任务结束。`);
			const queued = { id: randomUUID(), input, ...(attachments.length ? { attachments } : {}), createdAt: Date.now() };
			await save(record, [...queue, queued], false);
			if (!busy(record.id)) schedule(record.id);
			return { queued: queued.id };
		},
		/**
		 * 行内编辑排队消息：替换文字，只保留指定的附件，位置不变。
		 * @param {string} id 会话 ID
		 * @param {string} itemId 排队消息 ID
		 * @param {string} input 新的原文
		 * @param {string[]} keep 保留的附件 ID
		 * @returns {Promise<object[]>} 被移除的附件
		 */
		async edit(id, itemId, input, keep) {
			validInput(input);
			if (!Array.isArray(keep)) throw new Error("附件列表无效。");
			const record = owner(id);
			const current = item(record, itemId);
			const attachments = (current.attachments ?? []).filter((ref) => keep.includes(ref.id));
			const next = { ...current, input };
			if (attachments.length) next.attachments = attachments;
			else delete next.attachments;
			await save(
				record,
				storedQueue(record).map((entry) => (entry.id === itemId ? next : entry)),
				record.queuePaused,
			);
			if (editing.get(id) === itemId) {
				editing.delete(id);
				schedule(id);
			}
			return (current.attachments ?? []).filter((ref) => !keep.includes(ref.id));
		},
		/**
		 * 从队列取出一条消息，用于删除或转为侧边追问。
		 * @param {string} id 会话 ID
		 * @param {string} itemId 排队消息 ID
		 * @returns {Promise<object>} 取出的消息
		 */
		async take(id, itemId) {
			const record = owner(id);
			const current = item(record, itemId);
			if (editing.get(id) === itemId) editing.delete(id);
			await save(
				record,
				storedQueue(record).filter((entry) => entry.id !== itemId),
				record.queuePaused,
			);
			return current;
		},
		/**
		 * 把取出后未能使用的消息放回队首。
		 * @param {string} id 会话 ID
		 * @param {object} entry 之前取出的消息
		 * @returns {Promise<void>}
		 */
		async restore(id, entry) {
			const record = owner(id);
			await save(record, [entry, ...storedQueue(record)], record.queuePaused);
		},
		/**
		 * 按给定顺序重排，ID 集合必须与当前队列一致。
		 * @param {string} id 会话 ID
		 * @param {string[]} ids 新顺序
		 * @returns {Promise<void>}
		 */
		async reorder(id, ids) {
			const record = owner(id);
			const queue = storedQueue(record);
			if (
				!Array.isArray(ids) ||
				ids.length !== queue.length ||
				new Set(ids).size !== ids.length ||
				!queue.every((entry) => ids.includes(entry.id))
			)
				throw new Error("队列已变化，请重新排序。");
			const byId = new Map(queue.map((entry) => [entry.id, entry]));
			await save(
				record,
				ids.map((key) => byId.get(key)),
				record.queuePaused,
			);
		},
		/**
		 * 界面开始或结束行内编辑。开始时校验消息仍在队列且未在插话；结束后补派发。
		 * @param {string} id 会话 ID
		 * @param {string} [itemId] 正在编辑的消息 ID，缺省表示结束编辑
		 * @returns {void}
		 */
		hold(id, itemId) {
			if (itemId) {
				item(owner(id), itemId);
				editing.set(id, itemId);
				return;
			}
			if (editing.delete(id)) schedule(id);
		},
		/** 切换会话或页面重新加载时放弃编辑暂缓。@param {string} [id] 会话 ID，缺省时全部放弃 @returns {void} */
		release(id) {
			for (const key of id ? [id] : [...editing.keys()]) if (editing.delete(key)) schedule(key);
		},
		/** 恢复暂停的队列并发送队首。@param {string} id 会话 ID @returns {Promise<void>} */
		async resume(id) {
			const record = owner(id);
			await save(record, storedQueue(record), false);
			schedule(id);
		},
		/** 用户停止运行时暂停队列。先同步置位，确保随后到达的终态不会派发。@param {string} id 会话 ID @returns {void} */
		pause(id) {
			const record = find(id);
			if (!record || !storedQueue(record).length || record.queuePaused) return;
			record.queuePaused = true;
			void persist().catch(() => {});
		},
		/**
		 * 把排队消息作为插话送入当前运行。送达前保留在队列中。
		 * @param {string} id 会话 ID
		 * @param {string} itemId 排队消息 ID
		 * @returns {Promise<void>}
		 */
		async steer(id, itemId) {
			const record = owner(id);
			const current = item(record, itemId);
			const run = running(id);
			if (!run) throw new Error("当前没有运行中的任务，无法插话。");
			steering.set(itemId, { session: id, runId: run.runId });
			try {
				await steer(id, run.runId, current);
			} catch (error) {
				steering.delete(itemId);
				throw error;
			}
		},
		/**
		 * 处理运行事件：插话送达后移出队列，运行结束时未送达的插话回到队首并暂停，然后派发下一条。
		 * @param {object} event 运行时事件
		 * @returns {{input: string, attachments?: object[]} | undefined} steered 事件对应的插话原文
		 */
		receive(event) {
			const { type, sessionId: id } = event;
			if (type === "steered") {
				const entry = steering.get(event.steerId);
				if (entry?.session !== id) return;
				steering.delete(event.steerId);
				const record = find(id);
				const delivered = storedQueue(record).find(({ id: key }) => key === event.steerId);
				void serialize(() =>
					save(
						record,
						storedQueue(record).filter(({ id: key }) => key !== event.steerId),
						record.queuePaused,
					),
				).catch(() => {});
				return delivered && { input: delivered.input, attachments: delivered.attachments ?? [] };
			}
			if (type !== "terminal") return;
			const returned = [...steering].filter(([, entry]) => entry.session === id && entry.runId === event.runId);
			for (const [key] of returned) steering.delete(key);
			const record = find(id);
			if (!record) return;
			if (returned.length) {
				void serialize(async () => {
					const keys = new Set(returned.map(([key]) => key));
					const queue = storedQueue(record);
					await save(
						record,
						[...queue.filter(({ id: key }) => keys.has(key)), ...queue.filter(({ id: key }) => !keys.has(key))],
						true,
					);
					notify(id, "插话未能送达，已放回队首并暂停队列。");
				}).catch(() => {});
				return;
			}
			schedule(id);
		},
		/** 工作进程退出时暂停所有队列，插话状态随运行一起失效。@returns {void} */
		pauseAll() {
			steering.clear();
			const paused = list().filter((record) => storedQueue(record).length && !record.queuePaused);
			for (const record of paused) record.queuePaused = true;
			if (paused.length) void persist().catch(() => {});
		},
		/** 会话空闲时派发队首，例如压缩结束后。@param {string} id 会话 ID @returns {void} */
		schedule,
		/**
		 * 当前会话的队列视图。
		 * @param {string} id 会话 ID
		 * @returns {{items: object[], paused: boolean, steerable: boolean}} 排队消息、暂停状态与能否插话
		 */
		view(id) {
			const record = find(id);
			return {
				items: storedQueue(record).map(({ id: key, input, attachments }) => ({
					id: key,
					input,
					attachments: attachments ?? [],
					steering: steering.has(key),
				})),
				paused: Boolean(record?.queuePaused),
				steerable: Boolean(running(id)),
			};
		},
	};
}
