/**
 * TelemetryPipeline:归一化事件的统一出口
 *
 * 职责(也是全仓唯一的 enforcement 点):
 * 1. 注入信封字段(traceId / product / seq / ts)
 * 2. 对敏感字段统一脱敏 + 截断(span.input / span.result / toolcall_ready 预览等)
 * 3. fanout 到全部 sink,单 sink 故障不影响其余 sink 与主流程(fail-open)
 * 4. `FLOWER_TELEMETRY=0` 总开关只屏蔽非 critical sink(siemSink 等审计通道不可关)
 *
 * 错误处理对齐 compliance backend spec:默认静默,`DEBUG_TELEMETRY=1` 才打单行 warn。
 */

import { redactText, truncateText } from "./redact.js";
import type { TelemetryEvent, TelemetryEventInput, TelemetrySink } from "./types.js";

/** 单字段最大保留字符数(JSONL 落盘上限;console 显示层另有更紧的截断) */
const MAX_FIELD_CHARS = 4000;

/** 总开关识别为"关"的取值(与 FLOWER_VERBOSE 的关闭语义一致) */
const TELEMETRY_OFF = new Set(["0", "false", "off", "no"]);

/**
 * 构造 TelemetryPipeline 的选项
 */
export interface TelemetryPipelineOptions {
	/** 一次 run 的唯一 id */
	traceId: string;
	/** 产品名("code-reviewer" / "ops-bot") */
	product: string;
	/** 事件消费方列表 */
	sinks: TelemetrySink[];
}

/**
 * 判断总开关是否关闭(默认开;仅 `FLOWER_TELEMETRY` 显式设为 0/false/off/no 时关)
 */
function isTelemetryOff(): boolean {
	const raw = process.env.FLOWER_TELEMETRY;
	if (raw === undefined) return false;
	return TELEMETRY_OFF.has(raw.toLowerCase());
}

/**
 * 调试模式下打印 sink 故障(默认静默,避免 SIEM / 磁盘抖动刷屏 CI 日志)
 */
function warnSinkFailure(sinkName: string, err: unknown): void {
	if (process.env.DEBUG_TELEMETRY === "1") {
		console.warn(`[telemetry] sink "${sinkName}" 处理失败:`, err);
	}
}

/**
 * 归一化事件管道
 *
 * 一次 run 持有一个实例(模块级单例由产品侧装配层维护,与 review-trace 的单例模式一致)。
 */
export class TelemetryPipeline {
	private readonly traceId: string;
	private readonly product: string;
	private readonly sinks: TelemetrySink[];
	private seq = 0;

	/**
	 * @param options 管道选项(traceId / product / sinks)
	 */
	constructor(options: TelemetryPipelineOptions) {
		this.traceId = options.traceId;
		this.product = options.product;
		// 总开关在构造时求值一次:关闭时只保留 critical sink(审计通道不可关)
		this.sinks = isTelemetryOff() ? options.sinks.filter((s) => s.critical === true) : options.sinks;
	}

	/**
	 * 发出一条事件:注入信封字段 → 脱敏截断 → fanout
	 *
	 * 本方法**绝不抛错**(观测通道不反向阻塞主流程)。
	 *
	 * @param input 事件载荷(不含信封字段)
	 */
	emit(input: TelemetryEventInput): void {
		try {
			this.seq += 1;
			const event = this.sanitize({
				...input,
				traceId: this.traceId,
				product: this.product,
				seq: this.seq,
				ts: Date.now(),
			} as TelemetryEvent);
			for (const sink of this.sinks) {
				try {
					sink.onEvent(event);
				} catch (err) {
					warnSinkFailure(sink.name, err);
				}
			}
		} catch (err) {
			warnSinkFailure("(pipeline)", err);
		}
	}

	/**
	 * 冲刷全部 sink 缓冲(run 结束时调用一次)
	 *
	 * 单 sink flush 失败不影响其余 sink,整体不抛错。
	 */
	async flush(): Promise<void> {
		await Promise.allSettled(
			this.sinks.map(async (sink) => {
				try {
					await sink.flush?.();
				} catch (err) {
					warnSinkFailure(sink.name, err);
				}
			}),
		);
	}

	/**
	 * 对敏感字段统一脱敏 + 截断
	 *
	 * 覆盖字段(与 types.ts 的"已脱敏"注释一一对应):
	 * - `span.input` / `span.result`(工具 IO)
	 * - `span.agent.errorMessage`(LLM 错误信息可能回显请求内容)
	 * - `stream(toolcall_ready).delta`(完整入参预览;纯增量 delta 不处理,见 types.ts 说明)
	 * - `outcome.securityBlock.command` / `.reason`(拦截 reason 内嵌原始命令)
	 */
	private sanitize(event: TelemetryEvent): TelemetryEvent {
		if (event.kind === "span") {
			return {
				...event,
				...(event.input !== undefined ? { input: safeField(event.input) } : {}),
				...(event.result !== undefined ? { result: safeField(event.result) } : {}),
				...(event.agent?.errorMessage !== undefined
					? { agent: { ...event.agent, errorMessage: safeField(event.agent.errorMessage) } }
					: {}),
			};
		}
		if (event.kind === "stream" && event.streamType === "toolcall_ready" && event.delta !== undefined) {
			return { ...event, delta: safeField(event.delta) };
		}
		if (event.kind === "outcome" && event.securityBlock !== undefined) {
			return {
				...event,
				securityBlock: {
					...event.securityBlock,
					reason: safeField(event.securityBlock.reason),
					...(event.securityBlock.command !== undefined ? { command: safeField(event.securityBlock.command) } : {}),
				},
			};
		}
		return event;
	}
}

/**
 * 单字段安全化:脱敏 → 截断(顺序不可换,截断可能把 secret 切半逃过正则)
 */
function safeField(text: string): string {
	return truncateText(redactText(text), MAX_FIELD_CHARS);
}
