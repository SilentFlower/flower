import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
const modelAliases = new Map([
	["claude-sonnet-5.5", "claude-sonnet-5-5"],
	["anthropic/claude-sonnet-5-5", "claude-sonnet-5-5"],
	["anthropic/claude-sonnet-5.5", "claude-sonnet-5-5"],
	["deepseek-ai/deepseek-flash", "deepseek-flash"],
	["deepseek-ai/deepseek-v4-pro", "deepseek-v4-pro"],
]);
let catalogWindows;

/** 解析明确已知的兼容模型别名。@param {string} id 网关模型 ID @returns {string} pi 目录 ID */
export function catalogModelId(id) {
	return modelAliases.get(id) ?? id;
}

/** 校验用户声明的有效窗口。@param value 模型设置中的窗口大小 @returns {number|undefined} 清空时采用自动识别 */
export function parseContextWindow(value) {
	if (value === undefined || value === "") return undefined;
	const size = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	if (!Number.isSafeInteger(size) || size < 1024 || size > 10_000_000) {
		throw new Error("上下文窗口须为 1024 到 10000000 之间的整数。");
	}
	return size;
}

/** 从本地 pi 目录和手动配置解析有效窗口。@param {string} id 模型 ID @param {number} override 手动窗口 @returns {object} 窗口大小及来源 */
export function describeContextWindow(id, override) {
	if (override !== undefined) return { limit: override, source: "custom" };
	if (!catalogWindows) {
		catalogWindows = new Map();
		for (const provider of getBuiltinProviders()) {
			for (const model of getBuiltinModels(provider)) {
				const size = model.contextWindow;
				if (!Number.isSafeInteger(size) || size < 1024) continue;
				catalogWindows.set(`${provider}/${model.id}`, size);
				// 同一未限定 ID 存在不同窗口时，采用目录中保守的值。
				catalogWindows.set(model.id, Math.min(catalogWindows.get(model.id) ?? size, size));
			}
		}
	}
	const recorded = catalogWindows.get(catalogModelId(id));
	return recorded === undefined ? { limit: 32768, source: "fallback" } : { limit: recorded, source: "catalog" };
}

/** 校验并规范化用户输入的 OpenAI 兼容服务地址。
 * @param value 基础地址，包含服务要求的路径
 * @returns 去掉尾斜杠的地址
 */
export function normalizeBaseUrl(value) {
	if (typeof value !== "string" || value.length > 2048) throw new Error("请输入有效的 Base URL。");
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("请输入有效的 Base URL。");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.test(url.hostname))) {
		throw new Error("请输入 HTTPS 地址或本机回环 HTTP 地址。");
	}
	if (url.username || url.password || /[?#]/.test(url.href)) {
		throw new Error("Base URL 请只填写主机、端口和 API 路径。");
	}
	return url.href.replace(/\/+$/, "");
}

/** 解析可用于同一模型服务的模型名。
 * @param value 模型发现或本机输入的值
 * @returns 去掉首尾空白的有效模型名，无效时为空
 */
export function parseModelId(value) {
	if (typeof value !== "string" || /\p{Cc}/u.test(value)) return undefined;
	const id = value.trim();
	return id && id.length <= 200 ? id : undefined;
}

/** 生成传给运行时的非敏感模型描述。
 * @param config 已校验的 Host 设置
 * @returns pi 模型描述，缺少可用配置时为空
 */
export function describeModel(config) {
	if (!config?.modelId || config.keyUnavailable) return undefined;
	const contextWindow = config.models?.find(({ id }) => id === config.modelId)?.contextWindow;
	return {
		id: config.modelId,
		name: config.modelId,
		api: "openai-completions",
		provider: "flower-local",
		baseUrl: config.baseUrl,
		contextWindow: describeContextWindow(config.modelId, contextWindow).limit,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}
