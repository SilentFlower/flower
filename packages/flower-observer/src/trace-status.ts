/**
 * trace 四态推导:物化规则 + 查询期 stale-running 展示推导
 *
 * 规则来源:research/ui-patterns.md §五.6 + design.md「trace 四态物化」表。
 * seq 由 pipeline 从 1 单调递增 → `event_count == max_seq` 即「无缺口收齐」,
 * 缺口可被精确检测(业界通常无此机制,是本事件模型的定制红利)。
 */

import type { TraceRow, TraceStatus } from "./db.js";

/**
 * 已收尾 trace 的物化状态判定(ingest 在收到 trace_end 或补齐缺口后调用)
 *
 * - 有 seq 缺口(event_count != max_seq)→ incomplete
 * - 无缺口且 exitCode=0 → success
 * - 无缺口且 exitCode≠0 → failed
 * - 无缺口但缺 run_summary(exit_code 为 null)→ failed:评审没有产出业务结论,
 *   按失败语义处理(正常收尾流程 run_summary 必在 trace_end 之前发出)
 *
 * @param row trace 物化行(需已收尾,即 ended_at 非空)
 * @returns 物化状态
 */
export function deriveEndedStatus(row: Pick<TraceRow, "event_count" | "max_seq" | "exit_code">): TraceStatus {
	if (row.event_count !== row.max_seq) return "incomplete";
	return row.exit_code === 0 ? "success" : "failed";
}

/**
 * 查询期展示状态推导(纯展示,不回写库)
 *
 * running 且超过 staleRunningMinutes 无新事件 → 展示为 incomplete:
 * 进程被 kill / CI 超时等场景永远等不到 trace_end,物化状态停留在 running,
 * 查询期兜底把「假运行中」翻译成「半截」。
 *
 * @param row trace 物化行
 * @param nowMs 当前时刻(Unix 毫秒;由调用方注入便于测试)
 * @param staleRunningMinutes 超时阈值(分钟,OBSERVER_STALE_RUNNING_MINUTES)
 * @returns 展示状态
 */
export function displayStatus(
	row: Pick<TraceRow, "status" | "last_event_at">,
	nowMs: number,
	staleRunningMinutes: number,
): TraceStatus {
	if (row.status === "running" && nowMs - row.last_event_at > staleRunningMinutes * 60_000) {
		return "incomplete";
	}
	return row.status;
}
