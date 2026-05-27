/**
 * pi-coding-agent 评审过程可视化
 *
 * 监听核心生命周期事件,把 LLM 的「思考 / 文本输出 / 工具调用 / 工具结果」
 * 流式打印到 stdout(GitLab CI job 日志),让业务方在 pipeline trace 里
 * 看到完整评审轨迹。
 *
 * 设计要点:
 * - 默认开,避免业务方手动开关;`FLOWER_VERBOSE=0`(或 false/off/no)显式关
 * - 纯监听,不阻塞主流程(回调内部 await 异常会被 pi 吃掉)
 * - tool input / result 截断 400 字符,防 GitLab CI 日志爆炸 + 敏感内容泄漏
 *   (大文件 / 长 diff 等已由 safeReadFile 在工具层截断,此处再加一层防御)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRUNC_DEFAULT = 400;
const VERBOSE_OFF = new Set(["0", "false", "off", "no", ""]);

interface TurnTiming {
	startMs: number;
	firstLlmEventMs?: number;
	firstToolCallMs?: number;
	toolCount: number;
	toolTotalMs: number;
}

interface ToolTiming {
	startMs: number;
	turnKey?: string;
}

/**
 * 判断是否关闭 verbose 输出。
 * 默认开;只有 FLOWER_VERBOSE 显式设为 0/false/off/no 才关。
 * 未设 env(undefined)= 开。
 */
function isOff(): boolean {
	const raw = process.env.FLOWER_VERBOSE;
	if (raw === undefined) return false; // 未设 → 开
	return VERBOSE_OFF.has(raw.toLowerCase());
}

/**
 * 把任意值序列化 + 长度截断,避免 GitLab CI 日志被单条工具调用刷屏。
 *
 * @param value 待打印的工具 input / result
 * @param max  最大字符数,超出截断 + 标注 omitted 长度
 */
function truncate(value: unknown, max = TRUNC_DEFAULT): string {
	let str: string;
	if (typeof value === "string") {
		str = value;
	} else {
		try {
			str = JSON.stringify(value);
		} catch {
			str = String(value);
		}
	}
	if (str.length <= max) return str;
	return `${str.slice(0, max)} …<+${str.length - max} chars>`;
}

function nowMs(): number {
	return Date.now();
}

function formatMs(value: number | undefined): string {
	if (value === undefined) return "n/a";
	return String(Math.max(0, Math.round(value)));
}

function elapsedFrom(startMs: number): number {
	return Math.max(0, Math.round(nowMs() - startMs));
}

function makeTurnKey(agentAttempt: number, turnIndex: number): string {
	return `${agentAttempt}:${turnIndex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function findLastAssistantMessage(messages: unknown[]): Record<string, unknown> | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isRecord(message) && message.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

function formatUsage(usage: unknown): string {
	if (!isRecord(usage)) return "";
	const input = typeof usage.input === "number" ? usage.input : undefined;
	const output = typeof usage.output === "number" ? usage.output : undefined;
	const total = typeof usage.total === "number" ? usage.total : undefined;
	if (input === undefined && output === undefined && total === undefined) return "";
	return ` · usage_input=${input ?? "n/a"} · usage_output=${output ?? "n/a"} · usage_total=${total ?? "n/a"}`;
}

/**
 * 注册评审可视化扩展。
 *
 * 监听事件:
 * - `agent_start` / `agent_end`:每次 agent attempt 边界与最终 stopReason
 * - `turn_start` / `turn_end`:每轮 LLM 调用边界
 * - `message_update`:LLM 流式输出(thinking / text / toolcall)
 * - `tool_execution_start` / `tool_execution_end`:工具实际执行耗时与结果
 * - `after_provider_response`:LLM 网关 HTTP 状态(异常时提示)
 *
 * @param pi pi-coding-agent ExtensionAPI
 */
export function registerObservability(pi: ExtensionAPI): void {
	if (isOff()) {
		return;
	}

	let agentAttempt = 0;
	let agentStartMs: number | undefined;
	let activeTurnKey: string | undefined;
	const turnTimings = new Map<string, TurnTiming>();
	const toolTimings = new Map<string, ToolTiming>();

	const ensureAgentAttempt = (): number => {
		if (agentAttempt === 0) {
			agentAttempt = 1;
			agentStartMs = nowMs();
		}
		return agentAttempt;
	};

	const markFirstLlmEvent = (): void => {
		if (activeTurnKey === undefined) return;
		const timing = turnTimings.get(activeTurnKey);
		if (timing !== undefined && timing.firstLlmEventMs === undefined) {
			timing.firstLlmEventMs = nowMs();
		}
	};

	pi.on("agent_start", async () => {
		agentAttempt += 1;
		agentStartMs = nowMs();
		activeTurnKey = undefined;
		turnTimings.clear();
		toolTimings.clear();
		console.log(`\n>>> 🤖 [agent] session start · attempt=${agentAttempt}`);
	});

	pi.on("turn_start", async (event) => {
		const attempt = ensureAgentAttempt();
		const turnKey = makeTurnKey(attempt, event.turnIndex);
		activeTurnKey = turnKey;
		turnTimings.set(turnKey, {
			startMs: event.timestamp,
			toolCount: 0,
			toolTotalMs: 0,
		});
		console.log(`\n>>> 🤖 [turn ${event.turnIndex}] start · agent_attempt=${attempt}`);
	});

	pi.on("message_update", async (event) => {
		markFirstLlmEvent();
		const ev = event.assistantMessageEvent;
		switch (ev.type) {
			case "thinking_start":
				process.stdout.write("\n💭 thinking: ");
				break;
			case "thinking_delta":
				process.stdout.write(ev.delta);
				break;
			case "thinking_end":
				process.stdout.write("\n");
				break;
			case "text_start":
				process.stdout.write("\n💬 assistant: ");
				break;
			case "text_delta":
				process.stdout.write(ev.delta);
				break;
			case "text_end":
				process.stdout.write("\n");
				break;
			case "toolcall_end":
				if (activeTurnKey !== undefined) {
					const timing = turnTimings.get(activeTurnKey);
					if (timing !== undefined && timing.firstToolCallMs === undefined) {
						timing.firstToolCallMs = nowMs();
					}
				}
				console.log(`\n🔧 [tool →] ${ev.toolCall.name}  args=${truncate(ev.toolCall.arguments)}`);
				break;
			default:
				// 其他子类型(start / toolcall_start / toolcall_delta / done / error)不打印
				break;
		}
	});

	pi.on("tool_execution_start", async (event) => {
		toolTimings.set(event.toolCallId, {
			startMs: nowMs(),
			...(activeTurnKey !== undefined ? { turnKey: activeTurnKey } : {}),
		});
	});

	pi.on("tool_execution_end", async (event) => {
		const tag = event.isError ? "🔧 [tool ✗ error]" : "🔧 [tool ←]";
		const timing = toolTimings.get(event.toolCallId);
		const durationMs = timing !== undefined ? elapsedFrom(timing.startMs) : undefined;
		if (timing?.turnKey !== undefined) {
			const turn = turnTimings.get(timing.turnKey);
			if (turn !== undefined) {
				turn.toolCount += 1;
				turn.toolTotalMs += durationMs ?? 0;
			}
		}
		toolTimings.delete(event.toolCallId);
		console.log(`${tag} ${event.toolName} · duration_ms=${formatMs(durationMs)}  result=${truncate(event.result, 300)}`);
	});

	pi.on("after_provider_response", async (event) => {
		if (event.status >= 400) {
			console.log(`⚠️ [llm provider] status=${event.status}`);
		}
	});

	pi.on("turn_end", async (event) => {
		const attempt = ensureAgentAttempt();
		const turnKey = makeTurnKey(attempt, event.turnIndex);
		const timing = turnTimings.get(turnKey);
		const durationMs = timing !== undefined ? elapsedFrom(timing.startMs) : undefined;
		const firstLlmEventMs =
			timing?.firstLlmEventMs !== undefined && timing !== undefined ? timing.firstLlmEventMs - timing.startMs : undefined;
		const firstToolCallMs =
			timing?.firstToolCallMs !== undefined && timing !== undefined ? timing.firstToolCallMs - timing.startMs : undefined;
		console.log(
			`>>> 🤖 [turn ${event.turnIndex}] end · agent_attempt=${attempt} · duration_ms=${formatMs(durationMs)} · first_llm_event_ms=${formatMs(firstLlmEventMs)} · first_tool_call_ms=${formatMs(firstToolCallMs)} · toolResults=${event.toolResults.length} · tools=${timing?.toolCount ?? 0} · tool_total_ms=${formatMs(timing?.toolTotalMs)}\n`,
		);
		turnTimings.delete(turnKey);
		if (activeTurnKey === turnKey) {
			activeTurnKey = undefined;
		}
	});

	pi.on("agent_end", async (event) => {
		const attempt = ensureAgentAttempt();
		const durationMs = agentStartMs !== undefined ? elapsedFrom(agentStartMs) : undefined;
		const lastAssistant = findLastAssistantMessage(event.messages);
		const stopReason = typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : "unknown";
		const errorMessage = typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : undefined;
		const usage = formatUsage(lastAssistant?.usage);
		const errorPart = errorMessage !== undefined ? ` · error=${truncate(errorMessage, 300)}` : "";
		console.log(
			`\n>>> 🤖 [agent] session end · attempt=${attempt} · duration_ms=${formatMs(durationMs)} · stop_reason=${stopReason}${usage}${errorPart}\n`,
		);
	});
}
