/**
 * 运行期入口:`getDefaultModel` + `buildHavefunModel`
 *
 * 这两个函数主要给 `pi-agent-core` 形态(ops-bot)用 —
 * code-reviewer 走 `pi.registerProvider`(在 register.ts)。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { PROVIDER_TO_API, type ProviderName } from "./catalog.js";
import { getLLMModel, getLLMProvider, getMergedModels, resolveProviderBaseUrl } from "./env.js";

/**
 * 读取并校验 `LLM_PROVIDER` + `LLM_MODEL`,返回当前部署单元的默认模型选择
 *
 * @returns `{ provider, modelId }` — 都已通过合法性 + 协议匹配校验
 * @throws 当 env 缺失 / 非法 / model 不存在 / model 与 provider 协议不匹配时抛错
 *
 * @example
 * ```typescript
 * const { provider, modelId } = getDefaultModel();
 * // provider: "havefun-anthropic", modelId: "claude-opus-4-7"
 * ```
 */
export function getDefaultModel(): { provider: ProviderName; modelId: string } {
	const provider = getLLMProvider();
	const modelId = getLLMModel();

	const models = getMergedModels();
	const model = models.find((m) => m.id === modelId);
	if (!model) {
		const allIds = models.map((m) => m.id).join(", ");
		throw new Error(`LLM_MODEL "${modelId}" 不在合并模型清单中。可选模型 id:[${allIds}]`);
	}

	const expectedApi = PROVIDER_TO_API[provider];
	if (model.nativeApi !== expectedApi) {
		throw new Error(
			`LLM_MODEL "${modelId}" 的原生协议为 "${model.nativeApi}",与 LLM_PROVIDER="${provider}" 对应的协议 "${expectedApi}" 不一致。请检查 env 配置。`,
		);
	}

	return { provider, modelId };
}

/**
 * 构造一个 pi-ai `Model<Api>` 对象,可直接传给 `pi-agent-core` 的 `Agent({ initialState: { model } })`
 *
 * @param provider 4 个 `havefun-*` provider 名之一
 * @param modelId 模型 id,必须在合并模型清单(builtin + LLM_EXTRA_MODELS_JSON)中
 * @returns 满足 pi-ai `Model<Api>` 形状的对象
 * @throws 当 provider 非法 / model 不存在 / model 与 provider 协议不匹配 / `LLM_BASE_URL` 缺失时抛错
 *
 * @example
 * ```typescript
 * const { provider, modelId } = getDefaultModel();
 * const model = buildHavefunModel(provider, modelId);
 * new Agent({ initialState: { model, ... }, streamFn: ... });
 * ```
 */
export function buildHavefunModel(provider: ProviderName, modelId: string): Model<Api> {
	// 校验 provider 合法(虽然类型已限制,但运行时也兜一道)
	const expectedApi = PROVIDER_TO_API[provider];
	if (!expectedApi) {
		throw new Error(`buildHavefunModel:未知 provider "${provider}"`);
	}

	const models = getMergedModels();
	const model = models.find((m) => m.id === modelId);
	if (!model) {
		const allIds = models.map((m) => m.id).join(", ");
		throw new Error(`buildHavefunModel:modelId "${modelId}" 不在合并模型清单中。可选:[${allIds}]`);
	}

	if (model.nativeApi !== expectedApi) {
		throw new Error(
			`buildHavefunModel:模型 "${modelId}" 的原生协议为 "${model.nativeApi}",与 provider "${provider}" 对应的 "${expectedApi}" 不一致`,
		);
	}

	// 每个 provider 用自己的 baseUrl(根 + 协议后缀)
	const baseUrl = resolveProviderBaseUrl(provider);

	// pi-ai 的 Model<Api> 类型对 TApi 是泛型;这里运行时 api 由 nativeApi 决定,
	// TypeScript 推不出具体 TApi 与 compat 字段的对应关系,用 cast 桥接
	const result = {
		id: model.id,
		name: model.name,
		api: model.nativeApi,
		provider,
		baseUrl,
		reasoning: model.reasoning,
		input: [...model.input],
		cost: { ...model.cost },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
	return result as unknown as Model<Api>;
}
