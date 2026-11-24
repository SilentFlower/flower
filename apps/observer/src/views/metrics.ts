/**
 * 指标页(/metrics):卡片行 + 按天次数图(uPlot)+ 时长分布直方 + 最慢 Top10
 *
 * 图表策略(research/tech-stack.md 维度 3):uPlot vendor 单文件(内网离线可用)只用于
 * 按天时间序列;时长分布仅 6 个桶,SSR 纯 CSS 柱即可,不动用图表库。
 * 按天数据经 <script type="application/json"> 内嵌,app.js 检测后渲染。
 */

import type { TraceRow, TraceStatus } from "../db.js";
import type { MetricsPayload } from "../metrics.js";
import {
	buildGitlabLinks,
	escapeHtml,
	formatDuration,
	formatRelative,
	formatTs,
	productBadge,
	statusBadge,
} from "./layout.js";

/**
 * 指标页视图模型(pages.ts 组装)
 */
export interface MetricsViewModel {
	/** 聚合结果 */
	payload: MetricsPayload;
	/** 统计窗口天数(卡片标题用) */
	days: number;
	/** Top10 行的展示状态(与 payload.slowest 对位) */
	slowestDisplay: TraceStatus[];
	/** GitLab 根 URL */
	gitlabBaseUrl: string;
	/** 当前时刻(相对时间渲染) */
	nowMs: number;
}

/**
 * 渲染指标页主体
 *
 * @param vm 视图模型
 * @returns 主体 HTML(嵌入 layout)
 */
export function renderMetricsPage(vm: MetricsViewModel): string {
	const { cards } = vm.payload;
	return `
<section class="cards">
	${renderCard(`近 ${vm.days} 天评审`, String(cards.total))}
	${renderCard("成功率", cards.successRate !== null ? `${(cards.successRate * 100).toFixed(1)}%` : "n/a")}
	${renderCard("P50 时长", formatDuration(cards.p50DurationMs))}
	${renderCard("P95 时长", formatDuration(cards.p95DurationMs))}
	${renderCard("平均评论 / 次", cards.avgComments !== null ? cards.avgComments.toFixed(1) : "n/a")}
	${renderCard("拦截总数", String(cards.blockTotal), cards.blockTotal > 0 ? "text-failed" : "")}
</section>
${renderDailyChart(vm)}
${renderHistogram(vm)}
${renderSlowestTable(vm)}`;
}

/**
 * 单张数字卡片
 */
function renderCard(label: string, value: string, valueClass = ""): string {
	return `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value ${valueClass}">${escapeHtml(value)}</div></div>`;
}

/**
 * 按天次数图(uPlot 时间序列,product 分组;数据内嵌 JSON 由 app.js 渲染)
 */
function renderDailyChart(vm: MetricsViewModel): string {
	const { daily } = vm.payload;
	const hasData = daily.counts.some((series) => series.some((count) => count > 0));
	return `
<section class="chart-block">
	<h2>按天评审次数</h2>
	${
		hasData
			? `<div id="daily-chart"></div>
<script type="application/json" id="daily-chart-data">${JSON.stringify(daily).replaceAll("<", "\\u003c")}</script>`
			: '<p class="empty">窗口内暂无数据</p>'
	}
</section>`;
}

/**
 * 时长分布直方(SSR 纯 CSS 柱)
 */
function renderHistogram(vm: MetricsViewModel): string {
	const buckets = vm.payload.histogram;
	const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
	const cols = buckets
		.map(
			(bucket) => `
	<div class="h-col">
		<span class="h-count">${bucket.count > 0 ? bucket.count : ""}</span>
		<span class="h-bar" style="height:${((bucket.count / max) * 100).toFixed(1)}%"></span>
		<span class="h-label">${escapeHtml(bucket.label)}</span>
	</div>`,
		)
		.join("");
	return `
<section class="chart-block">
	<h2>时长分布</h2>
	<div class="histogram">${cols}</div>
</section>`;
}

/**
 * 最慢 Top10 表(链接详情页,定位「慢在哪」的入口)
 */
function renderSlowestTable(vm: MetricsViewModel): string {
	if (vm.payload.slowest.length === 0) {
		return '<section class="chart-block"><h2>最慢 Top 10</h2><p class="empty">窗口内暂无已结束评审</p></section>';
	}
	const rows = vm.payload.slowest
		.map((row, index) => renderSlowestRow(row, index + 1, vm.slowestDisplay[index], vm))
		.join("\n");
	return `
<section class="chart-block">
	<h2>最慢 Top 10</h2>
	<table class="trace-table">
	<thead><tr><th>#</th><th>状态</th><th>时间</th><th>项目</th><th>MR</th><th>Product</th><th>时长</th><th>轮 · 工具</th></tr></thead>
	<tbody>
${rows}
	</tbody>
	</table>
</section>`;
}

/**
 * Top10 单行
 */
function renderSlowestRow(row: TraceRow, rank: number, display: TraceStatus | undefined, vm: MetricsViewModel): string {
	const links = buildGitlabLinks(vm.gitlabBaseUrl, row);
	const startTs = row.started_at ?? row.last_event_at;
	const mrText =
		row.mr_iid !== null && row.mr_iid !== "unknown" ? `!${escapeHtml(row.mr_iid)}` : '<span class="muted">—</span>';
	const mrCell = links.mr !== undefined ? `<a href="${links.mr}" target="_blank" rel="noopener">${mrText}</a>` : mrText;
	return `<tr data-href="/traces/${encodeURIComponent(row.trace_id)}">
	<td>${rank}</td>
	<td>${display !== undefined ? statusBadge(display) : ""}</td>
	<td title="${formatTs(startTs)}">${formatRelative(startTs, vm.nowMs)}</td>
	<td>${row.project !== null && row.project !== "unknown" ? escapeHtml(row.project) : '<span class="muted">unknown</span>'}</td>
	<td>${mrCell}</td>
	<td>${productBadge(row.product)}</td>
	<td>${formatDuration(row.duration_ms)}</td>
	<td>${row.turns ?? "?"} turns · ${row.tool_calls ?? "?"} tools</td>
</tr>`;
}
