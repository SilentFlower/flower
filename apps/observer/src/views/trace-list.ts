/**
 * 列表页(/traces):统计条 + 过滤表单 + trace 表格 + 分页
 *
 * 信息架构来源 research/ui-patterns.md §四 页面 1:
 * 过滤态全部进 URL query(可分享可书签);行点击整页跳详情;
 * 「进行中」状态是 httpSink 实时推送的核心红利。
 */

import type { TraceRow, TraceStatus } from "../db.js";
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
 * 列表页视图模型(pages.ts 组装)
 */
export interface TraceListViewModel {
	/** 当前页行(display 为查询期推导后的展示状态) */
	rows: Array<{ row: TraceRow; display: TraceStatus }>;
	/** 满足过滤条件总数 */
	total: number;
	/** 当前页码(1 起) */
	page: number;
	/** 分页大小 */
	pageSize: number;
	/** 项目下拉选项(按当前板块 distinct) */
	projects: string[];
	/** 当前过滤态(回填表单;product/lookback 由顶栏管理) */
	query: { product: string; project: string; mr: string; statuses: TraceStatus[]; lookback: string };
	/** 统计条:今日评审数 / 今日失败数 / 今日平均时长 */
	today: { count: number; failed: number; avgDurationMs: number | null };
	/** GitLab 根 URL(空 = 不渲染外链) */
	gitlabBaseUrl: string;
	/** 当前时刻(相对时间渲染) */
	nowMs: number;
}

/** 状态多选框顺序与中文标签 */
const STATUS_OPTIONS: Array<[TraceStatus, string]> = [
	["running", "进行中"],
	["success", "成功"],
	["failed", "失败"],
	["incomplete", "半截"],
];

/**
 * 渲染列表页主体
 *
 * @param vm 视图模型
 * @returns 主体 HTML(嵌入 layout)
 */
export function renderTraceListPage(vm: TraceListViewModel): string {
	return `
<section class="stats-bar">
	<span>今日评审 <strong>${vm.today.count}</strong></span>
	<span>失败 <strong class="${vm.today.failed > 0 ? "text-failed" : ""}">${vm.today.failed}</strong></span>
	<span>平均时长 <strong>${formatDuration(vm.today.avgDurationMs)}</strong></span>
</section>
${renderFilterForm(vm)}
${renderTable(vm)}
${renderPagination(vm)}`;
}

/**
 * 过滤表单(GET 提交,URL query 即状态;product/lookback 以 hidden 保留顶栏选择)
 */
function renderFilterForm(vm: TraceListViewModel): string {
	const projectOptions = [
		`<option value=""${vm.query.project === "" ? " selected" : ""}>全部项目</option>`,
		...vm.projects.map(
			(project) =>
				`<option value="${escapeHtml(project)}"${project === vm.query.project ? " selected" : ""}>${escapeHtml(project)}</option>`,
		),
	].join("");
	const statusBoxes = STATUS_OPTIONS.map(
		([status, label]) =>
			`<label class="check"><input type="checkbox" name="status" value="${status}"${vm.query.statuses.includes(status) ? " checked" : ""}> ${label}</label>`,
	).join("");
	const resetHref = `/traces?${new URLSearchParams({
		...(vm.query.product !== "" ? { product: vm.query.product } : {}),
		lookback: vm.query.lookback,
	}).toString()}`;

	return `
<form class="filter-form" method="get" action="/traces" data-multi-join="status">
	${vm.query.product !== "" ? `<input type="hidden" name="product" value="${escapeHtml(vm.query.product)}">` : ""}
	<input type="hidden" name="lookback" value="${escapeHtml(vm.query.lookback)}">
	<select name="project">${projectOptions}</select>
	<input type="text" name="mr" placeholder="MR IID" value="${escapeHtml(vm.query.mr)}" size="8">
	${statusBoxes}
	<button type="submit">过滤</button>
	<a class="reset" href="${resetHref}">重置</a>
</form>`;
}

/**
 * trace 表格(列定义见 ui-patterns §四 页面 1)
 */
function renderTable(vm: TraceListViewModel): string {
	if (vm.rows.length === 0) {
		return '<p class="empty">当前条件下暂无评审记录</p>';
	}
	const rows = vm.rows.map(({ row, display }) => renderRow(row, display, vm)).join("\n");
	return `
<table class="trace-table">
<thead><tr>
	<th>状态</th><th>时间</th><th>项目</th><th>MR</th><th>Commit · Pipeline</th>
	<th>Product</th><th>时长</th><th>轮 · 工具</th><th>评论</th><th>拦截</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

/**
 * 单行渲染(整行可点跳详情;外链单独可点)
 */
function renderRow(row: TraceRow, display: TraceStatus, vm: TraceListViewModel): string {
	const links = buildGitlabLinks(vm.gitlabBaseUrl, row);
	const startTs = row.started_at ?? row.last_event_at;
	const mrText =
		row.mr_iid !== null && row.mr_iid !== "unknown" ? `!${escapeHtml(row.mr_iid)}` : '<span class="muted">—</span>';
	const mrCell = links.mr !== undefined ? `<a href="${links.mr}" target="_blank" rel="noopener">${mrText}</a>` : mrText;
	const commitText =
		row.commit_sha !== null && row.commit_sha !== "unknown"
			? `<span class="mono">${escapeHtml(row.commit_sha.slice(0, 8))}</span>`
			: "";
	const commitCell =
		links.commit !== undefined
			? `<a href="${links.commit}" target="_blank" rel="noopener">${commitText}</a>`
			: commitText;
	const pipelineText =
		row.pipeline_id !== null && row.pipeline_id !== "unknown" ? `#${escapeHtml(row.pipeline_id)}` : "";
	const pipelineCell =
		links.pipeline !== undefined
			? `<a href="${links.pipeline}" target="_blank" rel="noopener">${pipelineText}</a>`
			: pipelineText;
	const turnsTools =
		row.turns !== null || row.tool_calls !== null
			? `${row.turns ?? "?"} turns · ${row.tool_calls ?? "?"} tools`
			: '<span class="muted">—</span>';
	const commentCell =
		row.comment_count > 0
			? `${row.comment_count}${row.blocker_count > 0 ? ` <span class="badge badge-failed" title="blocker 级评论">${row.blocker_count}</span>` : ""}`
			: '<span class="muted">0</span>';
	const blockCell =
		row.block_count > 0 ? `<span class="badge badge-failed">🛡 ${row.block_count}</span>` : '<span class="muted">0</span>';

	return `<tr data-href="/traces/${encodeURIComponent(row.trace_id)}">
	<td>${statusBadge(display)}</td>
	<td title="${formatTs(startTs)}">${formatRelative(startTs, vm.nowMs)}</td>
	<td>${row.project !== null && row.project !== "unknown" ? escapeHtml(row.project) : '<span class="muted">unknown</span>'}</td>
	<td>${mrCell}</td>
	<td>${commitCell}${commitText !== "" && pipelineText !== "" ? " · " : ""}${pipelineCell}</td>
	<td>${productBadge(row.product)}</td>
	<td>${formatDuration(row.duration_ms)}</td>
	<td>${turnsTools}</td>
	<td>${commentCell}</td>
	<td>${blockCell}</td>
</tr>`;
}

/**
 * 分页条(沿用当前 query,仅替换 page)
 */
function renderPagination(vm: TraceListViewModel): string {
	const totalPages = Math.max(1, Math.ceil(vm.total / vm.pageSize));
	if (totalPages <= 1) {
		return `<footer class="pagination"><span>共 ${vm.total} 条</span></footer>`;
	}
	const pageHref = (page: number): string => {
		const params = new URLSearchParams();
		if (vm.query.product !== "") params.set("product", vm.query.product);
		params.set("lookback", vm.query.lookback);
		if (vm.query.project !== "") params.set("project", vm.query.project);
		if (vm.query.mr !== "") params.set("mr", vm.query.mr);
		if (vm.query.statuses.length > 0) params.set("status", vm.query.statuses.join(","));
		params.set("page", String(page));
		return `/traces?${params.toString()}`;
	};
	return `
<footer class="pagination">
	${vm.page > 1 ? `<a href="${pageHref(vm.page - 1)}">← 上一页</a>` : "<span class='muted'>← 上一页</span>"}
	<span>共 ${vm.total} 条 · 第 ${vm.page}/${totalPages} 页</span>
	${vm.page < totalPages ? `<a href="${pageHref(vm.page + 1)}">下一页 →</a>` : "<span class='muted'>下一页 →</span>"}
</footer>`;
}
