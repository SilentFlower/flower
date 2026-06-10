/**
 * jsonlSink:把归一化事件按行追加写入本地 JSONL 文件
 *
 * 用途:CI artifact 持久化(评审质量分析 / 回放评估的数据基座)。
 *
 * 设计要点:
 * - 每事件一行 `JSON.stringify`,append-only(进程崩溃也能保留已写部分,残缺 trace 仍有分析价值)
 * - `stream` 事件不落盘(纯显示信号,且 delta 量大)
 * - fail-open:首次写失败后**整体停写**(磁盘 / 路径问题不会每事件重试刷错),默认静默,
 *   `DEBUG_TELEMETRY=1` 时 warn 一次
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TelemetryEvent, TelemetrySink } from "../types.js";

/**
 * 创建 JSONL 文件 sink
 *
 * @param path JSONL 输出文件路径(父目录不存在时自动创建)
 * @returns TelemetrySink 实例(非 critical,受 FLOWER_TELEMETRY 总开关控制)
 */
export function jsonlSink(path: string): TelemetrySink {
	// 首次写失败后置 true,后续事件直接跳过(避免坏路径上每事件都撞一次 IO 错误)
	let broken = false;
	let dirReady = false;

	return {
		name: "jsonl",
		onEvent(event: TelemetryEvent): void {
			if (broken || event.kind === "stream") return;
			try {
				if (!dirReady) {
					mkdirSync(dirname(path), { recursive: true });
					dirReady = true;
				}
				appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
			} catch (err) {
				broken = true;
				if (process.env.DEBUG_TELEMETRY === "1") {
					console.warn(`[telemetry] jsonl 写入失败,本次 run 停止落盘(${path}):`, err);
				}
			}
		},
	};
}
