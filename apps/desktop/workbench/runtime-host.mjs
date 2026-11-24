import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isContextOverflow } from "@earendil-works/pi-ai";

const protocol = 1;

/** 管理本机工作台的专用运行时子进程和模型调用 IPC。
 * @param options Electron 启动器、分区、模型代理、个人全局指令和事件回调
 * @returns 启动、请求与关闭操作
 */
export function createRuntimeHost({
	fork,
	directory,
	model,
	instructions = "",
	onEvent,
	onReasoning,
	onExit,
	gateway,
	authorizeWrite,
}) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => /^(systemroot|windir|temp|tmp)$/i.test(key)),
	);
	const child = fork(fileURLToPath(new URL("./worker.mjs", import.meta.url)), [], {
		serviceName: "Flower Desktop Runtime",
		env,
		stdio: "ignore",
	});
	const pending = new Map();
	const streams = new Map();
	const writes = new Map();
	let closed = false;

	function send(frame) {
		if (closed) return;
		try {
			child.postMessage({ protocol, ...frame });
		} catch {
			close();
		}
	}

	function close(kill = true) {
		if (closed) return;
		closed = true;
		for (const controller of streams.values()) controller.abort();
		streams.clear();
		for (const controller of writes.values()) controller.abort();
		writes.clear();
		for (const { reject, timeout } of pending.values()) {
			clearTimeout(timeout);
			reject(new Error("当前工作进程已关闭"));
		}
		pending.clear();
		if (kill) child.kill();
		else onExit();
	}

	async function writeRequest(frame) {
		if (writes.has(frame.id)) return;
		const controller = new AbortController();
		writes.set(frame.id, controller);
		let decision = "deny";
		try {
			decision = (await authorizeWrite?.(frame, controller.signal)) ?? "deny";
		} catch {
			// Host 无法核验授权时，工具按拒绝处理。
		} finally {
			writes.delete(frame.id);
		}
		if (!controller.signal.aborted) send({ type: "write-decision", id: frame.id, decision });
	}

	/**
	 * 向工作进程发送命令并等待响应；超时视为进程失去响应并关闭。
	 * @param {string} type 命令
	 * @param {object} [fields] 命令字段
	 * @param {number} [timeoutMs] 超时，手动压缩等模型调用需要更长时间
	 * @returns {Promise<unknown>} 响应值
	 */
	function call(type, fields = {}, timeoutMs = 20000) {
		if (closed) return Promise.reject(new Error("当前工作进程已关闭"));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error("工作进程响应超时"));
				close();
				onExit();
			}, timeoutMs);
			pending.set(id, { resolve, reject, timeout });
			send({ id, type, ...fields });
		});
	}

	async function modelRequest(frame) {
		const { id, context, maxTokens, reasoningOff } = frame;
		if (streams.has(id)) return;
		const controller = new AbortController();
		streams.set(id, controller);
		try {
			const events = await gateway({ context, maxTokens, reasoningOff, signal: controller.signal });
			for await (const event of events) {
				if (closed || controller.signal.aborted) break;
				// SDK 的原始错误可能含网关返回体，通用事件只转发固定提示。
				const safe =
					event.type === "error"
						? {
								...event,
								error: {
									...event.error,
									errorMessage: isContextOverflow(event.error) ? "exceeds the context window" : "模型请求未完成",
								},
							}
						: event;
				send({ type: "model-event", id, event: safe });
			}
		} catch (error) {
			send({ type: "model-failed", id, overflow: error?.code === "context-limit" });
		} finally {
			streams.delete(id);
			send({ type: "model-end", id });
		}
	}

	child.on("message", (frame) => {
		if (closed || !frame || frame.protocol !== protocol) return;
		switch (frame.kind) {
			case "response": {
				const record = pending.get(frame.id);
				if (!record) return;
				pending.delete(frame.id);
				clearTimeout(record.timeout);
				if (frame.error) record.reject(new Error(frame.error));
				else record.resolve(frame.value);
				break;
			}
			case "event":
				onEvent(frame.event);
				break;
			case "reasoning":
				if (typeof frame.sessionId === "string" && typeof frame.requestId === "string" && typeof frame.text === "string")
					onReasoning?.({ sessionId: frame.sessionId, requestId: frame.requestId, text: frame.text.slice(0, 120) });
				break;
			case "model":
				if (typeof frame.id === "string") void modelRequest(frame);
				break;
			case "cancel-model":
				streams.get(frame.id)?.abort();
				break;
			case "write":
				if (typeof frame.id === "string") void writeRequest(frame);
				break;
			case "cancel-write":
				writes.get(frame.id)?.abort();
				break;
		}
	});
	child.once("exit", () => close(false));
	return { call, close, ready: call("init", { directory: join(directory, "sessions"), model, instructions }) };
}
