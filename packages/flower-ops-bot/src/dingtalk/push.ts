/**
 * 流式推送回钉钉
 *
 * 钉钉机器人 sessionWebhook 是单次有效 5 分钟的 URL,
 * 可以多次 POST 同一个 sessionWebhook,每次都把累积的全文发出去。
 *
 * 这里做了简单节流(500ms),避免 LLM 流式输出太快被钉钉限流。
 */

/**
 * 推送消息到钉钉
 *
 * @param sessionWebhook - 钉钉传来的 sessionWebhook URL
 * @param text - 当前累积的全文(注意:不是 delta,是全量)
 * @param isFinal - 是否最后一次推送
 */
export async function pushToSession(sessionWebhook: string, text: string, isFinal: boolean): Promise<void> {
	// 节流:非 final 的推送有最小间隔
	if (!isFinal) {
		const now = Date.now();
		const last = lastPushAt.get(sessionWebhook) ?? 0;
		if (now - last < 500) return;
		lastPushAt.set(sessionWebhook, now);
	} else {
		// final 一定要推
		lastPushAt.delete(sessionWebhook);
	}

	try {
		await fetch(sessionWebhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				msgtype: "markdown",
				markdown: { title: "Ops Bot", text },
			}),
			signal: AbortSignal.timeout(5000),
		});
	} catch (err) {
		console.warn("[ops-bot] 推送钉钉失败:", err);
	}
}

/** sessionWebhook -> 最近一次推送时间 */
const lastPushAt = new Map<string, number>();
