/**
 * 合规 + 审计扩展
 *
 * 两个产品都加载本扩展,只是模式不同:
 * - code-reviewer:`ci-readonly` 模式(禁所有写,bash 走白名单)
 * - ops-bot:`production-readonly` 模式(本身工具就只读,只做审计)
 *
 * 本扩展只做"事件级别"的合规与审计,具体业务规则(如 ARMS project 白名单)
 * 应在各产品自己的扩展里实现。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendAudit } from "./audit.js";

export { sendAudit } from "./audit.js";

/**
 * 合规模式
 *
 * - `ci-readonly`:CI 环境,禁止任何写操作,bash 限白名单
 * - `production-readonly`:线上服务,所有工具应已只读,只做审计
 */
export type ComplianceMode = "ci-readonly" | "production-readonly";

/**
 * 注册合规与审计扩展
 *
 * @param pi - pi 扩展 API
 * @param options - 选项
 * @param options.mode - 合规模式
 * @param options.product - 产品名,审计字段里会带上,便于 SIEM 区分
 */
export function registerCompliance(pi: ExtensionAPI, options: { mode: ComplianceMode; product: string }): void {
	const { mode, product } = options;

	// CI 模式:拦截危险工具
	if (mode === "ci-readonly") {
		registerCiReadOnlyGuards(pi);
	}

	// 不管哪个模式,都开启审计
	registerAudit(pi, product);
}

/**
 * CI 只读模式的拦截规则
 *
 * - write / edit 工具完全禁用
 * - bash 只允许白名单内的子命令
 */
function registerCiReadOnlyGuards(pi: ExtensionAPI): void {
	const bashAllowList = /^(git|grep|find|ls|cat|head|tail|wc|file|sed|awk)\b/;

	pi.on("tool_call", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			return { block: true, reason: "CI 只读模式:禁止使用 write / edit 工具" };
		}
		if (event.toolName === "bash") {
			const cmd = String(event.input.command ?? "").trim();
			const firstWord = cmd.split(/\s+/)[0] ?? "";
			if (!bashAllowList.test(cmd)) {
				return {
					block: true,
					reason: `CI 只读模式:bash 命令 "${firstWord}" 不在白名单内`,
				};
			}
		}
		return undefined;
	});
}

/**
 * 注册审计事件
 *
 * 所有 tool_call / tool_result / session_start 都会异步推送到自定义 SIEM 端点。
 * 失败不会影响主流程。
 */
function registerAudit(pi: ExtensionAPI, product: string): void {
	pi.on("session_start", async (event) => {
		void sendAudit({
			kind: "session_start",
			product,
			reason: event.reason,
			ts: Date.now(),
		});
	});

	pi.on("tool_call", async (event) => {
		void sendAudit({
			kind: "tool_call",
			product,
			tool: event.toolName,
			// 故意不上报 input 全量(可能含敏感数据),只上报字段名
			inputKeys: Object.keys(event.input ?? {}),
			ts: Date.now(),
		});
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		void sendAudit({
			kind: "tool_result",
			product,
			tool: event.toolName,
			isError: event.isError,
			ts: Date.now(),
		});
		return undefined;
	});
}
