/**
 * SSR 页面路由 + 静态资源
 *
 * - GET /            → 302 /traces(页面跳转;ingest 端点「禁 3xx」契约只约束 /v1/*)
 * - GET /traces      → 列表页(URL query 即过滤状态)
 * - GET /traces/:id  → 详情回放页(running 时 30s 自动刷新)
 * - GET /metrics     → 指标页(Step 7)
 * - GET /static/*    → 白名单静态资源(显式枚举,路径遍历免疫)
 */

import { readFile } from "node:fs/promises";
import type { TelemetryEvent } from "@flower-ai/flower-telemetry";
import { Hono } from "hono";
import type { ObserverConfig } from "../config.js";
import type { ObserverDb } from "../db.js";
import { aggregateMetrics } from "../metrics.js";
import { displayStatus } from "../trace-status.js";
import { escapeHtml, renderLayout } from "../views/layout.js";
import { renderMetricsPage } from "../views/metrics.js";
import { renderTraceDetailPage } from "../views/trace-detail.js";
import { renderTraceListPage } from "../views/trace-list.js";
import { buildTraceFlow } from "../views/tree.js";
import { DEFAULT_LOOKBACK, LOOKBACK_MS, PAGE_SIZE, parseTraceListQuery } from "./api.js";

/** running 详情页自动刷新间隔(实时跟看新事件) */
const DETAIL_AUTO_REFRESH_MS = 30_000;

/** 顶栏 lookback 键 → 指标统计窗口天数(1h 粒度下退化为单日) */
const LOOKBACK_DAYS: Record<string, number> = { "1h": 1, "24h": 1, "7d": 7, "30d": 30 };

/**
 * 静态资源白名单:URL 子路径 → { 相对 static/ 的文件名, Content-Type }
 *
 * 显式枚举而非目录遍历:总共个位数文件,白名单天然免疫路径穿越。
 */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
	"app.css": { file: "app.css", type: "text/css; charset=utf-8" },
	"app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
	"vendor/uplot.css": { file: "vendor/uplot.css", type: "text/css; charset=utf-8" },
	"vendor/uplot.js": { file: "vendor/uplot.js", type: "text/javascript; charset=utf-8" },
};

/**
 * static 目录定位:dist/routes/pages.js → ../static = dist/static(build 时 cp);
 * tsx 直跑 src/routes/pages.ts → ../static = src/static(dev 免拷贝)。
 */
const STATIC_DIR = new URL("../static/", import.meta.url);

/**
 * 创建页面路由
 *
 * @param db 观测库 DAO
 * @param config 运行配置
 * @returns 可被主 app route 挂载的 Hono 子应用
 */
export function createPageRoutes(db: ObserverDb, config: ObserverConfig): Hono {
	const pages = new Hono();

	pages.get("/", (c) => c.redirect("/traces"));

	pages.get("/traces", (c) => {
		const nowMs = Date.now();
		const rawQuery = c.req.query();
		// 表单多 checkbox 同名提交(status=a&status=b)与逗号分隔(status=a,b)两种形态都接受
		const statusParam = (c.req.queries("status") ?? []).join(",");
		const { filter, page, lookback } = parseTraceListQuery(
			{ ...rawQuery, status: statusParam },
			nowMs,
			config.staleRunningMinutes,
		);
		const { rows, total } = db.listTraces(filter);
		const products = db.listProducts();
		const currentProduct = rawQuery.product ?? "";

		// 统计条:今日(本地零点起)按当前板块
		const todayStart = new Date(nowMs);
		todayStart.setHours(0, 0, 0, 0);
		const todayRows = db.listTracesSince(todayStart.getTime(), currentProduct);
		let todayFailed = 0;
		let durationSum = 0;
		let durationCount = 0;
		for (const row of todayRows) {
			if (displayStatus(row, nowMs, config.staleRunningMinutes) === "failed") todayFailed += 1;
			if (row.duration_ms !== null) {
				durationSum += row.duration_ms;
				durationCount += 1;
			}
		}

		const body = renderTraceListPage({
			rows: rows.map((row) => ({ row, display: displayStatus(row, nowMs, config.staleRunningMinutes) })),
			total,
			page,
			pageSize: PAGE_SIZE,
			projects: db.listProjects(currentProduct),
			query: {
				product: currentProduct,
				project: rawQuery.project ?? "",
				mr: rawQuery.mr ?? "",
				statuses: filter.statuses ?? [],
				lookback,
			},
			today: {
				count: todayRows.length,
				failed: todayFailed,
				avgDurationMs: durationCount > 0 ? durationSum / durationCount : null,
			},
			gitlabBaseUrl: config.gitlabBaseUrl,
			nowMs,
		});
		return c.html(
			renderLayout({
				title: "评审",
				activeNav: "traces",
				products,
				currentProduct,
				currentLookback: lookback,
				body,
			}),
		);
	});

	pages.get("/traces/:id", (c) => {
		const traceId = c.req.param("id");
		const trace = db.getTrace(traceId);
		const products = db.listProducts();
		if (trace === undefined) {
			return c.html(
				renderLayout({
					title: "未找到",
					activeNav: "traces",
					products,
					currentProduct: "",
					body: `<p class="empty">trace <span class="mono">${escapeHtml(traceId)}</span> 不存在(可能已超保留期被清理)</p>`,
				}),
				404,
			);
		}
		const events: unknown[] = [];
		for (const row of db.listEventsByTrace(traceId)) {
			try {
				events.push(JSON.parse(row.payload));
			} catch {
				// 入库前已过校验,防御跳过
			}
		}
		// payload 即 TelemetryEvent 原文(入库前已过信封校验),parse 后按事件模型消费
		const flow = buildTraceFlow(events as TelemetryEvent[]);
		const display = displayStatus(trace, Date.now(), config.staleRunningMinutes);
		const body = renderTraceDetailPage({ trace, display, flow, gitlabBaseUrl: config.gitlabBaseUrl });
		return c.html(
			renderLayout({
				title:
					trace.project !== null && trace.project !== "unknown" ? `${trace.project} !${trace.mr_iid ?? ""}` : trace.trace_id,
				activeNav: "traces",
				products,
				currentProduct: trace.product,
				...(display === "running" ? { autoRefreshMs: DETAIL_AUTO_REFRESH_MS } : {}),
				body,
			}),
		);
	});

	pages.get("/metrics", (c) => {
		const nowMs = Date.now();
		const rawQuery = c.req.query();
		const lookback =
			rawQuery.lookback !== undefined && LOOKBACK_MS[rawQuery.lookback] !== undefined
				? rawQuery.lookback
				: DEFAULT_LOOKBACK;
		const days = LOOKBACK_DAYS[lookback] ?? 7;
		const sinceMs = nowMs - days * 24 * 60 * 60 * 1000;
		const currentProduct = rawQuery.product ?? "";
		const rows = db.listTracesSince(sinceMs, currentProduct);
		const payload = aggregateMetrics(rows, { sinceMs, nowMs, staleRunningMinutes: config.staleRunningMinutes });
		const body = renderMetricsPage({
			payload,
			days,
			slowestDisplay: payload.slowest.map((row) => displayStatus(row, nowMs, config.staleRunningMinutes)),
			gitlabBaseUrl: config.gitlabBaseUrl,
			nowMs,
		});
		return c.html(
			renderLayout({
				title: "概览",
				activeNav: "metrics",
				products: db.listProducts(),
				currentProduct,
				currentLookback: lookback,
				extraHead: '<link rel="stylesheet" href="/static/vendor/uplot.css">\n<script src="/static/vendor/uplot.js"></script>',
				body,
			}),
		);
	});

	pages.get("/static/*", async (c) => {
		const name = c.req.path.slice("/static/".length);
		const entry = STATIC_FILES[name];
		if (entry === undefined) {
			return c.json({ error: "not_found" }, 404);
		}
		try {
			const content = await readFile(new URL(entry.file, STATIC_DIR));
			return c.body(content, 200, { "Content-Type": entry.type, "Cache-Control": "no-cache" });
		} catch {
			// dist/static 未拷贝等部署异常:404 而非 500,页面仍可用(无样式降级)
			return c.json({ error: "not_found" }, 404);
		}
	});

	return pages;
}
