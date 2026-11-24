/**
 * 查询 JSON API(读路径,不鉴权——内网工具,无多租户假设)
 *
 * - GET /api/traces      列表(板块/时间/项目/MR/状态过滤 + 分页;status 含 stale 展示语义)
 * - GET /api/traces/:id  单条 trace + 全量事件(payload 已 parse,回放顺序)
 * - GET /api/products    产品板块动态发现(R4)
 * - GET /api/metrics     指标页聚合(卡片 / 按天 / 时长分布 / 最慢 Top10)
 */

import { Hono } from "hono";
import type { ObserverConfig } from "../config.js";
import type { ObserverDb, TraceStatus } from "../db.js";
import { aggregateMetrics } from "../metrics.js";
import { displayStatus } from "../trace-status.js";

/** 列表页固定分页大小 */
export const PAGE_SIZE = 50;

/** lookback 快捷项 → 毫秒(列表页过滤器全集,默认 7d) */
export const LOOKBACK_MS: Record<string, number> = {
	"1h": 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
};

/** 默认 lookback 键 */
export const DEFAULT_LOOKBACK = "7d";

/** 合法状态值(query 解析白名单) */
const VALID_STATUSES = new Set<string>(["running", "success", "failed", "incomplete"]);

/** 指标窗口天数上限(防御 query 注入超大窗口) */
const MAX_METRICS_DAYS = 90;

/**
 * 解析列表查询参数(API 与 SSR 列表页共用,保证 URL query 即状态的一致语义)
 *
 * @param query 原始 query 对象
 * @param nowMs 当前时刻
 * @param staleRunningMinutes stale 阈值(分钟)
 * @returns listTraces 过滤条件 + 归一化的当前页码与 lookback 键
 */
export function parseTraceListQuery(
	query: Record<string, string | undefined>,
	nowMs: number,
	staleRunningMinutes: number,
): {
	filter: Parameters<ObserverDb["listTraces"]>[0];
	page: number;
	lookback: string;
} {
	const lookback =
		query.lookback !== undefined && LOOKBACK_MS[query.lookback] !== undefined ? query.lookback : DEFAULT_LOOKBACK;
	const statuses = (query.status ?? "").split(",").filter((status) => VALID_STATUSES.has(status)) as TraceStatus[];
	const parsedPage = Number.parseInt(query.page ?? "1", 10);
	const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
	return {
		filter: {
			product: query.product,
			project: query.project,
			mrIid: query.mr,
			statuses: statuses.length > 0 ? statuses : undefined,
			sinceMs: nowMs - (LOOKBACK_MS[lookback] ?? LOOKBACK_MS[DEFAULT_LOOKBACK] ?? 0),
			staleCutoffMs: nowMs - staleRunningMinutes * 60_000,
			limit: PAGE_SIZE,
			offset: (page - 1) * PAGE_SIZE,
		},
		page,
		lookback,
	};
}

/**
 * 创建查询 API 路由
 *
 * @param db 观测库 DAO
 * @param config 运行配置(取 staleRunningMinutes)
 * @returns 可被主 app route 挂载的 Hono 子应用
 */
export function createApiRoutes(db: ObserverDb, config: ObserverConfig): Hono {
	const api = new Hono();

	api.get("/api/traces", (c) => {
		const nowMs = Date.now();
		const { filter, page } = parseTraceListQuery(c.req.query(), nowMs, config.staleRunningMinutes);
		const { rows, total } = db.listTraces(filter);
		return c.json({
			rows: rows.map((row) => ({
				...row,
				display_status: displayStatus(row, nowMs, config.staleRunningMinutes),
			})),
			total,
			page,
			pageSize: PAGE_SIZE,
		});
	});

	api.get("/api/traces/:id", (c) => {
		const traceId = c.req.param("id");
		const trace = db.getTrace(traceId);
		if (trace === undefined) {
			return c.json({ error: "not_found" }, 404);
		}
		// payload 服务端 parse 后返回事件对象数组(回放顺序);坏 payload 理论不可达,防御跳过
		const events: unknown[] = [];
		for (const row of db.listEventsByTrace(traceId)) {
			try {
				events.push(JSON.parse(row.payload));
			} catch {
				// 入库前已过校验,防御跳过
			}
		}
		return c.json({
			trace: { ...trace, display_status: displayStatus(trace, Date.now(), config.staleRunningMinutes) },
			events,
		});
	});

	api.get("/api/products", (c) => c.json({ products: db.listProducts() }));

	api.get("/api/metrics", (c) => {
		const query = c.req.query();
		const parsedDays = Number.parseInt(query.days ?? "7", 10);
		const days = Number.isFinite(parsedDays) && parsedDays >= 1 ? Math.min(parsedDays, MAX_METRICS_DAYS) : 7;
		const nowMs = Date.now();
		const sinceMs = nowMs - days * 24 * 60 * 60 * 1000;
		const rows = db.listTracesSince(sinceMs, query.product);
		return c.json(aggregateMetrics(rows, { sinceMs, nowMs, staleRunningMinutes: config.staleRunningMinutes }));
	});

	return api;
}
