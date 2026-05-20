/**
 * 审计上报
 *
 * 当前实现是把审计记录发到 `SIEM_INGEST_URL`(如已配置)。
 * 失败时只 console.warn,绝不影响主流程。
 */

/**
 * 审计记录
 *
 * 字段是开放结构,kind 用于区分类型。
 */
export interface AuditRecord {
	kind: string;
	product: string;
	ts: number;
	[key: string]: unknown;
}

/**
 * 异步发送审计记录
 *
 * @param record - 审计记录
 */
export async function sendAudit(record: AuditRecord): Promise<void> {
	const url = process.env.SIEM_INGEST_URL;
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
		// 单行 warn,避免 fetch failed 多层 cause + stack 刷屏 GitLab CI 日志
		let msg = err instanceof Error ? err.message : String(err);
		const code = (err as { cause?: { code?: string } })?.cause?.code;
		if (code) msg += ` (${code})`;
		console.warn(`[audit] 上报失败: ${msg}`);
	}
}
