/**
 * ingest 路由:POST /v1/events(NDJSON 批量)+ GET /healthz
 *
 * 线协议(flower-telemetry README「httpSink 线协议」节,严格实现):
 * - 2xx = 成功,其余客户端整批重试 → 绝不返回 3xx(重定向会被 fetch 跟随或判失败,语义混乱)
 * - 配置 OBSERVER_INGEST_TOKEN 时校验 `Authorization: Bearer <token>`,失败 401
 *   (客户端 fail-open,401 不影响评审主流程);未配置 = 内网裸跑不鉴权
 * - 坏行容忍:响应 200 携带 badLines 计数,绝不因杂行拒整批
 */

import { Hono } from "hono";
import type { ObserverConfig } from "../config.js";
import type { ObserverDb } from "../db.js";
import { ingestAudit, ingestNdjson } from "../ingest.js";

/**
 * 创建 ingest 路由(/healthz 一并挂载;/v1/* 统一过 Bearer 鉴权)
 *
 * @param db 观测库 DAO
 * @param config 运行配置(取 ingestToken)
 * @returns 可被主 app route 挂载的 Hono 子应用
 */
export function createIngestRoutes(db: ObserverDb, config: ObserverConfig): Hono {
	const routes = new Hono();

	routes.get("/healthz", (c) => c.json({ ok: true }));

	// Bearer 鉴权:仅覆盖写入端点(/v1/*);读 API 与页面不鉴权(内网工具,无多租户假设)
	routes.use("/v1/*", async (c, next) => {
		if (config.ingestToken !== "" && c.req.header("Authorization") !== `Bearer ${config.ingestToken}`) {
			return c.json({ error: "unauthorized" }, 401);
		}
		await next();
	});

	routes.post("/v1/events", async (c) => {
		// 用原始文本体解析 NDJSON(不能走 JSON 解析器,行间无逗号)
		const body = await c.req.text();
		const result = ingestNdjson(db, body);
		return c.json(result, 200);
	});

	routes.post("/v1/audit", async (c) => {
		// 单条 JSON 审计(sendAudit 兼容);用原文入库,parse 由 ingest 层负责
		const body = await c.req.text();
		const result = ingestAudit(db, body, Date.now());
		if (result === undefined) {
			return c.json({ error: "invalid_payload" }, 400);
		}
		return c.json(result, 200);
	});

	return routes;
}
