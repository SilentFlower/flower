/**
 * ingest 核心:NDJSON 逐行解析(坏行容忍)+ 单事务幂等 upsert + trace 聚合物化
 *
 * 关键语义(httpSink 线协议,见 flower-telemetry README):
 * - 行格式与 JSONL artifact 逐字节一致 → 本解析器同时消费 HTTP 推送与文件导入两种来源
 * - 客户端超时重发 → (trace_id, seq) 冲突跳过,聚合只在「实际插入」时增量,重发不重计
 * - 坏行(parse 失败 / 信封缺失 / stream 杂行)计数跳过,不拒整批
 * - payload 存行原文(非 re-stringify),保证落库内容与来源逐字节一致、schema 演进零迁移
 */

import type { OutcomeEvent, TelemetryEvent, TraceEndEvent, TraceStartEvent } from "@flower-ai/flower-telemetry";
import type { ObserverDb } from "./db.js";
import { deriveEndedStatus } from "./trace-status.js";

/**
 * 一批 NDJSON 的 ingest 结果(原样作为 HTTP 响应体)
 */
export interface IngestResult {
	/** 实际插入条数 */
	accepted: number;
	/** (trace_id, seq) 冲突跳过条数(重发场景) */
	skipped: number;
	/** 坏行条数(parse 失败 / 信封缺失 / stream 杂行) */
	badLines: number;
}

/**
 * 消费一批 NDJSON(HTTP 推送或 JSONL artifact 导入,同一入口)
 *
 * 整批单事务:幂等 upsert + 聚合物化 + 收尾状态重判一起提交,
 * 失败回滚后客户端按线协议整批重试,不会出现半批落库。
 *
 * @param db 观测库 DAO
 * @param body NDJSON 原始请求体(每行一个 JSON.stringify(TelemetryEvent))
 * @returns 各计数器结果
 */
export function ingestNdjson(db: ObserverDb, body: string): IngestResult {
	const result: IngestResult = { accepted: 0, skipped: 0, badLines: 0 };
	/** 本批触达的 trace(批末统一做收尾状态重判) */
	const touched = new Set<string>();

	db.transaction(() => {
		for (const line of body.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed === "") continue;

			const event = parseEventLine(trimmed);
			if (event === undefined) {
				result.badLines += 1;
				continue;
			}

			const inserted = db.insertEventIfAbsent({
				trace_id: event.traceId,
				seq: event.seq,
				product: event.product,
				kind: event.kind,
				ts: event.ts,
				// 存行原文:与 jsonlSink 落盘 / httpSink 推送逐字节一致
				payload: trimmed,
			});
			if (!inserted) {
				result.skipped += 1;
				continue;
			}

			db.touchTrace(event.traceId, event.product, event.seq, event.ts);
			materialize(db, event);
			touched.add(event.traceId);
			result.accepted += 1;
		}

		// 收尾状态重判:已收尾的 trace 按缺口/exitCode 物化四态。
		// 放在批末而非逐事件,覆盖「trace_end 先到、缺口事件后到补齐」的重发翻转场景
		for (const traceId of touched) {
			const row = db.getTrace(traceId);
			if (row !== undefined && row.ended_at !== null) {
				db.setTraceStatus(traceId, deriveEndedStatus(row));
			}
		}
	});

	return result;
}

/**
 * 单条 SIEM 审计的 ingest 结果(原样作为 HTTP 响应体)
 */
export interface AuditIngestResult {
	/** 是否已入库 security_events */
	stored: boolean;
	/** 是否回写了对应 trace 的拦截计数 */
	blockCounted: boolean;
}

/**
 * 消费一条 SIEM 审计事件(POST /v1/audit,兼容 sendAudit payload)
 *
 * 兼容性要点:
 * - 仅强制 kind 非空;`traceId` 可缺省(R4 之前的旧 payload),其余字段开放结构原样存 payload
 * - `tool_blocked` 回写对应 trace 的 block_count;trace 行尚不存在时容忍(仅存审计)
 * - 跨通道去重:同一拦截的 security_block outcome(events 通道)与 tool_blocked 投影
 *   共享 (traceId, tool, ts),events 先到时本侧不再 ++
 *
 * @param db 观测库 DAO
 * @param rawBody 请求体原文(单条 JSON)
 * @param receivedAt 服务端接收时刻(Unix 毫秒;ts 缺失时兜底)
 * @returns ingest 结果;payload 非法(parse 失败 / 非对象 / 缺 kind)返回 undefined
 */
export function ingestAudit(db: ObserverDb, rawBody: string, receivedAt: number): AuditIngestResult | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (typeof record.kind !== "string" || record.kind === "") return undefined;
	const kind = record.kind;

	const traceId = typeof record.traceId === "string" && record.traceId !== "" ? record.traceId : null;
	const product = typeof record.product === "string" && record.product !== "" ? record.product : null;
	const tool = typeof record.tool === "string" && record.tool !== "" ? record.tool : null;
	const ts = typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : receivedAt;

	let blockCounted = false;
	db.transaction(() => {
		db.insertSecurityEvent({
			trace_id: traceId,
			product,
			kind,
			tool,
			payload: rawBody.trim(),
			ts,
			received_at: receivedAt,
		});
		if (kind === "tool_blocked" && traceId !== null && db.getTrace(traceId) !== undefined) {
			if (!hasMatchingSecurityBlockOutcome(db, traceId, tool, ts)) {
				db.applySecurityBlock(traceId);
				blockCounted = true;
			}
		}
	});
	return { stored: true, blockCounted };
}

/**
 * events 通道是否已计过同源拦截(跨通道去重的 audit 侧检查)
 *
 * @param db 观测库 DAO
 * @param traceId trace id
 * @param tool 被拦截工具名(null 时仅按 ts 匹配子类型)
 * @param ts 事件时间戳
 * @returns 是否已存在同源 security_block outcome
 */
function hasMatchingSecurityBlockOutcome(db: ObserverDb, traceId: string, tool: string | null, ts: number): boolean {
	for (const row of db.listOutcomeEventsAt(traceId, ts)) {
		try {
			const event = JSON.parse(row.payload) as OutcomeEvent;
			if (event.outcomeType === "security_block" && (tool === null || event.securityBlock?.tool === tool)) {
				return true;
			}
		} catch {
			// payload 入库前已过校验,正常不可达;防御跳过
		}
	}
	return false;
}

/**
 * 解析并校验一行事件
 *
 * 信封五字段(traceId / product / kind / seq / ts)缺失或类型不符即坏行;
 * `stream` 是契约上不会推送的显示信号(且 delta 不脱敏),出现即按坏行跳过;
 * 其余未知 kind 容忍入库(schema 演进零迁移,仅不参与聚合)。
 *
 * @param line 已 trim 的非空行
 * @returns 归一化事件;坏行返回 undefined
 */
function parseEventLine(line: string): TelemetryEvent | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return warnBadLine("JSON parse 失败", line);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return warnBadLine("非对象行", line);
	}
	const event = parsed as Record<string, unknown>;
	if (typeof event.traceId !== "string" || event.traceId === "") return warnBadLine("缺 traceId", line);
	if (typeof event.product !== "string" || event.product === "") return warnBadLine("缺 product", line);
	if (typeof event.kind !== "string" || event.kind === "") return warnBadLine("缺 kind", line);
	if (event.kind === "stream") return warnBadLine("stream 事件不入库", line);
	if (typeof event.seq !== "number" || !Number.isInteger(event.seq) || event.seq < 1) {
		return warnBadLine("seq 非法", line);
	}
	if (typeof event.ts !== "number" || !Number.isFinite(event.ts)) return warnBadLine("ts 非法", line);
	return parsed as TelemetryEvent;
}

/**
 * 坏行诊断输出(默认静默,DEBUG_OBSERVER=1 才单行 warn,避免坏源刷爆日志)
 *
 * @param reason 坏行原因
 * @param line 原始行(截断展示)
 * @returns 恒为 undefined(便于调用方单行 return)
 */
function warnBadLine(reason: string, line: string): undefined {
	if (process.env.DEBUG_OBSERVER === "1") {
		console.warn(`[observer] 坏行(${reason}): ${line.slice(0, 200)}`);
	}
	return undefined;
}

/**
 * 按 kind 增量维护 traces 物化行(仅在事件实际插入后调用)
 *
 * 字段防御:契约 schema 已钉死,但外部输入仍以 ?? 兜底缺省值,坏数据不致崩批。
 *
 * @param db 观测库 DAO
 * @param event 已通过信封校验的事件
 */
function materialize(db: ObserverDb, event: TelemetryEvent): void {
	switch (event.kind) {
		case "trace_start":
			db.applyTraceStart(event.traceId, normalizeCorrelation(event), event.ts);
			break;
		case "outcome":
			materializeOutcome(db, event);
			break;
		case "trace_end":
			db.applyTraceEnd(event.traceId, event.ts, normalizeTotals(event));
			break;
		default:
			// span 与未知 kind:无聚合列,payload 已原文入库
			break;
	}
}

/**
 * outcome 子类型物化(self_check 无聚合列,仅 payload 入库)
 *
 * @param db 观测库 DAO
 * @param event outcome 事件
 */
function materializeOutcome(db: ObserverDb, event: OutcomeEvent): void {
	switch (event.outcomeType) {
		case "line_comment":
			db.applyLineComment(event.traceId, event.comment?.severity === "blocker");
			break;
		case "security_block": {
			// 跨通道计数去重:同一拦截可能经 SIEM 通道(tool_blocked 投影)与本通道各到一次,
			// 投影与源事件共享 (traceId, tool, ts) 自然键 → audit 先到时本侧不再 ++。
			// 产出明细不受影响(详情页拦截表读 events 全量,本计数仅供列表/指标列)
			const block = event.securityBlock;
			if (block !== undefined && db.hasToolBlockedAudit(event.traceId, block.tool, event.ts)) {
				break;
			}
			db.applySecurityBlock(event.traceId);
			break;
		}
		case "run_summary": {
			const summary = event.runSummary;
			// exitCode 非有限数值时不落列(status 判定将按缺 run_summary 的 failed 语义走)
			if (summary !== undefined && Number.isFinite(summary.exitCode)) {
				db.applyRunSummary(
					event.traceId,
					summary.exitCode,
					typeof summary.skillUsed === "string" ? summary.skillUsed : "unknown",
				);
			}
			break;
		}
		default:
			break;
	}
}

/**
 * correlation 关联键防御性取值(缺失字段回退 "unknown",对齐 pipeline 的缺省语义)
 *
 * @param event trace_start 事件
 * @returns 归一化关联键
 */
function normalizeCorrelation(event: TraceStartEvent): {
	project: string;
	mrIid: string;
	commitSha: string;
	pipelineId: string;
} {
	const correlation = event.correlation ?? ({} as Partial<TraceStartEvent["correlation"]>);
	return {
		project: asString(correlation.project),
		mrIid: asString(correlation.mrIid),
		commitSha: asString(correlation.commitSha),
		pipelineId: asString(correlation.pipelineId),
	};
}

/**
 * totals 防御性取值(非数值回退 0)
 *
 * @param event trace_end 事件
 * @returns 归一化 totals
 */
function normalizeTotals(event: TraceEndEvent): { turns: number; toolCalls: number; durationMs: number } {
	const totals = event.totals ?? ({} as Partial<TraceEndEvent["totals"]>);
	return {
		turns: asFiniteNumber(totals.turns),
		toolCalls: asFiniteNumber(totals.toolCalls),
		durationMs: asFiniteNumber(totals.durationMs),
	};
}

/**
 * 字符串防御取值
 *
 * @param value 任意值
 * @returns 非空字符串原值;否则 "unknown"
 */
function asString(value: unknown): string {
	return typeof value === "string" && value !== "" ? value : "unknown";
}

/**
 * 有限数值防御取值
 *
 * @param value 任意值
 * @returns 有限数值原值;否则 0
 */
function asFiniteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
