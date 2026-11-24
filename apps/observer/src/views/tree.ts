/**
 * 执行流重建纯函数:事件流(seq 升序)→ attempt → turn → 叶子项 三层树 + 平铺流
 *
 * 事件模型没有 parent_id(research/ui-patterns §三):
 * - `agent` / `turn` span 在「完成时刻」发出 → 顺序扫描时它们是各自层级的「闭合括号」,
 *   闭合前缓冲的叶子项归属该层
 * - `tool_call` 与 `tool_result` 按 toolCallId 配对成单卡片;`security_block` outcome
 *   按 toolCallId 挂回对应卡片(拦截红条内联)
 * - `line_comment` outcome 按 seq 内联进当前轮(回放感的来源)
 * - seq 从 1 单调递增 → 相邻 seq 差 >1 即缺口,可精确报告区间
 */

import type {
	OutcomeEvent,
	SpanEvent,
	TelemetryEvent,
	TraceEndEvent,
	TraceStartEvent,
} from "@flower-ai/flower-telemetry";

/**
 * 执行流叶子项(联合判别:type)
 *
 * - tool:tool_call / tool_result 配对卡片(任一侧可缺;blocked = 关联拦截)
 * - llm_call:模型调用
 * - comment:行内评论(内联)
 * - block:未能按 toolCallId 配对的拦截(独立红条)
 */
export type FlowItem =
	| { type: "tool"; seq: number; call?: SpanEvent; result?: SpanEvent; blocked?: OutcomeEvent }
	| { type: "llm_call"; seq: number; event: SpanEvent }
	| { type: "comment"; seq: number; event: OutcomeEvent }
	| { type: "block"; seq: number; event: OutcomeEvent };

/**
 * 轮节点(turn 缺失 = 进行中未闭合,open=true)
 */
export interface TurnNode {
	/** 轮序号(闭合 turn span 携带;未闭合时 undefined) */
	turnIndex: number | undefined;
	/** 闭合的 turn span(含 timing 分解) */
	turn?: SpanEvent;
	/** 本轮叶子项(seq 顺序) */
	items: FlowItem[];
	/** 是否未闭合(进行中 trace 的最后一轮) */
	open: boolean;
}

/**
 * attempt 节点(agent 缺失 = 进行中未闭合)
 */
export interface AttemptNode {
	/** attempt 序号(闭合 agent span 携带;未闭合时 undefined) */
	attempt: number | undefined;
	/** 闭合的 agent span(stopReason / usage / errorMessage) */
	agent?: SpanEvent;
	/** 本 attempt 的轮列表 */
	turns: TurnNode[];
	/** 是否未闭合 */
	open: boolean;
}

/**
 * seq 缺口区间(闭区间,缺失的 seq 范围)
 */
export interface SeqGap {
	from: number;
	to: number;
}

/**
 * 重建结果:三层树 + 平铺流 + 产出区数据
 */
export interface TraceFlow {
	/** attempt 树(树状视图) */
	attempts: AttemptNode[];
	/** 平铺流(同一批叶子项按 seq 排序,平铺视图) */
	flat: FlowItem[];
	/** seq 缺口区间 */
	gaps: SeqGap[];
	/** trace_start(头部 reason 等) */
	start?: TraceStartEvent;
	/** trace_end(totals) */
	end?: TraceEndEvent;
	/** 产出 tab:行内评论(seq 顺序) */
	comments: OutcomeEvent[];
	/** 产出 tab:安全拦截(anchorSeq = 执行流锚点:配对时为 tool 卡片 seq,否则自身 seq) */
	blocks: Array<{ event: OutcomeEvent; anchorSeq: number }>;
	/** 产出 tab:自检结果 */
	selfCheck?: OutcomeEvent;
	/** 产出 tab:run 汇总 */
	runSummary?: OutcomeEvent;
}

/**
 * 重建执行流
 *
 * @param events 一条 trace 的全量事件(任意顺序,内部按 seq 排序)
 * @returns 三层树 + 平铺流 + 产出数据
 */
export function buildTraceFlow(events: TelemetryEvent[]): TraceFlow {
	const sorted = [...events].sort((a, b) => a.seq - b.seq);

	const flow: TraceFlow = { attempts: [], flat: [], gaps: detectGaps(sorted), comments: [], blocks: [] };
	const attempts: AttemptNode[] = [];
	/** 已闭合的轮(等待 agent 闭合归属) */
	let turnNodes: TurnNode[] = [];
	/** 当前轮缓冲(等待 turn 闭合) */
	let turnBuffer: FlowItem[] = [];
	/** toolCallId → 卡片(tool_result / security_block 配对) */
	const toolIndex = new Map<string, Extract<FlowItem, { type: "tool" }>>();

	/** 闭合当前 attempt(agent span 到达,或末尾收口) */
	function closeAttempt(agent?: SpanEvent): void {
		if (turnBuffer.length > 0) {
			turnNodes.push({ turnIndex: undefined, items: turnBuffer, open: true });
			turnBuffer = [];
		}
		if (agent === undefined && turnNodes.length === 0) return;
		attempts.push({
			attempt: agent?.agent?.attempt ?? agent?.attempt,
			...(agent !== undefined ? { agent } : {}),
			turns: turnNodes,
			open: agent === undefined,
		});
		turnNodes = [];
	}

	for (const event of sorted) {
		if (event.kind === "trace_start") {
			flow.start = event;
		} else if (event.kind === "trace_end") {
			flow.end = event;
		} else if (event.kind === "span") {
			handleSpan(event);
		} else if (event.kind === "outcome") {
			handleOutcome(event);
		}
		// stream 不会出现(ingest 已拒),未知 kind 忽略
	}
	closeAttempt();
	flow.attempts = attempts;
	flow.flat.sort((a, b) => a.seq - b.seq);
	return flow;

	/** span 分发:叶子项进缓冲;turn / agent 闭合层级 */
	function handleSpan(event: SpanEvent): void {
		switch (event.spanType) {
			case "tool_call": {
				const item: Extract<FlowItem, { type: "tool" }> = { type: "tool", seq: event.seq, call: event };
				if (event.toolCallId !== undefined) toolIndex.set(event.toolCallId, item);
				turnBuffer.push(item);
				flow.flat.push(item);
				break;
			}
			case "tool_result": {
				const paired = event.toolCallId !== undefined ? toolIndex.get(event.toolCallId) : undefined;
				if (paired !== undefined && paired.result === undefined) {
					paired.result = event;
				} else {
					// 孤儿 result(对应 tool_call 在缺口里):独立卡片
					const item: Extract<FlowItem, { type: "tool" }> = { type: "tool", seq: event.seq, result: event };
					turnBuffer.push(item);
					flow.flat.push(item);
				}
				break;
			}
			case "llm_call": {
				const item: FlowItem = { type: "llm_call", seq: event.seq, event };
				turnBuffer.push(item);
				flow.flat.push(item);
				break;
			}
			case "turn":
				turnNodes.push({ turnIndex: event.turnIndex, turn: event, items: turnBuffer, open: false });
				turnBuffer = [];
				break;
			case "agent":
				closeAttempt(event);
				break;
			default:
				break;
		}
	}

	/** outcome 分发:评论/拦截内联进流,自检/汇总只进产出区 */
	function handleOutcome(event: OutcomeEvent): void {
		switch (event.outcomeType) {
			case "line_comment": {
				flow.comments.push(event);
				const item: FlowItem = { type: "comment", seq: event.seq, event };
				turnBuffer.push(item);
				flow.flat.push(item);
				break;
			}
			case "security_block": {
				const toolCallId = event.securityBlock?.toolCallId;
				const paired = toolCallId !== undefined ? toolIndex.get(toolCallId) : undefined;
				if (paired !== undefined) {
					paired.blocked = event;
					// 锚点指向所挂卡片(独立节点不存在),拦截表跳转才能命中
					flow.blocks.push({ event, anchorSeq: paired.seq });
				} else {
					const item: FlowItem = { type: "block", seq: event.seq, event };
					turnBuffer.push(item);
					flow.flat.push(item);
					flow.blocks.push({ event, anchorSeq: event.seq });
				}
				break;
			}
			case "self_check":
				flow.selfCheck = event;
				break;
			case "run_summary":
				flow.runSummary = event;
				break;
			default:
				break;
		}
	}
}

/**
 * seq 缺口检测(seq 自 1 单调递增,相邻差 >1 即缺失区间)
 *
 * @param sorted 按 seq 升序的事件
 * @returns 缺失的 seq 闭区间列表
 */
export function detectGaps(sorted: TelemetryEvent[]): SeqGap[] {
	const gaps: SeqGap[] = [];
	let prev = 0;
	for (const event of sorted) {
		if (event.seq > prev + 1) {
			gaps.push({ from: prev + 1, to: event.seq - 1 });
		}
		if (event.seq > prev) prev = event.seq;
	}
	return gaps;
}
