/**
 * 观测事件模型(三层:trace / span / outcome)+ sink 接口
 *
 * 设计要点:
 * - 一次 run = 一条 trace:`trace_start` 开头、`trace_end` 收尾,中间是 span 流与 outcome 流
 * - 字段显式声明(不开 `[key: string]: unknown` 口子),保证 JSONL 下游消费端可依赖 schema
 * - `stream` 事件仅供 consoleSink 实时显示,jsonlSink / siemSink 必须忽略(不落盘、不上报)
 */

/**
 * 关联键:把一条 trace 与 GitLab MR / CI pipeline 对齐
 *
 * 取值来自 CI 环境变量(CI_PROJECT_PATH / CI_MERGE_REQUEST_IID / CI_COMMIT_SHA / CI_PIPELINE_ID),
 * 缺省容忍 — 本地运行时为 "unknown",不阻塞采集。
 */
export interface TraceCorrelation {
	/** 项目 path(如 `group/repo`) */
	project: string;
	/** MR IID(字符串形式,本地无 MR 时 "unknown") */
	mrIid: string;
	/** commit SHA */
	commitSha: string;
	/** CI pipeline id */
	pipelineId: string;
}

/**
 * 所有事件共有的信封字段(由 pipeline 统一注入,事件生产方不填)
 */
export interface TelemetryEventBase {
	/** 一次 run 的唯一 id */
	traceId: string;
	/** 产品名("code-reviewer" / "ops-bot"),与 compliance 的 product 语义一致 */
	product: string;
	/** trace 内单调递增序号,JSONL 重放时的排序依据 */
	seq: number;
	/** Unix 毫秒时间戳 */
	ts: number;
}

/**
 * trace 开始事件(一次 run 一条,JSONL 首行)
 */
export interface TraceStartEvent extends TelemetryEventBase {
	kind: "trace_start";
	correlation: TraceCorrelation;
	/** 会话启动原因(pi session_start.reason;adapter 未收到该事件时为 "startup") */
	reason: string;
}

/**
 * 过程事件 span 的判别子类型
 *
 * 全部在**完成时刻**发出(带耗时):
 * - `agent`:一次 agent attempt 结束(agent_end)
 * - `turn`:一轮结束(turn_end),携带完整计时分解
 * - `llm_call`:provider 响应头返回(after_provider_response)
 * - `tool_call`:LLM 发出工具调用意图(pi tool_call 事件;此刻尚未执行,无结果)
 * - `tool_result`:工具执行完成(tool_execution_end)
 */
export type SpanType = "agent" | "turn" | "llm_call" | "tool_call" | "tool_result";

/**
 * turn 计时分解(字段语义与 code-reviewer observability spec §6 对齐)
 *
 * 全部为"相对本轮 turn_start 的毫秒数",无法测量时为 undefined(显示层输出 n/a):
 * - `firstTextDeltaMs` 只在收到**非空** text_delta 时记录,thinking / toolcall 不算首字
 */
export interface TurnTiming {
	/** 本轮总耗时 */
	durationMs?: number;
	/** 模型请求次数 */
	providerRequestCount: number;
	/** 模型响应次数 */
	providerResponseCount: number;
	/** 工具调用次数 */
	toolCount: number;
	/** 工具总耗时(毫秒) */
	toolTotalMs: number;
	/** 本轮 toolResults 数量(turn_end 事件携带) */
	toolResultCount: number;
	/** 最近一次 provider 响应 HTTP 状态 */
	providerLastStatus?: number;
	/** 首次 provider 请求发出 */
	firstProviderRequestMs?: number;
	/** 最近一次 provider 请求 → 响应头耗时 */
	providerResponseHeadersMs?: number;
	/** 请求已发出但本轮结束仍未收到响应头的等待时长 */
	providerPendingMs?: number;
	/** 首个流式事件(thinking / text / toolcall 任一) */
	firstAgentMessageEventMs?: number;
	/** 响应头 → 首个流式事件 */
	firstAgentMessageAfterProviderMs?: number;
	/** 本轮首字(首个非空 text_delta) */
	firstTextDeltaMs?: number;
	/** 响应头 → 本轮首字 */
	firstTextDeltaAfterProviderMs?: number;
	/** 首个工具调用就绪(toolcall_end 流式事件) */
	firstToolCallReadyMs?: number;
}

/**
 * agent attempt 汇总(spanType=agent)
 */
export interface AgentSummary {
	/** 第几次 attempt(从 1 开始) */
	attempt: number;
	/** 最后一条 assistant 消息的 stopReason,取不到时 "unknown" */
	stopReason: string;
	/** 最后一条 assistant 消息的 token usage(取不到的分量为 undefined) */
	usage?: { input?: number; output?: number; total?: number };
	/** 最后一条 assistant 消息的错误信息(已截断) */
	errorMessage?: string;
}

/**
 * 过程事件:agent / turn / LLM 调用 / 工具调用意图 / 工具结果
 */
export interface SpanEvent extends TelemetryEventBase {
	kind: "span";
	spanType: SpanType;
	/** 所属 turn 序号(可定位时携带) */
	turnIndex?: number;
	/** agent attempt 序号(可定位时携带) */
	attempt?: number;
	/** 耗时毫秒(agent / turn 总耗时、tool 执行耗时、llm 响应头耗时) */
	durationMs?: number;
	/** 工具名(spanType=tool_call / tool_result) */
	tool?: string;
	/** 工具调用 id(tool_call 与 tool_result 配对、与 security_block outcome 关联) */
	toolCallId?: string;
	/** 工具入参字段名列表(spanType=tool_call;siemSink 的 metadata-only 投影来源) */
	inputKeys?: string[];
	/** 工具入参(JSON 字符串,pipeline 已脱敏 + 截断;spanType=tool_call) */
	input?: string;
	/** 工具结果(JSON 字符串,pipeline 已脱敏 + 截断;spanType=tool_result) */
	result?: string;
	/** 工具结果是否错误(spanType=tool_result) */
	isError?: boolean;
	/** provider HTTP 状态(spanType=llm_call) */
	status?: number;
	/** provider 请求序号(spanType=llm_call,一次 run 内全局递增) */
	request?: number;
	/** turn 计时分解(spanType=turn) */
	timing?: TurnTiming;
	/** agent attempt 汇总(spanType=agent) */
	agent?: AgentSummary;
}

/**
 * 结果事件的判别子类型
 *
 * - `line_comment`:本次评审发出的一条行内评论(来自 review-trace 真值)
 * - `self_check`:评审收尾自检结果(无依据评论等)
 * - `security_block`:compliance 拦截事件(经产品层 onBlock 接线写入)
 * - `run_summary`:一次 run 的业务结论(exitCode 等)
 */
export type OutcomeType = "line_comment" | "self_check" | "security_block" | "run_summary";

/**
 * 结果事件:trace 的业务真值,评审质量分析与回放评估的核心数据
 */
export interface OutcomeEvent extends TelemetryEventBase {
	kind: "outcome";
	outcomeType: OutcomeType;
	/** 行内评论(outcomeType=line_comment) */
	comment?: { file: string; line: number; severity: string; title: string };
	/** 自检结果(outcomeType=self_check) */
	selfCheck?: { unsupportedFiles: string[]; blockerCount: number; workspacePrepareCount: number };
	/** 安全拦截(outcomeType=security_block;toolCallId 可关联对应 tool_call span) */
	securityBlock?: { tool: string; mode: string; reason: string; toolCallId?: string; command?: string };
	/** run 汇总(outcomeType=run_summary) */
	runSummary?: { exitCode: number; skillUsed: string; blockerCount: number; unsupportedFileCount: number };
}

/**
 * trace 结束事件(一次 run 一条,JSONL 末行)
 */
export interface TraceEndEvent extends TelemetryEventBase {
	kind: "trace_end";
	totals: { turns: number; toolCalls: number; durationMs: number };
}

/**
 * 流式打印事件的判别子类型
 *
 * 实时显示专用的"瞬时"信号(无耗时语义),与完成型 span 互补:
 * - 生命周期瞬间:agent_start / turn_start / provider_request
 * - 流式增量:thinking_* / text_*
 * - 工具调用就绪:toolcall_ready(LLM 拼完工具入参,此刻尚未执行)
 */
export type StreamType =
	| "agent_start"
	| "turn_start"
	| "provider_request"
	| "thinking_start"
	| "thinking_delta"
	| "thinking_end"
	| "text_start"
	| "text_delta"
	| "text_end"
	| "toolcall_ready";

/**
 * 流式打印事件(仅供 consoleSink;jsonlSink / siemSink 忽略)
 *
 * 注意:thinking_delta / text_delta 的 `delta` **不做脱敏**(增量切片会把 secret 拆碎,
 * 逐片正则既慢又必然漏)— 与现行 CI stdout 直出行为一致;
 * 唯一例外是 `toolcall_ready` 的 `delta`(完整入参预览字符串),pipeline 会脱敏。
 */
export interface StreamEvent extends TelemetryEventBase {
	kind: "stream";
	streamType: StreamType;
	/** 流式文本增量,或 toolcall_ready 的完整入参预览 */
	delta?: string;
	/** 显示用附加字段 */
	attrs?: { attempt?: number; turnIndex?: number; tool?: string; request?: number };
}

/**
 * 归一化观测事件(判别联合,`kind` 区分)
 */
export type TelemetryEvent = TraceStartEvent | SpanEvent | OutcomeEvent | TraceEndEvent | StreamEvent;

/**
 * 事件生产方的输入形态:信封字段(traceId / product / seq / ts)由 pipeline 注入
 */
export type TelemetryEventInput = DistributiveOmit<TelemetryEvent, keyof TelemetryEventBase>;

/**
 * 在判别联合的每个成员上分别 Omit(直接 Omit 会丢失判别能力)
 */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * 观测 sink 接口:pipeline 归一化后的事件消费方
 *
 * 实现约定:
 * - `onEvent` 内部**不得抛错**(pipeline 有 try-catch 兜底,但 sink 自身也应 fail-open)
 * - 耗时操作(网络 / 磁盘)在 sink 内部 fire-and-forget,不阻塞 emit 调用方
 */
export interface TelemetrySink {
	/** sink 名称(故障 warn 与调试用) */
	name: string;
	/**
	 * 是否关键 sink:critical sink 不受 `FLOWER_TELEMETRY=0` 总开关影响
	 * (SIEM 审计的"不可关"属性;默认 false)
	 */
	critical?: boolean;
	/**
	 * 消费一条归一化事件
	 *
	 * @param event 已注入信封字段、已脱敏截断的事件
	 */
	onEvent(event: TelemetryEvent): void;
	/**
	 * run 结束时冲刷缓冲(jsonl fsync / 在途上报收尾);可选实现
	 */
	flush?(): Promise<void>;
}
