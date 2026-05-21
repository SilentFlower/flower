/**
 * code-reviewer 的 pi 扩展
 *
 * 调用顺序很关键:
 * 1. 先注册 LLM provider —— 没这一步,pi 找不到模型
 * 2. 再注册合规拦截 —— 这是后续工具调用的"门禁"
 * 3. 最后注册业务工具 —— GitLab + 通用工具 + reviewer 自审工具
 * 4. 最后挂 tool_call trace 监听器(N1:用于「无依据评论」blocker 拦截 +
 *    v2:用于 reviewer_list_my_blockers 收集本轮 blocker 真值)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompliance } from "@flower-ai/flower-compliance";
import { registerHavefunProviders } from "@flower-ai/flower-providers";
import { registerCommonTools } from "@flower-ai/flower-tools-common";
import { registerGitlabTools } from "@flower-ai/flower-tools-gitlab";
import { registerObservability } from "./observability.js";
import { recordFileRead, recordLineComment } from "./review-trace.js";
import { registerReviewerSelfTools } from "./reviewer-self-tools.js";

/**
 * 注册 code-reviewer 所需的全部能力
 */
export default function (pi: ExtensionAPI): void {
	registerHavefunProviders(pi, { appSource: "code-reviewer" });
	registerCompliance(pi, { mode: "ci-readonly", product: "code-reviewer" });
	registerCommonTools(pi);
	registerGitlabTools(pi);
	registerReviewerSelfTools(pi);
	registerReviewTrace(pi);
	registerObservability(pi);
}

/**
 * 把 LLM 的工具调用追踪到 review-trace,供 run.ts finalize 阶段做「无依据评论」检查,
 * 以及 `reviewer_list_my_blockers` 工具读取本轮 blocker 真值
 *
 * 监听两个工具:
 * - `gitlab_get_file_content` → 累计 readFiles
 * - `gitlab_post_line_comment` → 累计 lineComments(含 severity + 抽取的 title)
 *
 * 注:本监听器**不**阻塞工具(不返回 `{ block: true }`),只观察;阻塞由 compliance 负责。
 */
function registerReviewTrace(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "gitlab_get_file_content") {
			const path = event.input.path;
			if (typeof path === "string") {
				recordFileRead(path);
			}
			return undefined;
		}
		if (event.toolName === "gitlab_post_line_comment") {
			const file = event.input.file;
			const line = event.input.line;
			const severity = event.input.severity;
			const body = event.input.body;
			// 四字段类型守卫(防御 LLM 异常输入 / schema 不匹配):
			// 缺任一字段都不记录,避免后续 reviewer_list_my_blockers 返回脏数据
			if (
				typeof file === "string" &&
				typeof line === "number" &&
				(severity === "blocker" || severity === "major" || severity === "minor") &&
				typeof body === "string"
			) {
				recordLineComment({ file, line, severity, body });
			}
			return undefined;
		}
		return undefined;
	});
}
