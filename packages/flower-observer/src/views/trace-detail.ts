/**
 * 详情页(/traces/:id):行为回放
 *
 * 信息架构来源 research/ui-patterns.md §四 页面 2。
 * 明示边界:这是**行为回放**而非对话回放——stream 事件不入库,无 assistant 正文/thinking;
 * 回放单位是「每轮调了什么工具(脱敏 input)→ 得到什么结果 → 发了什么评论」。
 */

import type { OutcomeEvent, SpanEvent, TurnTiming } from "@flower-ai/flower-telemetry";
import type { TraceRow, TraceStatus } from "../db.js";
import {
	buildGitlabLinks,
	buildMrDiffLineAnchor,
	escapeHtml,
	formatDuration,
	formatTs,
	productBadge,
	statusBadge,
} from "./layout.js";
import type { AttemptNode, FlowItem, TraceFlow, TurnNode } from "./tree.js";

/**
 * 详情页视图模型(pages.ts 组装)
 */
export interface TraceDetailViewModel {
	/** trace 物化行 */
	trace: TraceRow;
	/** 展示状态(已含 stale 推导) */
	display: TraceStatus;
	/** 重建后的执行流 */
	flow: TraceFlow;
	/** GitLab 根 URL */
	gitlabBaseUrl: string;
}

/** severity → 徽章样式类(对齐评审 severity 三档词表) */
const SEVERITY_CLASS: Record<string, string> = {
	blocker: "sev-blocker",
	major: "sev-major",
	minor: "sev-minor",
};

/**
 * 渲染详情页主体
 *
 * @param vm 视图模型
 * @returns 主体 HTML(嵌入 layout)
 */
export function renderTraceDetailPage(vm: TraceDetailViewModel): string {
	return `
${renderHeader(vm)}
<div class="tabs" role="tablist">
	<button class="tab active" data-tab="flow">执行流</button>
	<button class="tab" data-tab="outputs">产出</button>
</div>
<section class="tab-panel" data-panel="flow">
	${renderFlowPanel(vm)}
</section>
<section class="tab-panel hidden" data-panel="outputs">
	${renderOutputsPanel(vm)}
</section>`;
}

/**
 * 区块 A:头部摘要(标题外链 + 指标条 + 缺口黄条 + 回放边界说明)
 */
function renderHeader(vm: TraceDetailViewModel): string {
	const { trace, flow } = vm;
	const links = buildGitlabLinks(vm.gitlabBaseUrl, trace);
	const titleText = `${trace.project !== null && trace.project !== "unknown" ? escapeHtml(trace.project) : "unknown"}${
		trace.mr_iid !== null && trace.mr_iid !== "unknown" ? ` !${escapeHtml(trace.mr_iid)}` : ""
	}`;
	const title =
		links.mr !== undefined ? `<a href="${links.mr}" target="_blank" rel="noopener">${titleText}</a>` : titleText;
	const commitLink =
		trace.commit_sha !== null && trace.commit_sha !== "unknown"
			? links.commit !== undefined
				? `<a class="mono" href="${links.commit}" target="_blank" rel="noopener">${escapeHtml(trace.commit_sha.slice(0, 8))}</a>`
				: `<span class="mono">${escapeHtml(trace.commit_sha.slice(0, 8))}</span>`
			: "";
	const pipelineLink =
		trace.pipeline_id !== null && trace.pipeline_id !== "unknown"
			? links.pipeline !== undefined
				? `<a href="${links.pipeline}" target="_blank" rel="noopener">pipeline #${escapeHtml(trace.pipeline_id)}</a>`
				: `pipeline #${escapeHtml(trace.pipeline_id)}`
			: "";

	const severityCounts = countBySeverity(flow.comments);
	const commentMetric = (["blocker", "major", "minor"] as const)
		.filter((severity) => (severityCounts[severity] ?? 0) > 0)
		.map((severity) => `<span class="${SEVERITY_CLASS[severity]}">${severity} ${severityCounts[severity]}</span>`)
		.join(" ");

	const gapBanner =
		flow.gaps.length > 0
			? `<div class="gap-banner">⚠ seq 缺口 ${flow.gaps
					.map((gap) => (gap.from === gap.to ? `${gap.from}` : `${gap.from}–${gap.to}`))
					.join(", ")},事件可能丢失</div>`
			: "";

	return `
<header class="detail-header">
	<div class="detail-title">
		${statusBadge(vm.display)}
		<h1>${title}</h1>
		${commitLink}
		${pipelineLink}
		${productBadge(trace.product)}
		${flow.start !== undefined ? `<span class="muted">reason: ${escapeHtml(flow.start.reason)}</span>` : ""}
	</div>
	<div class="metric-strip">
		<span>开始 <strong title="${formatTs(trace.started_at)}">${formatTs(trace.started_at)}</strong></span>
		<span>总时长 <strong>${formatDuration(trace.duration_ms)}</strong></span>
		<span>turns <strong>${trace.turns ?? "n/a"}</strong></span>
		<span>tools <strong>${trace.tool_calls ?? "n/a"}</strong></span>
		<span>attempts <strong>${flow.attempts.length}</strong></span>
		<span>评论 <strong>${trace.comment_count}</strong> ${commentMetric}</span>
		<span>拦截 <strong class="${trace.block_count > 0 ? "text-failed" : ""}">${trace.block_count}</strong></span>
		<span>exitCode <strong>${trace.exit_code ?? "n/a"}</strong></span>
		${trace.skill_used !== null ? `<span>skill <strong>${escapeHtml(trace.skill_used)}</strong></span>` : ""}
	</div>
	${gapBanner}
	<p class="muted replay-note">行为回放:stream 事件不入库,无 assistant 正文 / thinking;input/result 已脱敏,单字段 ≤4000 字符。</p>
</header>`;
}

/**
 * 执行流面板:树状 ↔ 平铺切换(同一数据两种排序/缩进,SSR 双容器,JS 只切 display)
 *
 * 锚点 id 只在树状容器输出(避免双容器重复 id;拦截表跳转前 JS 会强制切树状视图)。
 */
function renderFlowPanel(vm: TraceDetailViewModel): string {
	const totalMs = vm.trace.duration_ms;
	const tree = vm.flow.attempts.map((attempt) => renderAttempt(attempt, totalMs, vm)).join("\n");
	const flat = vm.flow.flat.map((item) => renderItem(item, vm, false)).join("\n");
	return `
<div class="view-toggle">
	<button class="active" data-view-toggle="tree">树状</button>
	<button data-view-toggle="flat">按 seq 平铺</button>
</div>
<div class="flow-view" data-view="tree">
${tree !== "" ? tree : '<p class="empty">暂无执行事件</p>'}
</div>
<div class="flow-view hidden" data-view="flat">
${flat !== "" ? flat : '<p class="empty">暂无执行事件</p>'}
</div>`;
}

/**
 * attempt 节点(agent span:stopReason / usage / errorMessage)
 */
function renderAttempt(node: AttemptNode, totalMs: number | null, vm: TraceDetailViewModel): string {
	const agent = node.agent;
	const usage = agent?.agent?.usage;
	const headParts = [
		`<strong>attempt ${node.attempt ?? "?"}</strong>`,
		node.open ? '<span class="badge badge-running">● 进行中</span>' : "",
		agent?.agent?.stopReason !== undefined
			? `<span class="muted">stop: ${escapeHtml(agent.agent.stopReason)}</span>`
			: "",
		usage !== undefined
			? `<span class="muted">usage ${usage.input ?? "?"}→${usage.output ?? "?"} (${usage.total ?? "?"})</span>`
			: "",
		agent?.durationMs !== undefined ? `<span class="muted">${formatDuration(agent.durationMs)}</span>` : "",
	]
		.filter((part) => part !== "")
		.join(" ");
	const error =
		agent?.agent?.errorMessage !== undefined
			? `<div class="item-error">✗ ${escapeHtml(agent.agent.errorMessage)}</div>`
			: "";
	return `
<section class="attempt-node">
	<div class="attempt-head">${headParts}</div>
	${error}
	${node.turns.map((turn) => renderTurn(turn, totalMs, vm)).join("\n")}
</section>`;
}

/**
 * turn 节点:耗时横条(相对 trace 总时长的简化瀑布)+ timing 分解展开表
 */
function renderTurn(node: TurnNode, totalMs: number | null, vm: TraceDetailViewModel): string {
	const duration = node.turn?.durationMs;
	const ratio =
		duration !== undefined && totalMs !== null && totalMs > 0
			? Math.min(100, Math.max(2, (duration / totalMs) * 100))
			: 0;
	const bar = ratio > 0 ? `<span class="turn-bar" style="width:${ratio.toFixed(1)}%"></span>` : "";
	const timing = node.turn?.timing !== undefined ? renderTimingDetails(node.turn.timing) : "";
	return `
<section class="turn-node">
	<div class="turn-head">
		<span><strong>turn ${node.turnIndex ?? "?"}</strong>${node.open ? ' <span class="badge badge-running">● 进行中</span>' : ""} <span class="muted">${formatDuration(duration)}</span></span>
		<span class="turn-track">${bar}</span>
	</div>
	${timing}
	<div class="turn-items">
		${node.items.map((item) => renderItem(item, vm, true)).join("\n")}
	</div>
</section>`;
}

/** TurnTiming 字段 → 中文标签(展示顺序;ms 类字段做时长格式化) */
const TIMING_FIELDS: Array<{ key: keyof TurnTiming; label: string; isMs: boolean }> = [
	{ key: "durationMs", label: "本轮总耗时", isMs: true },
	{ key: "providerRequestCount", label: "模型请求次数", isMs: false },
	{ key: "providerResponseCount", label: "模型响应次数", isMs: false },
	{ key: "providerLastStatus", label: "最近响应 HTTP 状态", isMs: false },
	{ key: "firstProviderRequestMs", label: "首次请求发出", isMs: true },
	{ key: "providerResponseHeadersMs", label: "请求 → 响应头", isMs: true },
	{ key: "providerPendingMs", label: "响应未决等待", isMs: true },
	{ key: "firstAgentMessageEventMs", label: "首个流式事件", isMs: true },
	{ key: "firstAgentMessageAfterProviderMs", label: "响应头 → 首个流式事件", isMs: true },
	{ key: "firstTextDeltaMs", label: "本轮首字", isMs: true },
	{ key: "firstTextDeltaAfterProviderMs", label: "响应头 → 首字", isMs: true },
	{ key: "firstToolCallReadyMs", label: "首个工具调用就绪", isMs: true },
	{ key: "toolCount", label: "工具调用次数", isMs: false },
	{ key: "toolTotalMs", label: "工具总耗时", isMs: true },
	{ key: "toolResultCount", label: "工具结果数", isMs: false },
];

/**
 * timing 分解展开表(定制亮点:业界单值 TTFT,这里每轮十余项分解,回答「卡在哪」)
 */
function renderTimingDetails(timing: TurnTiming): string {
	const rows = TIMING_FIELDS.map(({ key, label, isMs }) => {
		const value = timing[key];
		const text = value === undefined ? '<span class="muted">n/a</span>' : isMs ? formatDuration(value) : String(value);
		return `<tr><td>${label}</td><td>${text}</td></tr>`;
	}).join("");
	return `<details class="timing"><summary>timing 分解</summary><table class="timing-table">${rows}</table></details>`;
}

/**
 * 锚点属性(树状容器输出 id;平铺容器省略,避免重复 id)
 */
function anchorAttr(seq: number, anchored: boolean): string {
	return anchored ? ` id="seq-${seq}"` : "";
}

/**
 * 叶子项分发渲染(锚点 id=seq-N 供产出 tab 拦截表跳回)
 */
function renderItem(item: FlowItem, vm: TraceDetailViewModel, anchored: boolean): string {
	switch (item.type) {
		case "tool":
			return renderToolItem(item, anchored);
		case "llm_call":
			return renderLlmItem(item.event, anchored);
		case "comment":
			return renderCommentItem(item.event, vm, anchored);
		case "block":
			return `<div class="item-card item-blocked"${anchorAttr(item.seq, anchored)}>🛡 <strong>${escapeHtml(
				item.event.securityBlock?.tool ?? "unknown",
			)}</strong> 已拦截:${escapeHtml(item.event.securityBlock?.reason ?? "")}</div>`;
		default:
			return "";
	}
}

/**
 * tool 卡片:tool_call + tool_result 配对;拦截红条内联;input/result 折叠(pretty ↔ raw)
 */
function renderToolItem(item: Extract<FlowItem, { type: "tool" }>, anchored: boolean): string {
	const tool = item.call?.tool ?? item.result?.tool ?? "unknown";
	const isError = item.result?.isError === true;
	const headParts = [
		`🔧 <strong>${escapeHtml(tool)}</strong>`,
		item.call?.inputKeys !== undefined && item.call.inputKeys.length > 0
			? `<span class="muted">(${item.call.inputKeys.map((key) => escapeHtml(key)).join(", ")})</span>`
			: "",
		item.result?.durationMs !== undefined ? `<span class="muted">${formatDuration(item.result.durationMs)}</span>` : "",
		item.call === undefined ? '<span class="muted">⚠ 缺 tool_call(seq 缺口)</span>' : "",
		item.result === undefined && item.blocked === undefined ? '<span class="muted">…无结果</span>' : "",
		isError ? '<span class="text-failed">✗ 错误</span>' : "",
	]
		.filter((part) => part !== "")
		.join(" ");
	const blocked =
		item.blocked !== undefined
			? `<div class="item-error">🛡 已拦截(${escapeHtml(item.blocked.securityBlock?.mode ?? "")}):${escapeHtml(
					item.blocked.securityBlock?.reason ?? "",
				)}</div>`
			: "";
	return `
<div class="item-card${isError || item.blocked !== undefined ? " item-blocked" : ""}"${anchorAttr(item.seq, anchored)}>
	<div class="item-head">${headParts}</div>
	${blocked}
	${item.call?.input !== undefined ? renderIoDetails("input", item.call.input) : ""}
	${item.result?.result !== undefined ? renderIoDetails("result", item.result.result) : ""}
</div>`;
}

/**
 * llm_call 行:#request · HTTP status · 耗时(非 2xx 标红)
 */
function renderLlmItem(event: SpanEvent, anchored: boolean): string {
	const ok = event.status !== undefined && event.status >= 200 && event.status < 300;
	return `<div class="item-card"${anchorAttr(event.seq, anchored)}>⚡ <strong>llm #${event.request ?? "?"}</strong> <span class="${ok ? "muted" : "text-failed"}">HTTP ${event.status ?? "?"}</span> <span class="muted">${formatDuration(event.durationMs)}</span></div>`;
}

/**
 * line_comment 内联行(回放感来源:看到第几轮发了哪条评论)
 */
function renderCommentItem(event: OutcomeEvent, vm: TraceDetailViewModel, anchored: boolean): string {
	const comment = event.comment;
	if (comment === undefined) return "";
	const links = buildGitlabLinks(vm.gitlabBaseUrl, vm.trace);
	const location = `${escapeHtml(comment.file)}:${comment.line}`;
	const anchor =
		links.mr !== undefined
			? `<a href="${buildMrDiffLineAnchor(links.mr, comment.file, comment.line)}" target="_blank" rel="noopener">${location}</a>`
			: location;
	const sevClass = SEVERITY_CLASS[comment.severity] ?? "sev-minor";
	return `<div class="item-card item-comment"${anchorAttr(event.seq, anchored)}>💬 ${anchor} <span class="sev-badge ${sevClass}">${escapeHtml(comment.severity)}</span> ${escapeHtml(comment.title)}</div>`;
}

/**
 * input/result 折叠块(默认折叠;pretty ↔ raw 由 app.js 切换;脱敏/截断灰字标注)
 */
function renderIoDetails(label: string, raw: string): string {
	let pretty = raw;
	try {
		pretty = JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		// 非 JSON(截断把结构切坏)时原样展示
	}
	return `
<details class="io">
	<summary>${label} <span class="muted">已脱敏 · 单字段 ≤4000 字符</span></summary>
	<div class="io-body">
		<button class="raw-toggle" data-raw-toggle type="button">raw</button>
		<pre class="io-pretty">${escapeHtml(pretty)}</pre>
		<pre class="io-raw hidden">${escapeHtml(raw)}</pre>
	</div>
</details>`;
}

/**
 * 产出面板(区块 D):评论表 / 拦截表 / self_check / run_summary 四区块
 */
function renderOutputsPanel(vm: TraceDetailViewModel): string {
	return `
${renderCommentsTable(vm)}
${renderBlocksTable(vm)}
${renderSelfCheckCard(vm.flow.selfCheck)}
${renderRunSummaryCard(vm.flow.runSummary)}`;
}

/**
 * 评论表(行外链 MR diff 行锚点)
 */
function renderCommentsTable(vm: TraceDetailViewModel): string {
	if (vm.flow.comments.length === 0)
		return '<section class="output-block"><h2>评论</h2><p class="empty">无评论产出</p></section>';
	const links = buildGitlabLinks(vm.gitlabBaseUrl, vm.trace);
	const rows = vm.flow.comments
		.map((event) => {
			const comment = event.comment;
			if (comment === undefined) return "";
			const location = `${escapeHtml(comment.file)}:${comment.line}`;
			const fileCell =
				links.mr !== undefined
					? `<a href="${buildMrDiffLineAnchor(links.mr, comment.file, comment.line)}" target="_blank" rel="noopener">${location}</a>`
					: location;
			const sevClass = SEVERITY_CLASS[comment.severity] ?? "sev-minor";
			return `<tr><td>${fileCell}</td><td><span class="sev-badge ${sevClass}">${escapeHtml(comment.severity)}</span></td><td>${escapeHtml(comment.title)}</td></tr>`;
		})
		.join("");
	return `
<section class="output-block">
	<h2>评论(${vm.flow.comments.length})</h2>
	<table class="output-table"><thead><tr><th>位置</th><th>severity</th><th>标题</th></tr></thead><tbody>${rows}</tbody></table>
</section>`;
}

/**
 * 拦截表(点击跳回执行流对应节点)
 */
function renderBlocksTable(vm: TraceDetailViewModel): string {
	if (vm.flow.blocks.length === 0)
		return '<section class="output-block"><h2>拦截</h2><p class="empty">无安全拦截</p></section>';
	const rows = vm.flow.blocks
		.map(({ event, anchorSeq }) => {
			const block = event.securityBlock;
			if (block === undefined) return "";
			return `<tr>
	<td><a href="#seq-${anchorSeq}" data-goto-seq="${anchorSeq}">${escapeHtml(block.tool)}</a></td>
	<td>${escapeHtml(block.mode)}</td>
	<td>${escapeHtml(block.reason)}</td>
	<td class="mono">${block.command !== undefined ? escapeHtml(block.command) : '<span class="muted">—</span>'}</td>
</tr>`;
		})
		.join("");
	return `
<section class="output-block">
	<h2>拦截(${vm.flow.blocks.length})</h2>
	<table class="output-table"><thead><tr><th>工具</th><th>模式</th><th>原因</th><th>命令</th></tr></thead><tbody>${rows}</tbody></table>
</section>`;
}

/**
 * self_check 卡片
 */
function renderSelfCheckCard(event: OutcomeEvent | undefined): string {
	const check = event?.selfCheck;
	if (check === undefined) return '<section class="output-block"><h2>自检</h2><p class="empty">无自检结果</p></section>';
	const files =
		check.unsupportedFiles.length > 0
			? `<ul class="mono">${check.unsupportedFiles.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul>`
			: '<span class="muted">无</span>';
	return `
<section class="output-block">
	<h2>自检</h2>
	<dl class="kv">
		<dt>无依据评论文件</dt><dd>${files}</dd>
		<dt>blockerCount</dt><dd>${check.blockerCount}</dd>
		<dt>workspacePrepareCount</dt><dd>${check.workspacePrepareCount}</dd>
	</dl>
</section>`;
}

/**
 * run_summary 卡片
 */
function renderRunSummaryCard(event: OutcomeEvent | undefined): string {
	const summary = event?.runSummary;
	if (summary === undefined)
		return '<section class="output-block"><h2>run 汇总</h2><p class="empty">未收到 run_summary</p></section>';
	return `
<section class="output-block">
	<h2>run 汇总</h2>
	<dl class="kv">
		<dt>exitCode</dt><dd class="${summary.exitCode === 0 ? "" : "text-failed"}">${summary.exitCode}</dd>
		<dt>skill</dt><dd>${escapeHtml(summary.skillUsed)}</dd>
		<dt>blockerCount</dt><dd>${summary.blockerCount}</dd>
		<dt>unsupportedFileCount</dt><dd>${summary.unsupportedFileCount}</dd>
	</dl>
</section>`;
}

/**
 * 评论按 severity 计数(头部指标条)
 */
function countBySeverity(comments: OutcomeEvent[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of comments) {
		const severity = event.comment?.severity;
		if (severity !== undefined) counts[severity] = (counts[severity] ?? 0) + 1;
	}
	return counts;
}
