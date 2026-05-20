/**
 * 运行期入口:`getDefaultModel` + `buildHavefunModel`
 *
 * 这两个函数主要给 `pi-agent-core` 形态(ops-bot)用 —
 * code-reviewer 走 `pi.registerProvider`(在 register.ts)。
 */

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { PROVIDER_TO_API, type ProviderName } from "./catalog.js";
import { getLLMModel, getLLMProvider, getLLMReasoningEffort, getMergedModels, resolveProviderBaseUrl } from "./env.js";

/**
 * `buildPiCliArgs` 入参
 */
export interface BuildPiCliArgsInput {
	/** 已构造好的 prompt 字符串(将作为 `-p <prompt>` 传给 pi-coding-agent) */
	prompt: string;
}

/**
 * 每个 builtin model 在 `LLM_REASONING_EFFORT` 未配置时的默认 effort
 *
 * @remarks 设计原则:env 不配时拉到该 model 实际"上限",运维省心。
 *          - Opus 4.7:xhigh → 经 thinkingLevelMap 映射到 anthropic 实际最高 max
 *          - Sonnet 4.6:high(pi 默认 mapping,实际最高 high)
 *          - Haiku 4.5 / Gemini Flash Lite:off(reasoning=false 模型实际跳过 thinking)
 *          - GPT-5.x:xhigh(OpenAI Responses 直接发 reasoningEffort 字段)
 *          - Gemini Pro / Flash:high(对应 thinkingBudgets.high 上限)
 *          - 未列入的 model id:走 `GLOBAL_FALLBACK_EFFORT`
 */
const PER_MODEL_DEFAULT_EFFORT: Record<string, ModelThinkingLevel> = {
	"claude-opus-4-7": "xhigh",
	"claude-sonnet-4-6": "high",
	"claude-haiku-4-5-20251001": "off",
	"gemini-2.5-pro": "high",
	"gemini-2.5-flash": "high",
	"gemini-2.5-flash-lite": "off",
	"gpt-5.4": "xhigh",
	"gpt-5.5": "xhigh",
};

/**
 * 全局兜底 effort(`LLM_REASONING_EFFORT` 未配置且 modelId 不在 `PER_MODEL_DEFAULT_EFFORT` 时使用)
 */
const GLOBAL_FALLBACK_EFFORT: ModelThinkingLevel = "high";

/**
 * 返回当前调用应使用的默认 reasoning effort
 *
 * 决策优先级(高 → 低):
 * 1. `LLM_REASONING_EFFORT` env 显式配置(全局开关)
 * 2. `PER_MODEL_DEFAULT_EFFORT[modelId]`(每模型默认上限)
 * 3. `GLOBAL_FALLBACK_EFFORT`(全局兜底 = "high")
 *
 * @param modelId 模型 id;省略或不在 per-model 表时走全局 fallback
 * @returns 6 个合法 `ModelThinkingLevel` 之一(off / minimal / low / medium / high / xhigh)
 *
 * @remarks 仅 ops-bot 形态(`streamFn` 内)需要调用本函数,把返回值传给 `streamSimple` 的
 *          `reasoning` 字段(注意 streamSimple 的 `reasoning` 类型是 `ThinkingLevel`,不接受
 *          `"off"`,调用方负责把 `"off"` 转为 `undefined`)。
 *          code-reviewer 形态由 pi CLI 自己管 thinking level(通过 `/thinking` 命令 / config),
 *          不调本函数。
 */
export function getDefaultReasoningEffort(modelId?: string): ModelThinkingLevel {
	const fromEnv = getLLMReasoningEffort();
	if (fromEnv !== undefined) {
		return fromEnv;
	}
	if (modelId !== undefined) {
		const perModel = PER_MODEL_DEFAULT_EFFORT[modelId];
		if (perModel !== undefined) {
			return perModel;
		}
	}
	return GLOBAL_FALLBACK_EFFORT;
}

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
		// 仅当 entry 显式声明 thinkingLevelMap 时挂上,避免 undefined 字段污染对象
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
	};
	return result as unknown as Model<Api>;
}

/**
 * 把 `LLM_MODEL` / `LLM_REASONING_EFFORT` env 翻译成 pi-coding-agent CLI argv
 *
 * 与 ops-bot 形态的 `buildHavefunModel` + `getDefaultReasoningEffort` 对称:
 * 后者把 env 解析成 SDK 入参(`Model<Api>` + `ModelThinkingLevel`),本函数把同样的
 * env 解析成 print 模式 argv(`string[]`),供 `piMain(argv, ...)` 直接消费。
 *
 * @param input - 入参,见 {@link BuildPiCliArgsInput}
 * @returns pi-coding-agent CLI argv,起头固定 `["-p", prompt]`;附加 `--model <id>`(若 `LLM_MODEL` 已配置)
 *          与 `--thinking <effort>`(若 `LLM_REASONING_EFFORT` 已配置且合法)
 * @throws 当 `LLM_REASONING_EFFORT` 配置了非法值时,沿用 `getLLMReasoningEffort` 的 fail-fast 抛错
 *
 * @remarks 设计要点:
 *          - **env 缺省则不传对应 argv**,让 pi CLI 走它自己的默认(prompt-only)
 *          - **不**复用 `getDefaultReasoningEffort`:那是 ops-bot 形态在 env 缺省时填默认用的;
 *            CLI 路径若 env 不配,应**透传**给 pi CLI 决定默认(避免本层与 pi CLI 双默认冲突)
 *          - **`LLM_MODEL` 缺省允许**:try-catch `getLLMModel`,缺省走 pi CLI 默认 model
 *          - **`LLM_REASONING_EFFORT` 非法值仍 fail-fast**:沿用 `getLLMReasoningEffort` 校验,避免带病运行
 *
 * @example
 * ```typescript
 * // env: LLM_MODEL=gpt-5.5 / LLM_REASONING_EFFORT=xhigh
 * const argv = buildPiCliArgs({ prompt: "评审这个 MR" });
 * // argv = ["-p", "评审这个 MR", "--model", "gpt-5.5", "--thinking", "xhigh"]
 * await piMain(argv, { extensionFactories: [...] });
 * ```
 */
export function buildPiCliArgs(input: BuildPiCliArgsInput): string[] {
	const argv: string[] = ["-p", input.prompt];

	// LLM_PROVIDER + LLM_MODEL 各自显式传给 pi CLI。
	// **关键**:pi 内置 modelRegistry 可能有与我们 BUILTIN_MODELS 同名的 model id(如 `gpt-5.5`);
	// 同时 ~/.pi/agent/settings.json 的 `defaultProvider` 也会影响 model 解析,
	// 必须用 `--provider <name> --model <id>` 显式覆盖,确保精确命中我们注册的 havefun-* provider。
	let provider: string | undefined;
	try {
		provider = getLLMProvider();
	} catch {
		provider = undefined; // LLM_PROVIDER 缺省 / 非法时降级到只传 model
	}
	if (provider !== undefined) {
		argv.push("--provider", provider);
	}
	try {
		const modelId = getLLMModel();
		argv.push("--model", modelId);
	} catch {
		// LLM_MODEL 未配置或为空字符串,argv 不附加 --model
	}

	// LLM_REASONING_EFFORT 缺省允许(pi CLI 自己有默认);配置则透传,非法值 fail-fast 沿用 getLLMReasoningEffort 校验
	const effort = getLLMReasoningEffort();
	if (effort !== undefined) {
		argv.push("--thinking", effort);
	}

	return argv;
}
