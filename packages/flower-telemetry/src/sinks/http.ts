/**
 * httpSink:把归一化事件批量 NDJSON 推送到常驻观测服务(flower-observer)
 *
 * 定位:jsonlSink 的"网络孪生"——同一行格式(每事件一行 `JSON.stringify`),
 * 两种传输(文件 / HTTP),观测服务端用同一个解析器消费两种来源;
 * 事件信封自带 (traceId, seq),服务端按其幂等去重,本 sink 重发不会写重。
 *
 * 设计要点:
 * - 批量:缓冲达 `batchSize` 条立即发送;否则距上次发送超 `flushIntervalMs` 时由下一事件触发
 *   (不引入定时器,避免挂住进程退出;评审事件密集,尾部由 `flush()` 收口)
 * - 单 drain 循环:同一时刻最多一个 POST 在途(保序、简单),在途期间事件继续入缓冲
 * - 失败语义:整批放回缓冲头,等满一个间隔随下次触发重试(无进展即停,不热重试);
 *   缓冲超 `maxBufferedEvents` 丢最旧,绝不无限吃内存
 * - fail-open:发送失败默认静默(`DEBUG_TELEMETRY=1` 单行 warn),`AbortSignal.timeout`
 *   防观测服务抖动 hang 住,`onEvent` / `flush` 绝不抛错
 * - `stream` 事件不推送(纯显示信号,且 thinking/text delta 不脱敏,推出去会泄 secret)
 */

import type { TelemetryEvent, TelemetrySink } from "../types.js";

/** 批量发送阈值默认值(条) */
const DEFAULT_BATCH_SIZE = 50;
/** 距上次发送的触发间隔默认值(毫秒) */
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
/** 缓冲上限默认值(条,超出丢最旧) */
const DEFAULT_MAX_BUFFERED_EVENTS = 2000;
/** 单次 POST 超时默认值(毫秒,对齐 siemSink 的 2s 姿态) */
const DEFAULT_REQUEST_TIMEOUT_MS = 2000;

/**
 * 创建 HTTP 推送 sink 的选项
 */
export interface HttpSinkOptions {
	/** 观测服务 ingest 端点(完整 URL,语义对齐 SIEM_INGEST_URL,不额外拼路径) */
	url: string;
	/** Bearer 鉴权 token(可选;配置时请求附 `Authorization: Bearer <token>`) */
	token?: string;
	/** 批量发送阈值,缓冲达到即发送(默认 50) */
	batchSize?: number;
	/** 距上次发送超过该间隔时,下一事件触发发送(默认 2000ms) */
	flushIntervalMs?: number;
	/** 缓冲上限,超出丢最旧(默认 2000) */
	maxBufferedEvents?: number;
	/** 单次 POST 超时毫秒数(默认 2000) */
	requestTimeoutMs?: number;
}

/**
 * 创建 HTTP 推送 sink
 *
 * @param options 选项(url 必填,其余见各字段默认值)
 * @returns TelemetrySink 实例(非 critical,受 FLOWER_TELEMETRY 总开关控制)
 */
export function httpSink(options: HttpSinkOptions): TelemetrySink {
	const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
	const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
	const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

	/** 待发送的 NDJSON 行缓冲(入队即序列化,保证行格式与 jsonlSink 落盘逐字节一致) */
	const buffer: string[] = [];
	/** 当前 drain 循环(同一时刻最多一个,天然保序) */
	let draining: Promise<void> | undefined;
	/** flush 进行中标记(抑制 onEvent 再起 drain,避免与 flush 的直发并发竞争) */
	let flushing = false;
	/** 上次发送完成时刻(成败都更新:失败后等满一个间隔再试,避免对故障端点热重试) */
	let lastSendAt = Date.now();
	/** 累计丢弃条数(仅首次丢弃时 DEBUG 提示,避免刷屏) */
	let dropped = 0;

	/**
	 * 失败诊断输出(对齐 pipeline 的姿态:默认静默,DEBUG_TELEMETRY=1 才单行 warn)
	 */
	function warnFailure(detail: string): void {
		if (process.env.DEBUG_TELEMETRY === "1") {
			console.warn(`[telemetry] http 上报失败: ${detail}`);
		}
	}

	/**
	 * 缓冲限容:超上限丢最旧(观测数据可丢,内存不可涨)
	 */
	function trimOverflow(): void {
		while (buffer.length > maxBufferedEvents) {
			buffer.shift();
			dropped += 1;
			if (dropped === 1 && process.env.DEBUG_TELEMETRY === "1") {
				console.warn(`[telemetry] http 缓冲超上限(${maxBufferedEvents}),开始丢弃最旧事件`);
			}
		}
	}

	/**
	 * 失败批回灌缓冲头(它们仍是最旧的一批;回灌后超限照常丢最旧)
	 */
	function restore(batch: string[]): void {
		buffer.unshift(...batch);
		trimOverflow();
	}

	/**
	 * 发送一批(最多 batchSize 条):成功即从缓冲移除,失败整批放回等下次触发
	 */
	async function sendBatch(): Promise<void> {
		const batch = buffer.splice(0, batchSize);
		try {
			const response = await fetch(options.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-ndjson",
					...(options.token !== undefined && options.token !== "" ? { Authorization: `Bearer ${options.token}` } : {}),
				},
				body: `${batch.join("\n")}\n`,
				// 不要让观测服务抖动拖慢主流程
				signal: AbortSignal.timeout(requestTimeoutMs),
			});
			if (!response.ok) {
				restore(batch);
				warnFailure(`HTTP ${response.status}`);
			}
		} catch (err) {
			restore(batch);
			let msg = err instanceof Error ? err.message : String(err);
			const code = (err as { cause?: { code?: string } })?.cause?.code;
			if (code) msg += ` (${code})`;
			warnFailure(msg);
		} finally {
			lastSendAt = Date.now();
		}
	}

	/**
	 * 判断是否应当发送:达到批量阈值,或距上次发送超过触发间隔
	 */
	function shouldSend(): boolean {
		if (buffer.length === 0) return false;
		return buffer.length >= batchSize || Date.now() - lastSendAt >= flushIntervalMs;
	}

	/**
	 * 启动 drain 循环(已有在途循环或无需发送时为 no-op)
	 *
	 * 进度检查:一轮发送后缓冲未减少 = 整批失败回灌,立即停止等下次事件触发,
	 * 避免对故障端点的同步热重试循环。
	 */
	function kick(): void {
		if (flushing || draining !== undefined || !shouldSend()) return;
		draining = (async () => {
			try {
				while (shouldSend()) {
					const before = buffer.length;
					await sendBatch();
					if (buffer.length >= before) break;
				}
			} finally {
				draining = undefined;
			}
		})();
	}

	return {
		name: "http",
		onEvent(event: TelemetryEvent): void {
			if (event.kind === "stream") return;
			buffer.push(JSON.stringify(event));
			trimOverflow();
			kick();
		},
		async flush(): Promise<void> {
			// 抑制新 drain,等在途循环收尾后由 flush 独占直发(run 结束,不再有新事件)
			flushing = true;
			try {
				while (draining !== undefined) {
					await draining;
				}
				// 最后一搏:剩余缓冲逐批直发;无进展(失败回灌)即放弃 —— fail-open
				while (buffer.length > 0) {
					const before = buffer.length;
					await sendBatch();
					if (buffer.length >= before) break;
				}
			} finally {
				flushing = false;
			}
		},
	};
}
