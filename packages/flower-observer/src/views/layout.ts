/**
 * 页面骨架与公共渲染 helpers(SSR 模板字符串,无前端构建链)
 *
 * 安全:所有外部来源文本(project / 评论标题 / 工具入参 / payload…)必须经 escapeHtml,
 * 事件内容虽已脱敏但仍是不可信输入,防存储型 XSS。
 */

import { createHash } from "node:crypto";
import type { TraceRow, TraceStatus } from "../db.js";

/**
 * HTML 转义(模板渲染唯一出口)
 *
 * @param value 任意文本
 * @returns 转义后文本
 */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * 人性化时长(列表/详情/指标共用)
 *
 * @param ms 毫秒
 * @returns 如 "850ms" / "12.3s" / "1m 23s"
 */
export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return "n/a";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	return `${minutes}m ${seconds}s`;
}

/**
 * 绝对时间(本地时区,悬停提示用)
 *
 * @param ts Unix 毫秒
 * @returns "YYYY-MM-DD HH:mm:ss"
 */
export function formatTs(ts: number | null | undefined): string {
	if (ts === null || ts === undefined) return "n/a";
	const date = new Date(ts);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 中文相对时间(列表「时间」列)
 *
 * @param ts Unix 毫秒
 * @param nowMs 当前时刻
 * @returns 如 "刚刚" / "5 分钟前" / "3 小时前" / "2 天前"
 */
export function formatRelative(ts: number | null | undefined, nowMs: number): string {
	if (ts === null || ts === undefined) return "n/a";
	const diff = Math.max(0, nowMs - ts);
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 四态徽章文案与样式类 */
const STATUS_META: Record<TraceStatus, { label: string; icon: string }> = {
	running: { label: "进行中", icon: "●" },
	success: { label: "成功", icon: "✓" },
	failed: { label: "失败", icon: "✗" },
	incomplete: { label: "半截", icon: "⚠" },
};

/**
 * 四态状态徽章
 *
 * @param status 展示状态(已含 stale 推导)
 * @returns 徽章 HTML
 */
export function statusBadge(status: TraceStatus): string {
	const meta = STATUS_META[status];
	return `<span class="badge badge-${status}">${meta.icon} ${meta.label}</span>`;
}

/**
 * product 徽章(配色按名称哈希,跨页面稳定)
 *
 * @param product 产品名
 * @returns 徽章 HTML
 */
export function productBadge(product: string): string {
	return `<span class="product-badge" style="background:${productColor(product)}">${escapeHtml(product)}</span>`;
}

/**
 * 产品名 → 稳定 HSL 色(板块辨识)
 *
 * @param product 产品名
 * @returns CSS 颜色
 */
export function productColor(product: string): string {
	let hash = 0;
	for (const ch of product) {
		hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) | 0;
	}
	return `hsl(${Math.abs(hash) % 360} 55% 42%)`;
}

/**
 * GitLab 外链集合(Jaeger linkPatterns 思想:correlation → 深链)
 */
export interface GitlabLinks {
	mr?: string;
	commit?: string;
	pipeline?: string;
}

/**
 * 由 correlation 拼 GitLab 外链(未配置 base / 字段为 "unknown" 时对应链接缺省)
 *
 * @param baseUrl OBSERVER_GITLAB_BASE_URL(空 = 全部缺省)
 * @param row trace 行(取 project / mr_iid / commit_sha / pipeline_id)
 * @returns 可用链接集合
 */
export function buildGitlabLinks(
	baseUrl: string,
	row: Pick<TraceRow, "project" | "mr_iid" | "commit_sha" | "pipeline_id">,
): GitlabLinks {
	if (baseUrl === "" || row.project === null || row.project === "unknown") return {};
	const projectUrl = `${baseUrl}/${row.project}`;
	const links: GitlabLinks = {};
	if (row.mr_iid !== null && row.mr_iid !== "unknown")
		links.mr = `${projectUrl}/-/merge_requests/${encodeURIComponent(row.mr_iid)}`;
	if (row.commit_sha !== null && row.commit_sha !== "unknown")
		links.commit = `${projectUrl}/-/commit/${encodeURIComponent(row.commit_sha)}`;
	if (row.pipeline_id !== null && row.pipeline_id !== "unknown")
		links.pipeline = `${projectUrl}/-/pipelines/${encodeURIComponent(row.pipeline_id)}`;
	return links;
}

/**
 * MR diff 行锚点(GitLab 锚点格式:#<sha1(file)>_<old>_<new>;
 * 评论落在新行,old/new 同填行号——锚点不中时 GitLab 安全降级为打开 diffs 页)
 *
 * @param mrUrl MR 页 URL
 * @param file 文件路径
 * @param line 新行号
 * @returns diff 行锚点 URL
 */
export function buildMrDiffLineAnchor(mrUrl: string, file: string, line: number): string {
	const fileHash = createHash("sha1").update(file).digest("hex");
	return `${mrUrl}/diffs#${fileHash}_${line}_${line}`;
}

/**
 * 布局选项
 */
export interface LayoutOptions {
	/** 页面标题(<title> 前缀) */
	title: string;
	/** 当前导航高亮 */
	activeNav: "traces" | "metrics";
	/** 板块下拉选项(动态发现) */
	products: string[];
	/** 当前板块("" = 全部) */
	currentProduct: string;
	/** 当前 lookback 键(顶栏时间范围;undefined = 不渲染该下拉) */
	currentLookback?: string;
	/** running 详情页自动刷新间隔(毫秒;undefined = 不刷新) */
	autoRefreshMs?: number;
	/** 页面主体 HTML */
	body: string;
	/** 额外注入 head 的标签(指标页引 uPlot) */
	extraHead?: string;
}

/** lookback 下拉的选项与中文标签(顺序即展示顺序) */
const LOOKBACK_LABELS: Array<[string, string]> = [
	["1h", "近 1 小时"],
	["24h", "近 24 小时"],
	["7d", "近 7 天"],
	["30d", "近 30 天"],
];

/**
 * 渲染整页 HTML(顶栏 + 主体)
 *
 * 顶栏下拉经 app.js 的 data-nav-param 委托:改 URL query 后整页跳转(URL 即状态)。
 *
 * @param options 布局选项
 * @returns 完整 HTML 文档
 */
export function renderLayout(options: LayoutOptions): string {
	const productOptions = [
		`<option value=""${options.currentProduct === "" ? " selected" : ""}>全部产品</option>`,
		...options.products.map(
			(product) =>
				`<option value="${escapeHtml(product)}"${product === options.currentProduct ? " selected" : ""}>${escapeHtml(product)}</option>`,
		),
	].join("");

	const lookbackSelect =
		options.currentLookback !== undefined
			? `<select class="nav-select" data-nav-param="lookback" title="时间范围">${LOOKBACK_LABELS.map(
					([key, label]) => `<option value="${key}"${key === options.currentLookback ? " selected" : ""}>${label}</option>`,
				).join("")}</select>`
			: "";

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><text y=%2214%22>🌸</text></svg>">
<title>${escapeHtml(options.title)} · flower-observer</title>
<link rel="stylesheet" href="/static/app.css">
${options.extraHead ?? ""}
</head>
<body${options.autoRefreshMs !== undefined ? ` data-refresh-ms="${options.autoRefreshMs}"` : ""}>
<header class="topbar">
	<span class="brand">🌸 flower-observer</span>
	<nav class="nav">
		<a href="/traces"${options.activeNav === "traces" ? ' class="active"' : ""}>评审</a>
		<a href="/metrics"${options.activeNav === "metrics" ? ' class="active"' : ""}>概览</a>
	</nav>
	<span class="topbar-spacer"></span>
	<select class="nav-select" data-nav-param="product" title="产品板块">${productOptions}</select>
	${lookbackSelect}
</header>
<main class="page">
${options.body}
</main>
<script src="/static/app.js" defer></script>
</body>
</html>`;
}
