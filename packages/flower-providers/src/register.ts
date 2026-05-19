/**
 * 注册 4 个 havefun-* provider 到 pi
 *
 * 设计要点:
 * - 4 个 provider 一次性全部注册,模型按 `nativeApi` 单一归属(见 PRD ADR-6)
 * - `havefun-openai` 在无 `LLM_EXTRA_MODELS_JSON` 时模型列表为空,但仍然注册,
 *   作为后续注入"只支持 openai-completions"模型的兜底接口
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ALLOWED_PROVIDER_NAMES, type BuiltinModelEntry, PROVIDER_TO_API, type ProviderName } from "./catalog.js";
import { getLLMApiKeyEnvName, getLLMBaseUrl, getMergedModels, resolveProviderBaseUrl } from "./env.js";

/**
 * 把合并模型清单中的一条转成 pi `ProviderModelConfig` 形状
 *
 * @remarks pi 的 `ProviderModelConfig` 与本包 `BuiltinModelEntry` 字段差异:
 *          pi 没有 `nativeApi`(它的 `api` 在 provider 级或 model 级覆盖)
 */
function toProviderModelConfig(m: BuiltinModelEntry) {
	return {
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		input: [...m.input] as ("text" | "image")[],
		cost: { ...m.cost },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
	};
}

/**
 * 注册自定义 LLM provider 到 pi
 *
 * 把目标 LLM 网关接入 pi-coding-agent。本函数会注册 4 个 provider
 * (`havefun-openai` / `havefun-openai-responses` / `havefun-anthropic` /
 * `havefun-gemini`),每个 provider 挂上"`nativeApi` 与其协议一致"的模型子集。
 *
 * @param pi pi 扩展 API
 * @param options 注册选项
 * @param options.appSource 标记请求来自哪个产品,用于审计与计费(写入 `X-App-Source` header);**必填,不接受空字符串**
 * @throws 当 `LLM_BASE_URL` / `LLM_API_KEY` 缺失,或 `appSource` 为空时抛错
 *
 * @example
 * ```typescript
 * import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
 * import { registerHavefunProviders } from "@flower-ai/flower-providers";
 *
 * export default function (pi: ExtensionAPI) {
 *   registerHavefunProviders(pi, { appSource: "code-reviewer" });
 * }
 * ```
 */
export function registerHavefunProviders(pi: ExtensionAPI, options: { appSource: string }): void {
	if (!options.appSource || options.appSource.trim() === "") {
		throw new Error("registerHavefunProviders:options.appSource 必填(非空字符串)");
	}

	// 触发 env 校验(缺失直接 fail-fast)
	getLLMBaseUrl();
	const apiKeyEnvName = getLLMApiKeyEnvName();

	const mergedModels = getMergedModels();

	for (const providerName of ALLOWED_PROVIDER_NAMES) {
		const api = PROVIDER_TO_API[providerName as ProviderName];
		// 关键:按 nativeApi 严格匹配,每个 model 只命中 1 个 provider(见 PRD ADR-6)
		const filteredModels = mergedModels.filter((m) => m.nativeApi === api);

		// 每个 provider 用自己的 baseUrl(根 + 协议后缀,见 PROVIDER_PATH_SUFFIX)
		// 这是为了适配 4 个 LLM SDK 对 baseURL 字段的不同预期
		const providerBaseUrl = resolveProviderBaseUrl(providerName as ProviderName);

		// 注意:havefun-openai 在无 extras 时 filteredModels 为空数组,仍然注册
		// (pi 接受空 models;此 provider 作为后续 extras 注入的接口)
		pi.registerProvider(providerName, {
			baseUrl: providerBaseUrl,
			apiKey: apiKeyEnvName,
			api,
			models: filteredModels.map(toProviderModelConfig),
			headers: {
				"X-App-Source": options.appSource,
			},
		});
	}
}
