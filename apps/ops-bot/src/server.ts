#!/usr/bin/env node
/**
 * ops-bot HTTP 入口
 *
 * 故意只用 Node 内置 http 模块,避免引入额外框架。
 * 路由表手写,因为我们只有 2-3 个 endpoint。
 *
 * 设计:
 * - POST /dingtalk/webhook  钉钉消息回调
 * - GET  /healthz           健康检查
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleDingTalkWebhook } from "./dingtalk/webhook.js";
import { closeSessionStore } from "./session-store.js";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

const server = createServer(async (req, res) => {
	try {
		await route(req, res);
	} catch (err) {
		console.error("[ops-bot] 处理请求出错:", err);
		if (!res.headersSent) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "internal_error" }));
		}
	}
});

server.listen(PORT, () => {
	console.log(`[ops-bot] 监听 :${PORT}`);
});

// 优雅关闭
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		console.log(`[ops-bot] 收到 ${signal},准备关闭`);
		server.close();
		await closeSessionStore();
		process.exit(0);
	});
}

/**
 * 路由分发
 */
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const { method, url } = req;

	if (method === "GET" && url === "/healthz") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		return;
	}

	if (method === "POST" && url === "/dingtalk/webhook") {
		await handleDingTalkWebhook(req, res);
		return;
	}

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "not_found" }));
}
