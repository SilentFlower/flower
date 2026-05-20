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

/**
 * 注册评审可视化扩展。
 *
 * 监听事件:
 * - `turn_start` / `turn_end`:每轮 LLM 调用边界
 * - `message_update`:LLM 流式输出(thinking / text / toolcall)
 * - `tool_execution_end`:工具实际执行结果
 * - `after_provider_response`:LLM 网关 HTTP 状态(异常时提示)
 * - `agent_end`:整个 agent session 结束
 *
 * @param pi pi-coding-agent ExtensionAPI
 */
export function registerObservability(pi: ExtensionAPI): void {
	if (isOff()) {
		return;
	}

	pi.on("turn_start", async (event) => {
		console.log(`\n>>> 🤖 [turn ${event.turnIndex}] start`);
	});

	pi.on("message_update", async (event) => {
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
				console.log(`\n🔧 [tool →] ${ev.toolCall.name}  args=${truncate(ev.toolCall.arguments)}`);
				break;
			default:
				// 其他子类型(start / toolcall_start / toolcall_delta / done / error)不打印
				break;
		}
	});

	pi.on("tool_execution_end", async (event) => {
		const tag = event.isError ? "🔧 [tool ✗ error]" : "🔧 [tool ←]";
		console.log(`${tag} ${event.toolName}  result=${truncate(event.result, 300)}`);
	});

	pi.on("after_provider_response", async (event) => {
		if (event.status >= 400) {
			console.log(`⚠️ [llm provider] status=${event.status}`);
		}
	});

	pi.on("turn_end", async (event) => {
		console.log(`>>> 🤖 [turn ${event.turnIndex}] end · toolResults=${event.toolResults.length}\n`);
	});

	pi.on("agent_end", async () => {
		console.log("\n>>> 🤖 [agent] session end\n");
	});
}
