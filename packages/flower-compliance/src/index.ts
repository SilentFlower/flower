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
 * CI 只读模式的 bash 命令白名单
 *
 * 收录原则:
 * - 纯只读(不改文件 / 系统状态)
 * - 无副作用(不发起网络请求 / 不执行命令链 / 不安装包)
 * - 不泄漏未 masked secret(尤其排除 `env` / `printenv`)
 *
 * 不放行的高危命令归类(参见 `SUGGESTION_BY_CMD`):
 * - 泄漏 secret:`env` / `printenv`(即便 GitLab 会 mask,仍 defense-in-depth 拦截)
 * - 网络外发:`curl` / `wget` / `nc`
 * - 写文件:`tee` / `mv` / `rm` / `mkdir` / `touch` / `cp`
 * - 命令链 / 执行:`xargs` / `bash` / `sh` / `eval` / `source`
 * - 包管理:`npm` / `pip` / `apt` / `yum`
 * - 权限:`chmod` / `chown`
 *
 * Modern unix(`rg`)需要在 reviewer Dockerfile `apk add ripgrep` 才能跑通。
 */
const BASH_ALLOW_LIST =
	/^(git|grep|rg|find|ls|cat|head|tail|nl|wc|file|sed|awk|sort|uniq|tr|column|diff|comm|printf|echo|basename|dirname|realpath|pwd|date|which|type|command)\b/;

type BashChainSeparator = ";" | "&&" | "&" | "||" | "|";

interface BashCommandSegment {
	segment: string;
	separatorBefore?: BashChainSeparator;
}

/**
 * 高危命令拦截时附带的替代建议(供 LLM 在下一轮 turn 主动改用对的工具)
 *
 * LLM 拿到带建议的拦截 reason 比"不在白名单内"更易复原 — 减少反复试错带来的 trace 噪音。
 */
const SUGGESTION_BY_CMD: Record<string, string> = {
	env: "想看 MR 元数据 → 用 `gitlab_get_mr_files` / `gitlab_get_mr_diff`;查 env 不可,可能泄漏 secret",
	printenv: "同 env,不可放行(可能泄漏 secret)",
	curl: "想拉文件 → `gitlab_get_file_content`;禁止网络外发",
	wget: "同 curl,禁止网络外发",
	nc: "禁止网络外发",
	tee: "禁止写文件;只读评审场景不需要落盘",
	mv: "禁止写文件",
	rm: "禁止写文件",
	cp: "禁止写文件",
	mkdir: "禁止写文件系统",
	touch: "禁止写文件系统",
	npm: "禁止安装/执行包管理工具",
	pip: "同 npm,禁止包管理",
	apt: "同 npm,禁止包管理",
	yum: "同 npm,禁止包管理",
	chmod: "禁止改文件权限",
	chown: "禁止改文件 owner",
	bash: "禁止嵌套 shell;评审场景仅放行白名单内的具体命令",
	sh: "同 bash,禁止嵌套 shell",
	eval: "禁止执行任意代码字符串",
};

/**
 * 拼装 bash 拦截 reason(含替代建议)
 *
 * @param firstWord bash 命令的首词(已 trim,可能为空字符串)
 * @returns 给 LLM 看的中文拦截原因
 */
function buildBashBlockReason(firstWord: string): string {
	const base = `CI 只读模式:bash 命令 "${firstWord}" 不在白名单内`;
	const tip = SUGGESTION_BY_CMD[firstWord];
	return tip ? `${base}\n建议:${tip}` : base;
}

/**
 * Quote-aware 按 chain separator 拆 bash 命令字符串
 *
 * 拆分点(仅在 unquoted 上下文):
 * - `;` 命令链
 * - `&&` / `||` 条件链
 * - `|` 管道
 *
 * **不**拆 `>` / `<`(重定向不引入新命令)、`$()` / `` ` ``(命令替换 — 信任 LLM
 * 不主动写,且实际能跑的子命令不会比白名单更宽松)。
 *
 * **核心目的**:让 `git status; env` 这类命令链中的 `env` 也被白名单 check,而不是
 * 因首词 `git` 命中就放行整条 cmd。LLM 用 `rg "a|b" src` 时 quoted `|` 不算拆分点,
 * 整条仍按单命令处理。
 *
 * @param cmd LLM 传入的 bash 命令字符串(已 trim)
 * @returns 拆出来的每段(已 trim),空段过滤
 */
export function splitCommandChain(cmd: string): string[] {
	return splitCommandChainWithSeparators(cmd).map((s) => s.segment);
}

/**
 * Quote-aware 按 chain separator 拆 bash 命令字符串,并保留每段前面的连接符。
 *
 * @param cmd LLM 传入的 bash 命令字符串(已 trim)
 * @returns 拆出来的每段及其前置连接符(已 trim,空段过滤)
 */
function splitCommandChainWithSeparators(cmd: string): BashCommandSegment[] {
	const segments: BashCommandSegment[] = [];
	let current = "";
	let separatorBefore: BashChainSeparator | undefined;
	let inSingle = false;
	let inDouble = false;
	const pushSegment = (): void => {
		const segment = current.trim();
		if (segment.length > 0) {
			segments.push({ segment, ...(separatorBefore !== undefined ? { separatorBefore } : {}) });
			separatorBefore = undefined;
		}
		current = "";
	};
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		// 反斜杠转义(single quote 内不生效)
		if (c === "\\" && !inSingle) {
			current += c;
			if (i + 1 < cmd.length) {
				current += cmd[i + 1];
				i++;
			}
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			current += c;
			continue;
		}
		if (c === '"' && !inSingle) {
			inDouble = !inDouble;
			current += c;
			continue;
		}
		if (!inSingle && !inDouble) {
			// `;` 单字符分割
			if (c === ";") {
				pushSegment();
				separatorBefore = ";";
				continue;
			}
			// `&&` 双字符分割(单 `&` 后台运行也算分割,reviewer 场景不应该后台跑)
			if (c === "&") {
				pushSegment();
				if (cmd[i + 1] === "&") {
					separatorBefore = "&&";
					i++;
				} else {
					separatorBefore = "&";
				}
				continue;
			}
			// `||` 双字符分割(单 `|` 管道也算分割)
			if (c === "|") {
				pushSegment();
				if (cmd[i + 1] === "|") {
					separatorBefore = "||";
					i++;
				} else {
					separatorBefore = "|";
				}
				continue;
			}
		}
		current += c;
	}
	pushSegment();
	return segments;
}

function isSafeOrFallback(seg: BashCommandSegment): boolean {
	return seg.separatorBefore === "||" && (seg.segment === "true" || seg.segment === ":");
}

/**
 * CI 只读模式的拦截规则
 *
 * - write / edit 工具完全禁用
 * - bash 按命令链拆分(`;` / `&&` / `||` / `|`),**每段的首词**都校验白名单
 *   - `git status` 单命令 → 检查 `git` ✅
 *   - `git status; env` → 拆出 `git status` + `env` → 检查 `git` + `env` → `env` 拦
 *   - `rg foo . | sh` → 拆出 `rg foo .` + `sh` → 检查 `rg` + `sh` → `sh` 拦
 *   - `rg "a|b" src` → quoted `|` 不拆 → 整段 `rg ...` → 检查 `rg` ✅
 *
 * 不拦的元字符(信任 LLM,reviewer 评审场景不构造攻击):
 * - `>` / `<` 重定向(LLM 偶尔 `echo > /tmp/x` 探测,容器内 ephemeral)
 * - `$()` / `` ` `` 命令替换(实际跑的命令仍受白名单约束:`echo $(curl x)` 中 `curl` 会**不**被检测到 — 接受的盲点)
 */
function registerCiReadOnlyGuards(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			return { block: true, reason: "CI 只读模式:禁止使用 write / edit 工具" };
		}
		if (event.toolName === "bash") {
			const cmd = String(event.input.command ?? "").trim();
			const segments = splitCommandChain(cmd);
			// 空命令(LLM 偶发传 number/null)→ 走单段 "" 路径拦
			if (segments.length === 0) {
				return { block: true, reason: buildBashBlockReason("") };
			}
			for (const seg of splitCommandChainWithSeparators(cmd)) {
				const firstWord = seg.segment.split(/\s+/)[0] ?? "";
				if (!BASH_ALLOW_LIST.test(seg.segment) && !isSafeOrFallback(seg)) {
					return {
						block: true,
						reason: buildBashBlockReason(firstWord),
					};
				}
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
