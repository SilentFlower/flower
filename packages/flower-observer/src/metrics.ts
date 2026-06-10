/**
 * 指标聚合纯函数:输入近 N 天 traces 行,输出指标页全量数据
 *
 * 设计:聚合全部在内存完成(量级依据 research——每天几十~几百次评审,
 * 30 天上限万级 traces 行),避免 SQLite percentile/直方图的 SQL 技巧,纯函数便于单测;
 * 「天」按进程本地时区分界(容器需设 TZ,见 README)。
 */

import type { TraceRow } from "./db.js";
import { displayStatus } from "./trace-status.js";

/**
 * 卡片区数字(无数据的比值/分位字段为 null,UI 显示 n/a)
 */
export interface MetricsCards {
	/** 范围内评审总次数 */
	total: number;
	/** 成功率(success / 已结束次数;展示语义,stale-running 计入已结束) */
	successRate: number | null;
	/** 时长 P50(毫秒) */
	p50DurationMs: number | null;
	/** 时长 P95(毫秒) */
	p95DurationMs: number | null;
	/** 平均每次评审评论数 */
	avgComments: number | null;
	/** 拦截总数 */
	blockTotal: number;
}

/**
 * 按天次数序列(product 分组;板块过滤时只有一组)
 */
export interface DailySeries {
	/** 连续日期轴(YYYY-MM-DD,缺数据天补零) */
	dates: string[];
	/** 序列名(product,字典序) */
	products: string[];
	/** counts[productIdx][dateIdx] */
	counts: number[][];
}

/**
 * 时长分布直方桶
 */
export interface HistogramBucket {
	/** 桶标签(如 "1–2m") */
	label: string;
	/** 桶内次数 */
	count: number;
}

/**
 * 指标页响应载荷
 */
export interface MetricsPayload {
	cards: MetricsCards;
	daily: DailySeries;
	histogram: HistogramBucket[];
	/** 最慢 Top10(已结束、按 duration_ms 降序) */
	slowest: TraceRow[];
}

/**
 * 聚合选项(时间参数全部注入,保持纯函数)
 */
export interface AggregateOptions {
	/** 统计窗口起点(Unix 毫秒;日期轴从这天开始补零) */
	sinceMs: number;
	/** 当前时刻(Unix 毫秒) */
	nowMs: number;
	/** stale-running 展示阈值(分钟) */
	staleRunningMinutes: number;
}

/** 时长直方桶边界(评审时长以分钟级为主,对数式分桶) */
const DURATION_BUCKETS: Array<{ label: string; maxMs: number }> = [
	{ label: "<30s", maxMs: 30_000 },
	{ label: "30s–1m", maxMs: 60_000 },
	{ label: "1–2m", maxMs: 120_000 },
	{ label: "2–5m", maxMs: 300_000 },
	{ label: "5–10m", maxMs: 600_000 },
	{ label: "≥10m", maxMs: Number.POSITIVE_INFINITY },
];

/** 最慢榜长度 */
const SLOWEST_LIMIT = 10;

/**
 * 聚合指标页数据
 *
 * @param rows 窗口内 traces 行(db.listTracesSince 结果)
 * @param options 时间注入参数
 * @returns 指标页全量载荷
 */
export function aggregateMetrics(rows: TraceRow[], options: AggregateOptions): MetricsPayload {
	return {
		cards: buildCards(rows, options),
		daily: buildDaily(rows, options),
		histogram: buildHistogram(rows),
		slowest: buildSlowest(rows),
	};
}

/**
 * 卡片区聚合
 */
function buildCards(rows: TraceRow[], options: AggregateOptions): MetricsCards {
	let success = 0;
	let ended = 0;
	let commentSum = 0;
	let blockTotal = 0;
	const durations: number[] = [];
	for (const row of rows) {
		const status = displayStatus(row, options.nowMs, options.staleRunningMinutes);
		if (status !== "running") {
			ended += 1;
			if (status === "success") success += 1;
		}
		commentSum += row.comment_count;
		blockTotal += row.block_count;
		if (row.duration_ms !== null) durations.push(row.duration_ms);
	}
	durations.sort((a, b) => a - b);
	return {
		total: rows.length,
		successRate: ended > 0 ? success / ended : null,
		p50DurationMs: percentile(durations, 50),
		p95DurationMs: percentile(durations, 95),
		avgComments: rows.length > 0 ? commentSum / rows.length : null,
		blockTotal,
	};
}

/**
 * 按天 × product 次数矩阵(日期轴连续补零,uPlot 直接消费)
 */
function buildDaily(rows: TraceRow[], options: AggregateOptions): DailySeries {
	const dates: string[] = [];
	const dateIndex = new Map<string, number>();
	// 从窗口起点逐天铺满到今天(本地时区天界)
	for (let ts = options.sinceMs; ts <= options.nowMs; ts += 24 * 60 * 60 * 1000) {
		const key = dayKey(ts);
		if (!dateIndex.has(key)) {
			dateIndex.set(key, dates.length);
			dates.push(key);
		}
	}
	// 跨天边界兜底:确保「今天」一定在轴上
	const todayKey = dayKey(options.nowMs);
	if (!dateIndex.has(todayKey)) {
		dateIndex.set(todayKey, dates.length);
		dates.push(todayKey);
	}

	const products = [...new Set(rows.map((row) => row.product))].sort();
	const productIndex = new Map(products.map((product, index) => [product, index]));
	const counts = products.map(() => dates.map(() => 0));
	for (const row of rows) {
		const dateIdx = dateIndex.get(dayKey(row.started_at ?? row.last_event_at));
		const productIdx = productIndex.get(row.product);
		if (dateIdx !== undefined && productIdx !== undefined) {
			const series = counts[productIdx];
			if (series !== undefined) series[dateIdx] = (series[dateIdx] ?? 0) + 1;
		}
	}
	return { dates, products, counts };
}

/**
 * 时长分布直方图(无时长的行不计)
 */
function buildHistogram(rows: TraceRow[]): HistogramBucket[] {
	const buckets = DURATION_BUCKETS.map((bucket) => ({ label: bucket.label, count: 0 }));
	for (const row of rows) {
		if (row.duration_ms === null) continue;
		const index = DURATION_BUCKETS.findIndex((bucket) => row.duration_ms !== null && row.duration_ms < bucket.maxMs);
		const bucket = buckets[index];
		if (bucket !== undefined) bucket.count += 1;
	}
	return buckets;
}

/**
 * 最慢 Top10(已结束、按 duration_ms 降序)
 */
function buildSlowest(rows: TraceRow[]): TraceRow[] {
	return rows
		.filter((row) => row.duration_ms !== null)
		.sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
		.slice(0, SLOWEST_LIMIT);
}

/**
 * 本地时区日期键(YYYY-MM-DD)
 *
 * @param ts Unix 毫秒
 * @returns 日期字符串
 */
function dayKey(ts: number): string {
	const date = new Date(ts);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 最近排名法分位数(输入需已升序)
 *
 * @param sorted 升序数组
 * @param p 分位(0-100)
 * @returns 分位值;空数组返回 null
 */
function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.ceil((p / 100) * sorted.length);
	const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[index] ?? null;
}
