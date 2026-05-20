/**
 * 跨产品复用的通用工具
 *
 * 当前面向"使用禅道 + 钉钉"的团队配置,提供:
 *   - zentao_search       禅道项目管理搜索(bug / 任务 / 需求 / 用例)
 *   - dingtalk_doc_search 钉钉知识库 / 文档搜索
 *
 * 工具均为 Stub 实现,待接入真实 API 后即可投入使用。
 */

export { dingtalkDocSearchTool } from "./dingtalk-doc.js";
export { sanitizeQuickActions } from "./sanitize.js";
export { zentaoSearchTool } from "./zentao.js";

import { dingtalkDocSearchTool } from "./dingtalk-doc.js";
import { zentaoSearchTool } from "./zentao.js";

/**
 * 一次性注册所有通用工具
 */
// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI 类型在不同入口下细节略有不同
export function registerCommonTools(pi: { registerTool: (def: any) => void }): void {
	pi.registerTool(zentaoSearchTool);
	pi.registerTool(dingtalkDocSearchTool);
}
