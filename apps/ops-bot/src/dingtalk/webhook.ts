/**
 * 钉钉 webhook 处理
 *
 * 关键约束:
 * 1. 必须在 5 秒内返回 200,否则钉钉会重试
 * 2. 真实处理放后台,通过 sessionWebhook 流式推回
 * 3. 必须校验 timestamp + sign,防止伪造请求
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMessage } from "../handler.js";
import { pushToSession } from "./push.js";
import { verifySignature } from "./signature.js";

/**
 * 钉钉 webhook 请求体(简化版)
 *
 * 真实请求字段见钉钉文档:
 * https://open.dingtalk.com/document/orgapp/receive-message
 */
interface DingTalkRequest {
	/** 会话 ID(群 / 单聊统一) */
	conversationId: string;
	/** 发送者 staffId */
	senderStaffId: string;
	/** 发送者昵称 */
	senderNick: string;
	/** 消息文本 */
	text: { content: string };
	/** 流式回复的 webhook URL,5 分钟有效 */
	sessionWebhook: string;
	/** 钉钉服务端的 timestamp,用于鉴权 */
	timestamp: number;
	/** 是否在群里 @我 */
	isInAtList?: boolean;
}

/**
 * 处理钉钉消息回调
 */
export async function handleDingTalkWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const body = await readBody(req);
	const timestamp = req.headers.timestamp as string | undefined;
	const sign = req.headers.sign as string | undefined;

	// 鉴权
	const secret = process.env.DINGTALK_BOT_SECRET;
	if (secret && (!timestamp || !sign || !verifySignature(timestamp, sign, secret))) {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "invalid_signature" }));
		return;
	}

	let payload: DingTalkRequest;
	try {
		payload = JSON.parse(body) as DingTalkRequest;
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "bad_json" }));
		return;
	}

	// 立即应答,避免 5s 超时
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({}));

	// 后台跑 agent,流式推回
	queueMicrotask(async () => {
		try {
			await handleMessage({
				conversationId: payload.conversationId,
				userId: payload.senderStaffId,
				userName: payload.senderNick,
				text: payload.text.content,
				onChunk: (chunk, isFinal) => pushToSession(payload.sessionWebhook, chunk, isFinal),
			});
		} catch (err) {
			console.error("[ops-bot] 处理消息失败:", err);
			await pushToSession(
				payload.sessionWebhook,
				`抱歉,处理出错了:${err instanceof Error ? err.message : String(err)}`,
				true,
			).catch(() => {});
		}
	});
}

/**
 * 读取请求 body(简化版,假设是小 JSON)
 */
async function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 1_000_000) {
				reject(new Error("payload too large"));
			}
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}
