/**
 * SQLite 存储层(node:sqlite,WAL)
 *
 * 设计要点:
 * - 全部 SQL 收口在本文件(薄 DAO),业务层不直接拼 SQL;
 *   万一 node:sqlite 踩到缺口,切 better-sqlite3 只改本文件(同步同范式)
 * - events 表存事件原始 JSON 整行(schema 演进零迁移),仅信封 + 聚合所需列提升
 * - traces 表是 ingest 事务内同步维护的物化视图,列表/指标查询不扫 events
 * - 聚合增量只在事件「实际插入」时执行((trace_id, seq) 冲突跳过返回 false),
 *   配合 httpSink 超时重发语义实现幂等不重计
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * trace 四态(物化规则见 trace-status.ts)
 *
 * - running:已开始未收尾
 * - success:已收尾且无 seq 缺口且 exitCode=0
 * - failed:已收尾且无 seq 缺口且 exitCode≠0
 * - incomplete:已收尾但有 seq 缺口(查询期另有 stale-running 展示推导,不回写)
 */
export type TraceStatus = "running" | "success" | "failed" | "incomplete";

/**
 * events 表行(payload 为 TelemetryEvent 原文 JSON 字符串)
 */
export interface EventRow {
	trace_id: string;
	seq: number;
	product: string;
	kind: string;
	ts: number;
	payload: string;
}

/**
 * traces 物化视图行
 */
export interface TraceRow {
	trace_id: string;
	product: string;
	project: string | null;
	mr_iid: string | null;
	commit_sha: string | null;
	pipeline_id: string | null;
	started_at: number | null;
	ended_at: number | null;
	status: TraceStatus;
	turns: number | null;
	tool_calls: number | null;
	duration_ms: number | null;
	comment_count: number;
	blocker_count: number;
	block_count: number;
	exit_code: number | null;
	skill_used: string | null;
	max_seq: number;
	event_count: number;
	last_event_at: number;
}

/**
 * security_events 表行(SIEM 审计通道;trace_id 可空兼容旧 payload)
 */
export interface SecurityEventRow {
	id: number;
	trace_id: string | null;
	product: string | null;
	kind: string;
	tool: string | null;
	payload: string;
	ts: number;
	received_at: number;
}

/**
 * trace 列表查询条件(过滤语义见 listTraces)
 */
export interface TraceListFilter {
	/** 板块过滤(空 = 全部产品) */
	product?: string;
	/** 项目 path 精确过滤 */
	project?: string;
	/** MR IID 精确过滤 */
	mrIid?: string;
	/** 状态多选(展示语义,含 stale-running → incomplete 的翻译) */
	statuses?: TraceStatus[];
	/** 时间下界(COALESCE(started_at, last_event_at) >= sinceMs) */
	sinceMs?: number;
	/** stale 截止时刻(now - 阈值;running 且 last_event_at <= 此值视为 stale) */
	staleCutoffMs: number;
	/** 分页大小 */
	limit: number;
	/** 分页偏移 */
	offset: number;
}

/** 建表 DDL(IF NOT EXISTS 幂等,启动即迁移) */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS events (
	trace_id TEXT NOT NULL,
	seq      INTEGER NOT NULL,
	product  TEXT NOT NULL,
	kind     TEXT NOT NULL,
	ts       INTEGER NOT NULL,
	payload  TEXT NOT NULL,
	PRIMARY KEY (trace_id, seq)
);

CREATE TABLE IF NOT EXISTS traces (
	trace_id      TEXT PRIMARY KEY,
	product       TEXT NOT NULL,
	project       TEXT,
	mr_iid        TEXT,
	commit_sha    TEXT,
	pipeline_id   TEXT,
	started_at    INTEGER,
	ended_at      INTEGER,
	status        TEXT NOT NULL DEFAULT 'running',
	turns         INTEGER,
	tool_calls    INTEGER,
	duration_ms   INTEGER,
	comment_count INTEGER NOT NULL DEFAULT 0,
	blocker_count INTEGER NOT NULL DEFAULT 0,
	block_count   INTEGER NOT NULL DEFAULT 0,
	exit_code     INTEGER,
	skill_used    TEXT,
	max_seq       INTEGER NOT NULL DEFAULT 0,
	event_count   INTEGER NOT NULL DEFAULT 0,
	last_event_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_list ON traces(product, started_at DESC);

CREATE TABLE IF NOT EXISTS security_events (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	trace_id    TEXT,
	product     TEXT,
	kind        TEXT NOT NULL,
	tool        TEXT,
	payload     TEXT NOT NULL,
	ts          INTEGER NOT NULL,
	received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_events_trace ON security_events(trace_id);
`;

/**
 * 观测库 DAO:打开/迁移 + 写路径原语 + 查询
 */
export class ObserverDb {
	private readonly db: DatabaseSync;
	private readonly stmtInsertEvent: StatementSync;
	private readonly stmtEnsureTrace: StatementSync;
	private readonly stmtTouchTrace: StatementSync;
	private readonly stmtApplyTraceStart: StatementSync;
	private readonly stmtApplyLineComment: StatementSync;
	private readonly stmtApplySecurityBlock: StatementSync;
	private readonly stmtApplyRunSummary: StatementSync;
	private readonly stmtApplyTraceEnd: StatementSync;
	private readonly stmtSetStatus: StatementSync;
	private readonly stmtGetTrace: StatementSync;
	private readonly stmtListEvents: StatementSync;
	private readonly stmtListOutcomeEventsAt: StatementSync;
	private readonly stmtHasToolBlockedAudit: StatementSync;
	private readonly stmtInsertSecurityEvent: StatementSync;

	/**
	 * 打开(或创建)SQLite 库并完成迁移
	 *
	 * @param dbPath 库文件路径;":memory:" 用于单测
	 */
	constructor(dbPath: string) {
		// 确保父目录存在(Docker volume 首次挂载为空目录)
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new DatabaseSync(dbPath);
		// WAL:读不阻塞写;NORMAL 配 WAL 是官方推荐组合(观测数据可容忍极端断电丢尾)
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec(SCHEMA_DDL);

		this.stmtInsertEvent = this.db.prepare(
			"INSERT INTO events (trace_id, seq, product, kind, ts, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(trace_id, seq) DO NOTHING",
		);
		this.stmtEnsureTrace = this.db.prepare(
			"INSERT INTO traces (trace_id, product, last_event_at) VALUES (?, ?, ?) ON CONFLICT(trace_id) DO NOTHING",
		);
		this.stmtTouchTrace = this.db.prepare(
			"UPDATE traces SET max_seq = MAX(max_seq, ?), event_count = event_count + 1, last_event_at = MAX(last_event_at, ?) WHERE trace_id = ?",
		);
		this.stmtApplyTraceStart = this.db.prepare(
			"UPDATE traces SET project = ?, mr_iid = ?, commit_sha = ?, pipeline_id = ?, started_at = ? WHERE trace_id = ?",
		);
		this.stmtApplyLineComment = this.db.prepare(
			"UPDATE traces SET comment_count = comment_count + 1, blocker_count = blocker_count + ? WHERE trace_id = ?",
		);
		this.stmtApplySecurityBlock = this.db.prepare("UPDATE traces SET block_count = block_count + 1 WHERE trace_id = ?");
		this.stmtApplyRunSummary = this.db.prepare("UPDATE traces SET exit_code = ?, skill_used = ? WHERE trace_id = ?");
		this.stmtApplyTraceEnd = this.db.prepare(
			"UPDATE traces SET ended_at = ?, turns = ?, tool_calls = ?, duration_ms = ? WHERE trace_id = ?",
		);
		this.stmtSetStatus = this.db.prepare("UPDATE traces SET status = ? WHERE trace_id = ?");
		this.stmtGetTrace = this.db.prepare("SELECT * FROM traces WHERE trace_id = ?");
		this.stmtListEvents = this.db.prepare("SELECT * FROM events WHERE trace_id = ? ORDER BY seq ASC");
		this.stmtListOutcomeEventsAt = this.db.prepare(
			"SELECT * FROM events WHERE trace_id = ? AND kind = 'outcome' AND ts = ?",
		);
		this.stmtHasToolBlockedAudit = this.db.prepare(
			"SELECT 1 FROM security_events WHERE trace_id = ? AND kind = 'tool_blocked' AND tool = ? AND ts = ? LIMIT 1",
		);
		this.stmtInsertSecurityEvent = this.db.prepare(
			"INSERT INTO security_events (trace_id, product, kind, tool, payload, ts, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
	}

	/**
	 * 在单事务内执行写操作(ingest 一批一事务)
	 *
	 * @param fn 事务体(同步执行;抛错即回滚并重抛)
	 * @returns 事务体返回值
	 */
	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	/**
	 * 插入一条事件;(trace_id, seq) 已存在时跳过
	 *
	 * 同 seq 重发内容相同(httpSink 超时重发语义),无需 UPDATE。
	 *
	 * @param row 事件行
	 * @returns 是否实际插入(false = 冲突跳过,调用方据此跳过聚合增量)
	 */
	insertEventIfAbsent(row: EventRow): boolean {
		const result = this.stmtInsertEvent.run(row.trace_id, row.seq, row.product, row.kind, row.ts, row.payload);
		return result.changes > 0;
	}

	/**
	 * 确保 traces 行存在(不存在则以默认值创建),并累计事件计数器
	 *
	 * 仅在事件「实际插入」后调用:max_seq 取最大值、event_count 自增、
	 * last_event_at 取最大值(乱序容忍)。
	 *
	 * @param traceId trace id
	 * @param product 产品名(信封字段,同 trace 恒定)
	 * @param seq 本事件 seq
	 * @param ts 本事件时间戳(Unix 毫秒)
	 */
	touchTrace(traceId: string, product: string, seq: number, ts: number): void {
		this.stmtEnsureTrace.run(traceId, product, ts);
		this.stmtTouchTrace.run(seq, ts, traceId);
	}

	/**
	 * 物化 trace_start:correlation 关联键 + 开始时间
	 *
	 * @param traceId trace id
	 * @param correlation GitLab 关联键
	 * @param startedAt trace_start 事件时间戳
	 */
	applyTraceStart(
		traceId: string,
		correlation: { project: string; mrIid: string; commitSha: string; pipelineId: string },
		startedAt: number,
	): void {
		this.stmtApplyTraceStart.run(
			correlation.project,
			correlation.mrIid,
			correlation.commitSha,
			correlation.pipelineId,
			startedAt,
			traceId,
		);
	}

	/**
	 * 物化 line_comment outcome:评论计数 +1(blocker 级同时累计 blocker_count)
	 *
	 * @param traceId trace id
	 * @param isBlocker severity 是否为 blocker
	 */
	applyLineComment(traceId: string, isBlocker: boolean): void {
		this.stmtApplyLineComment.run(isBlocker ? 1 : 0, traceId);
	}

	/**
	 * 物化 security_block outcome:拦截计数 +1
	 *
	 * @param traceId trace id
	 */
	applySecurityBlock(traceId: string): void {
		this.stmtApplySecurityBlock.run(traceId);
	}

	/**
	 * 物化 run_summary outcome:exit_code / skill_used 落列
	 *
	 * @param traceId trace id
	 * @param exitCode run 退出码
	 * @param skillUsed 本次评审使用的 skill
	 */
	applyRunSummary(traceId: string, exitCode: number, skillUsed: string): void {
		this.stmtApplyRunSummary.run(exitCode, skillUsed, traceId);
	}

	/**
	 * 物化 trace_end:结束时间 + totals 落列(status 判定由调用方走 trace-status 规则后回写)
	 *
	 * @param traceId trace id
	 * @param endedAt trace_end 事件时间戳
	 * @param totals 累计统计(turns / toolCalls / durationMs)
	 */
	applyTraceEnd(
		traceId: string,
		endedAt: number,
		totals: { turns: number; toolCalls: number; durationMs: number },
	): void {
		this.stmtApplyTraceEnd.run(endedAt, totals.turns, totals.toolCalls, totals.durationMs, traceId);
	}

	/**
	 * 回写 trace 物化状态
	 *
	 * @param traceId trace id
	 * @param status 四态之一
	 */
	setTraceStatus(traceId: string, status: TraceStatus): void {
		this.stmtSetStatus.run(status, traceId);
	}

	/**
	 * 读取单条 trace 物化行
	 *
	 * @param traceId trace id
	 * @returns 物化行;不存在时 undefined
	 */
	getTrace(traceId: string): TraceRow | undefined {
		return this.stmtGetTrace.get(traceId) as TraceRow | undefined;
	}

	/**
	 * 按 seq 升序读取一条 trace 的全量事件
	 *
	 * @param traceId trace id
	 * @returns 事件行数组(回放顺序)
	 */
	listEventsByTrace(traceId: string): EventRow[] {
		return this.stmtListEvents.all(traceId) as unknown as EventRow[];
	}

	/**
	 * 读取一条 trace 在指定时刻的 outcome 事件(SIEM 跨通道计数去重用)
	 *
	 * @param traceId trace id
	 * @param ts 事件时间戳(投影与源事件共享同一 ts)
	 * @returns 匹配的事件行(payload 由调用方 parse 判定子类型)
	 */
	listOutcomeEventsAt(traceId: string, ts: number): EventRow[] {
		return this.stmtListOutcomeEventsAt.all(traceId, ts) as unknown as EventRow[];
	}

	/**
	 * 判断是否已存在同源 tool_blocked 审计记录(events 通道跨通道计数去重用)
	 *
	 * @param traceId trace id
	 * @param tool 被拦截工具名
	 * @param ts 事件时间戳
	 * @returns 是否已有同 (trace, tool, ts) 的 tool_blocked 审计行
	 */
	hasToolBlockedAudit(traceId: string, tool: string, ts: number): boolean {
		return this.stmtHasToolBlockedAudit.get(traceId, tool, ts) !== undefined;
	}

	/**
	 * 写入一条 SIEM 审计事件
	 *
	 * @param row 审计行(id 自增,无需传入)
	 * @returns 自增 id
	 */
	insertSecurityEvent(row: Omit<SecurityEventRow, "id">): number {
		const result = this.stmtInsertSecurityEvent.run(
			row.trace_id,
			row.product,
			row.kind,
			row.tool,
			row.payload,
			row.ts,
			row.received_at,
		);
		return Number(result.lastInsertRowid);
	}

	/**
	 * 保留期清理:删除「开始时间(缺省回退最后事件时间)早于截止时刻」的 trace
	 * 及其 events,连同同样超期的 security_events
	 *
	 * @param cutoffMs 截止时刻(Unix 毫秒;早于该时刻的数据被删除)
	 * @returns 各表删除行数
	 */
	deleteExpired(cutoffMs: number): { traces: number; events: number; securityEvents: number } {
		return this.transaction(() => {
			// 先删子数据再删 traces(无外键,顺序仅为语义清晰)
			const events = this.db
				.prepare(
					"DELETE FROM events WHERE trace_id IN (SELECT trace_id FROM traces WHERE COALESCE(started_at, last_event_at) < ?)",
				)
				.run(cutoffMs).changes;
			// 关联超期 trace 的拦截记录一并删;孤儿记录(无 traceId 旧 payload)按自身事件时间判
			const securityEvents = this.db
				.prepare(
					"DELETE FROM security_events WHERE trace_id IN (SELECT trace_id FROM traces WHERE COALESCE(started_at, last_event_at) < ?) OR (trace_id IS NULL AND ts < ?)",
				)
				.run(cutoffMs, cutoffMs).changes;
			const traces = this.db
				.prepare("DELETE FROM traces WHERE COALESCE(started_at, last_event_at) < ?")
				.run(cutoffMs).changes;
			return { traces: Number(traces), events: Number(events), securityEvents: Number(securityEvents) };
		});
	}

	/**
	 * trace 列表查询(列表页 / 列表 API 共用)
	 *
	 * status 过滤按「展示语义」翻译为 SQL(与 trace-status.ts 的查询期推导一致):
	 * - running    = 物化 running 且未超 stale 阈值
	 * - incomplete = 物化 incomplete,或物化 running 但已超 stale 阈值
	 * - success / failed = 物化状态直配
	 *
	 * @param filter 过滤与分页条件(staleCutoffMs = now - 阈值,小于该时刻的 running 视为 stale)
	 * @returns 当前页行 + 满足条件总数
	 */
	listTraces(filter: TraceListFilter): { rows: TraceRow[]; total: number } {
		const where: string[] = [];
		const params: Array<string | number> = [];
		if (filter.product !== undefined && filter.product !== "") {
			where.push("product = ?");
			params.push(filter.product);
		}
		if (filter.project !== undefined && filter.project !== "") {
			where.push("project = ?");
			params.push(filter.project);
		}
		if (filter.mrIid !== undefined && filter.mrIid !== "") {
			where.push("mr_iid = ?");
			params.push(filter.mrIid);
		}
		if (filter.sinceMs !== undefined) {
			where.push("COALESCE(started_at, last_event_at) >= ?");
			params.push(filter.sinceMs);
		}
		if (filter.statuses !== undefined && filter.statuses.length > 0) {
			const clauses: string[] = [];
			for (const status of filter.statuses) {
				if (status === "running") {
					clauses.push("(status = 'running' AND last_event_at > ?)");
					params.push(filter.staleCutoffMs);
				} else if (status === "incomplete") {
					clauses.push("(status = 'incomplete' OR (status = 'running' AND last_event_at <= ?))");
					params.push(filter.staleCutoffMs);
				} else {
					clauses.push("status = ?");
					params.push(status);
				}
			}
			where.push(`(${clauses.join(" OR ")})`);
		}
		const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

		const countRow = this.db.prepare(`SELECT COUNT(*) AS n FROM traces${whereSql}`).get(...params) as { n: number };
		const rows = this.db
			.prepare(`SELECT * FROM traces${whereSql} ORDER BY COALESCE(started_at, last_event_at) DESC LIMIT ? OFFSET ?`)
			.all(...params, filter.limit, filter.offset) as unknown as TraceRow[];
		return { rows, total: countRow.n };
	}

	/**
	 * 产品板块动态发现(R4:不硬编码)
	 *
	 * @returns 去重产品名(字典序)
	 */
	listProducts(): string[] {
		const rows = this.db.prepare("SELECT DISTINCT product FROM traces ORDER BY product").all() as unknown as Array<{
			product: string;
		}>;
		return rows.map((row) => row.product);
	}

	/**
	 * 项目下拉选项(列表页过滤表单;按板块过滤)
	 *
	 * @param product 板块(空 = 全部)
	 * @returns 去重项目 path(字典序,排除 NULL)
	 */
	listProjects(product?: string): string[] {
		const hasProduct = product !== undefined && product !== "";
		const sql = `SELECT DISTINCT project FROM traces WHERE project IS NOT NULL${hasProduct ? " AND product = ?" : ""} ORDER BY project`;
		const rows = (hasProduct ? this.db.prepare(sql).all(product) : this.db.prepare(sql).all()) as unknown as Array<{
			project: string;
		}>;
		return rows.map((row) => row.project);
	}

	/**
	 * 指标聚合用的轻量行(近 N 天 traces 全列拉取,聚合在内存纯函数中完成)
	 *
	 * 量级依据:每天几十~几百次评审 → 30 天上限万级行,内存聚合最简且便于单测;
	 * percentile 等计算无需 SQL 技巧。
	 *
	 * @param sinceMs 起始时刻(Unix 毫秒)
	 * @param product 板块(空 = 全部)
	 * @returns 满足条件的 trace 行(时间升序)
	 */
	listTracesSince(sinceMs: number, product?: string): TraceRow[] {
		const hasProduct = product !== undefined && product !== "";
		const sql = `SELECT * FROM traces WHERE COALESCE(started_at, last_event_at) >= ?${hasProduct ? " AND product = ?" : ""} ORDER BY COALESCE(started_at, last_event_at) ASC`;
		const rows = hasProduct ? this.db.prepare(sql).all(sinceMs, product) : this.db.prepare(sql).all(sinceMs);
		return rows as unknown as TraceRow[];
	}

	/**
	 * 读取当前 journal mode(单测断言 WAL 生效用)
	 *
	 * @returns journal mode 字符串(文件库应为 "wal")
	 */
	journalMode(): string {
		const row = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		return row.journal_mode;
	}

	/**
	 * 关闭底层数据库连接(单测清理用;服务进程整个生命周期持有,无需调用)
	 */
	close(): void {
		this.db.close();
	}
}
