/**
 * siemSink:metadata-only 安全审计上报(原 flower-compliance/src/audit.ts 迁入)
 *
 * 内容策略(不可放宽):**只上报元数据,绝不上报工具入参 / 结果的值**。
 * payload 字段与旧 `sendAudit` 完全兼容(kind / product / tool / inputKeys / isError / ts / user / host),
 * SIEM 端无需区分新旧格式;新增 `tool_blocked` kind 修复"拦截事件漏审计"缺陷。
 *
 * 行为约定(对齐 compliance backend spec error-handling.md / logging-guidelines.md):
 * - `SIEM_INGEST_URL` 未配置 = 跳过上报;`DEBUG_AUDIT=1` 时把记录打到控制台
 * - fail-open:fetch 失败默认静默(`DEBUG_AUDIT=1` 才单行 warn),不重试,不向上抛
 * - `AbortSignal.timeout(2000)`:SIEM 抖动不拖慢主流程
 * - critical sink:不受 `FLOWER_TELEMETRY=0` 总开关影响(审计"不可关"属性)
 */

import type { TelemetryEvent, TelemetrySink } from "../types.js";

/**
 * 审计记录(开放结构,kind 区分类型;字段与旧 flower-compliance sendAudit 兼容)
 */
export interface AuditRecord {
	kind: string;
	product: string;
	ts: number;
	[key: string]: unknown;
}

/**
 * 创建 SIEM 审计 sink 的选项
 */
export interface SiemSinkOptions {
	/** 审计端点 URL;缺省时每事件读 `SIEM_INGEST_URL` 环境变量(保持旧 sendAudit 的运行期读取语义) */
	url?: string;
}

/**
 * 归一化事件 → metadata-only 审计记录投影
 *
 * 只投影四类事件,其余(stream / turn / agent / llm_call span / 业务 outcome)与审计无关,返回 undefined:
 * - `trace_start` → `session_start`(兼容旧 payload)
 * - `span(tool_call)` → `tool_call`(只取 inputKeys,**丢弃 input 值**)
 * - `span(tool_result)` → `tool_result`(只取 isError)
 * - `outcome(security_block)` → `tool_blocked`(新增 kind;修复拦截漏报缺陷)
 *
 * @param event 归一化事件
 * @returns 审计记录;无需上报的事件返回 undefined
 */
export function projectAuditRecord(event: TelemetryEvent): AuditRecord | undefined {
	if (event.kind === "trace_start") {
		return { kind: "session_start", product: event.product, reason: event.reason, ts: event.ts };
	}
	if (event.kind === "span" && event.spanType === "tool_call") {
		return {
			kind: "tool_call",
			product: event.product,
			tool: event.tool,
			// 故意不投影 input 值(可能含敏感数据),只上报字段名 — 与旧 sendAudit 行为一致
			inputKeys: event.inputKeys ?? [],
			ts: event.ts,
		};
	}
	if (event.kind === "span" && event.spanType === "tool_result") {
		return { kind: "tool_result", product: event.product, tool: event.tool, isError: event.isError, ts: event.ts };
	}
	if (event.kind === "outcome" && event.outcomeType === "security_block" && event.securityBlock !== undefined) {
		return {
			kind: "tool_blocked",
			product: event.product,
			tool: event.securityBlock.tool,
			mode: event.securityBlock.mode,
			// reason 是策略文案(含命令首词,不含完整入参),且已被 pipeline 脱敏
			reason: event.securityBlock.reason,
			ts: event.ts,
		};
	}
	return undefined;
}

/**
 * 创建 SIEM 审计 sink
 *
 * @param options 选项(url 缺省走 `SIEM_INGEST_URL` 环境变量)
 * @returns TelemetrySink 实例(critical=true,不受总开关影响)
 */
export function siemSink(options: SiemSinkOptions = {}): TelemetrySink {
	// 在途上报集合:flush 时等待收尾,避免 run 结束进程退出丢失最后几条审计
	const inflight = new Set<Promise<void>>();

	return {
		name: "siem",
		critical: true,
		onEvent(event: TelemetryEvent): void {
			const record = projectAuditRecord(event);
			if (record === undefined) return;
			// fire-and-forget:绝不阻塞 emit 调用方(对齐旧 `void sendAudit(...)` 用法)
			const task = sendAudit(record, options.url).finally(() => {
				inflight.delete(task);
			});
			inflight.add(task);
		},
		async flush(): Promise<void> {
			await Promise.allSettled([...inflight]);
		},
	};
}

/**
 * 异步发送审计记录(原 flower-compliance `sendAudit` 迁入,行为不变)
 *
 * @param record 审计记录
 * @param fixedUrl 固定端点;缺省时读 `SIEM_INGEST_URL` 环境变量
 */
export async function sendAudit(record: AuditRecord, fixedUrl?: string): Promise<void> {
	const url = fixedUrl !== undefined && fixedUrl !== "" ? fixedUrl : process.env.SIEM_INGEST_URL;
	if (!url) {
		// 没配置就什么都不做,但保留 hook 以便本地调试可以打开
		if (process.env.DEBUG_AUDIT === "1") {
			console.log("[audit]", JSON.stringify(record));
		}
		return;
	}

	try {
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...record,
				user: process.env.USER ?? process.env.USERNAME ?? "unknown",
				host: process.env.HOSTNAME ?? "unknown",
			}),
			// 不要让审计失败拖慢主流程
			signal: AbortSignal.timeout(2000),
		});
	} catch (err) {
		// 默认静默:audit 是 fail-open 设计,失败不影响主流程,SIEM 不可达时不刷屏 GitLab CI 日志。
		// 调试场景设 DEBUG_AUDIT=1 才打单行 warn。
		if (process.env.DEBUG_AUDIT === "1") {
			let msg = err instanceof Error ? err.message : String(err);
			const code = (err as { cause?: { code?: string } })?.cause?.code;
			if (code) msg += ` (${code})`;
			console.warn(`[audit] 上报失败: ${msg}`);
		}
	}
}
