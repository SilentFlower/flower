#!/usr/bin/env node
/**
 * flower-observer HTTP 入口
 *
 * 常驻观测服务:接收 flower-telemetry httpSink 的批量 NDJSON 推送与 SIEM 审计事件,
 * SQLite 幂等入库,提供 trace 列表 / 回放 / 指标 Web UI。
 *
 * 装配顺序(后续 Step 逐步挂载):
 * - GET  /healthz          健康检查(routes/ingest.ts)
 * - POST /v1/events        NDJSON 批量 ingest(routes/ingest.ts)
 * - POST /v1/audit         SIEM 单条审计(Step 4)
 * - GET  /api/*            查询 JSON API(Step 5)
 * - GET  /traces /metrics  SSR 页面 + /static 静态资源(Step 6-7)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { ObserverDb } from "./db.js";
import { createApiRoutes } from "./routes/api.js";
import { createIngestRoutes } from "./routes/ingest.js";
import { createPageRoutes } from "./routes/pages.js";

/** 保留期清理的执行间隔(每日一次) */
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const config = loadConfig();
const db = new ObserverDb(config.dbPath);

const app = new Hono();
app.route("/", createIngestRoutes(db, config));
app.route("/", createApiRoutes(db, config));
app.route("/", createPageRoutes(db, config));

/**
 * 执行一轮保留期清理并输出结果日志
 */
function sweepExpired(): void {
	const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
	const deleted = db.deleteExpired(cutoffMs);
	if (deleted.traces > 0 || deleted.securityEvents > 0) {
		console.log(
			`[observer] 保留期清理(${config.retentionDays} 天): traces=${deleted.traces} events=${deleted.events} security_events=${deleted.securityEvents}`,
		);
	}
}

// 启动即清一轮,此后每日一轮;unref 不阻塞进程退出
sweepExpired();
setInterval(sweepExpired, RETENTION_SWEEP_INTERVAL_MS).unref();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`[observer] 监听 :${info.port},db=${config.dbPath}`);
});

// 优雅关闭:停止接收新连接后退出(SQLite 单文件无需额外收尾,WAL 由下次打开自动恢复)
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		console.log(`[observer] 收到 ${signal},准备关闭`);
		server.close();
		db.close();
		process.exit(0);
	});
}
