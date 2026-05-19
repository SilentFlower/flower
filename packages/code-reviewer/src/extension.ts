/**
 * code-reviewer 的 pi 扩展
 *
 * 调用顺序很关键:
 * 1. 先注册 LLM provider —— 没这一步,pi 找不到模型
 * 2. 再注册合规拦截 —— 这是后续工具调用的"门禁"
 * 3. 最后注册业务工具 —— GitLab + 通用工具
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompliance } from "@flower-ai/pi-compliance";
import { registerCompanyProviders } from "@flower-ai/pi-providers";
import { registerCommonTools } from "@flower-ai/pi-tools-common";
import { registerGitlabTools } from "@flower-ai/pi-tools-gitlab";

/**
 * 注册 code-reviewer 所需的全部能力
 */
export default function (pi: ExtensionAPI): void {
	registerCompanyProviders(pi, { appSource: "code-reviewer" });
	registerCompliance(pi, { mode: "ci-readonly", product: "code-reviewer" });
	registerCommonTools(pi);
	registerGitlabTools(pi);
}
