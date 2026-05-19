/**
 * 阿里云 ARMS / SLS 工具集
 *
 * 仅供 ops-bot 加载,code-reviewer 不应该看监控。
 *
 * 设计原则:
 * 1. **全部只读**——绝不暴露写 / 删 / 改的 API
 * 2. **结果脱敏**——日志原文可能含 PII,在返回前就脱敏
 * 3. **可观测**——每次工具调用都通过 pi-compliance 上报到审计
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { maskSensitive } from "./mask.js";

export { maskSensitive };

/**
 * SLS 日志查询
 *
 * @remarks 真实实现需要使用 @alicloud/sls20201230 或 SLS HTTP API。
 */
export const armsQueryLogsTool = defineTool({
	name: "arms_query_logs",
	label: "ARMS 日志查询",
	description:
		"在阿里云 SLS 中查询日志。支持 SLS 查询语法,例如 'level:ERROR | select count(*)'",
	parameters: Type.Object({
		project: Type.String({ description: "SLS project 名,例如 'prod-app'" }),
		logstore: Type.String({ description: "logstore 名" }),
		query: Type.String({ description: "SLS 查询语句" }),
		from: Type.String({
			description: "起始时间,ISO 字符串或相对时间('1h ago' / '15m ago')",
		}),
		to: Type.Optional(
			Type.String({ description: "结束时间,默认 'now'" }),
		),
		limit: Type.Optional(
			Type.Number({ description: "返回行数上限,默认 100" }),
		),
	}),
	async execute(_id, params, _signal) {
		// TODO: 接入阿里云 SLS SDK
		// const client = new SLS20201230(process.env.ALICLOUD_AK!, process.env.ALICLOUD_SK!);
		// const result = await client.getLogs({ ... });
		const stub = `[Stub] arms_query_logs\n  project=${params.project}\n  logstore=${params.logstore}\n  query=${params.query}\n  from=${params.from}`;
		return {
			content: [{ type: "text", text: maskSensitive(stub) }],
			details: { total: 0 },
		};
	},
});

/**
 * ARMS APM 指标查询
 */
export const armsQueryMetricsTool = defineTool({
	name: "arms_query_metrics",
	label: "ARMS 指标查询",
	description: "查询 ARMS APM 指标(QPS / RT / 错误率 / 慢调用数)",
	parameters: Type.Object({
		app: Type.String({ description: "ARMS 中的应用名" }),
		metric: Type.Union([
			Type.Literal("qps"),
			Type.Literal("rt"),
			Type.Literal("error_rate"),
			Type.Literal("slow_call_count"),
		]),
		from: Type.String({ description: "起始时间" }),
		to: Type.Optional(Type.String({ description: "结束时间,默认 'now'" })),
	}),
	async execute(_id, params) {
		// TODO: 接入 ARMS OpenAPI
		return {
			content: [
				{
					type: "text",
					text: `[Stub] arms_query_metrics\n  app=${params.app}\n  metric=${params.metric}`,
				},
			],
		};
	},
});

/**
 * 列出活跃告警
 */
export const armsListAlertsTool = defineTool({
	name: "arms_list_alerts",
	label: "ARMS 告警列表",
	description: "列出当前活跃告警",
	parameters: Type.Object({
		severity: Type.Optional(
			Type.Union([
				Type.Literal("critical"),
				Type.Literal("warning"),
				Type.Literal("info"),
			]),
		),
		app: Type.Optional(Type.String({ description: "限定应用名" })),
	}),
	async execute(_id, params) {
		// TODO: 接入 ARMS 告警 API
		return {
			content: [
				{
					type: "text",
					text: `[Stub] arms_list_alerts severity=${params.severity ?? "all"} app=${params.app ?? "all"}`,
				},
			],
		};
	},
});

/**
 * 根据 traceId 查调用链
 */
export const armsGetTraceTool = defineTool({
	name: "arms_get_trace",
	label: "ARMS 调用链查询",
	description: "根据 traceId 查询完整调用链",
	parameters: Type.Object({
		traceId: Type.String({ description: "trace ID" }),
	}),
	async execute(_id, params) {
		// TODO: 接入 ARMS Trace API
		return {
			content: [
				{ type: "text", text: `[Stub] arms_get_trace traceId=${params.traceId}` },
			],
		};
	},
});

/**
 * 一次性注册所有 ARMS 工具
 */
// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI 类型在不同入口下细节略有不同
export function registerArmsTools(pi: { registerTool: (def: any) => void }): void {
	pi.registerTool(armsQueryLogsTool);
	pi.registerTool(armsQueryMetricsTool);
	pi.registerTool(armsListAlertsTool);
	pi.registerTool(armsGetTraceTool);
}
