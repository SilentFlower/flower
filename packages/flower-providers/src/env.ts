/**
 * 环境变量校验与解析
 *
 * 约束:
 * - 所有 env 读取统一在本文件,其他模块不直接读 `process.env`
 * - 缺失 / 非法值立即 fail-fast(抛中文 Error),便于在进程启动阶段暴露配置问题
 * - 永不打印 / 返回 `LLM_API_KEY` 真实值(spec 强约束)
 */

import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import {
	ALLOWED_APIS,
	ALLOWED_PROVIDER_NAMES,
	BUILTIN_MODELS,
	type BuiltinModelEntry,
	PROVIDER_PATH_SUFFIX,
	type ProviderName,
} from "./catalog.js";

/**
 * `LLM_REASONING_EFFORT` env 合法值集合(pi `ModelThinkingLevel` 6 级:含 off)
 *
 * @remarks 顺序按"推理强度从弱到强"排列,便于错误信息阅读
 */
export const ALLOWED_REASONING_EFFORTS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

/**
 * 读取 LLM 网关 baseUrl(**根 URL,不含任何路径后缀**)
 *
 * @returns 非空字符串,已去除尾部斜杠
 * @throws 当 `LLM_BASE_URL` 缺失或为空字符串时抛错
 *
 * @remarks 用户必须配置**根 URL**(如 `https://jp-ai.havefun.eu.cc`),不要带 `/v1` /
 *          `/v1beta` / `/anthropic` 等协议后缀。本包会按 provider 自动拼正确后缀
 *          (见 `resolveProviderBaseUrl`)。
 */
export function getLLMBaseUrl(): string {
	const value = process.env.LLM_BASE_URL;
	if (!value || value.trim() === "") {
		throw new Error("LLM_BASE_URL 未配置:请在环境变量中设置 LLM 网关的根 URL(不含 /v1 等后缀)");
	}
	// 去除尾部斜杠,避免后续拼接出现 // 双斜杠
	return value.trim().replace(/\/+$/, "");
}

/**
 * 把根 URL + provider 的协议后缀拼成 pi-ai SDK 期望的完整 baseUrl
 *
 * @param provider 4 个 `havefun-*` provider 名之一
 * @returns 形如 `https://jp-ai.havefun.eu.cc/v1` / `.../v1beta` / `.../`(anthropic 无后缀)
 *
 * @example
 * ```typescript
 * resolveProviderBaseUrl("havefun-openai")            // "https://.../v1"
 * resolveProviderBaseUrl("havefun-openai-responses")  // "https://.../v1"
 * resolveProviderBaseUrl("havefun-anthropic")         // "https://..."(根,SDK 内部加 /v1/messages)
 * resolveProviderBaseUrl("havefun-gemini")            // "https://.../v1beta"
 * ```
 */
export function resolveProviderBaseUrl(provider: ProviderName): string {
	const root = getLLMBaseUrl();
	const suffix = PROVIDER_PATH_SUFFIX[provider];
	return `${root}${suffix}`;
}

/**
 * 返回 pi `ProviderConfig.apiKey` 字段应使用的字符串值
 *
 * @remarks 见 PRD ADR-3:`apiKey` 字段在 pi 中支持"raw key 或 env 变量名",
 *          这里传字符串字面量 `"LLM_API_KEY"`,由 pi 自己从 `process.env` resolve,
 *          避免明文 key 经过本包代码。
 *
 *          额外:为了让两条接入路径(code-reviewer 走 pi.registerProvider /
 *          ops-bot 走 buildHavefunModel + streamFn)行为一致,本函数会在启动期
 *          检查 `process.env.LLM_API_KEY` 是否真实存在,缺失立即 fail-fast。
 *
 * @returns 固定字符串 `"LLM_API_KEY"`(env 变量名)
 * @throws 当 `process.env.LLM_API_KEY` 缺失或为空字符串时抛错
 */
export function getLLMApiKeyEnvName(): string {
	const actual = process.env.LLM_API_KEY;
	if (!actual || actual.trim() === "") {
		throw new Error("LLM_API_KEY 未配置:请在环境变量中设置 LLM 网关的 API key");
	}
	return "LLM_API_KEY";
}

/**
 * 读取并校验 `LLM_PROVIDER` 环境变量
 *
 * @returns 4 个合法 provider 名之一
 * @throws 当 `LLM_PROVIDER` 缺失或不在合法集时抛错(错误信息会列出全部合法值)
 */
export function getLLMProvider(): ProviderName {
	const value = process.env.LLM_PROVIDER;
	if (!value || value.trim() === "") {
		throw new Error(`LLM_PROVIDER 未配置:请在环境变量中设置,合法值:${ALLOWED_PROVIDER_NAMES.join(" / ")}`);
	}
	if (!(ALLOWED_PROVIDER_NAMES as readonly string[]).includes(value)) {
		throw new Error(`LLM_PROVIDER 非法值 "${value}":合法值:${ALLOWED_PROVIDER_NAMES.join(" / ")}`);
	}
	return value as ProviderName;
}

/**
 * 读取并校验 `LLM_MODEL` 环境变量
 *
 * @returns 非空字符串(具体合法性由 runtime 层结合合并清单再校验)
 * @throws 当 `LLM_MODEL` 缺失或为空字符串时抛错
 */
export function getLLMModel(): string {
	const value = process.env.LLM_MODEL;
	if (!value || value.trim() === "") {
		throw new Error("LLM_MODEL 未配置:请在环境变量中设置默认模型 id");
	}
	return value;
}

/**
 * 读取并校验 `LLM_REASONING_EFFORT` 环境变量(可选)
 *
 * @returns 6 个合法 `ModelThinkingLevel` 之一;env 缺失或为空字符串返回 `undefined`
 * @throws 当值不在 `ALLOWED_REASONING_EFFORTS` 中时抛错,错误信息列出 6 个合法值
 *
 * @remarks 此 env 是运维侧统一调节"思考预算"的开关:
 *          - 不配置 → 由 `runtime.ts:getDefaultReasoningEffort` 按 per-model 默认决定
 *          - 配置一个合法值 → 覆盖所有 model 的默认 effort
 *          - 配置非法值 → fail-fast,避免带病运行
 */
export function getLLMReasoningEffort(): ModelThinkingLevel | undefined {
	const value = process.env.LLM_REASONING_EFFORT;
	if (!value || value.trim() === "") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!(ALLOWED_REASONING_EFFORTS as readonly string[]).includes(trimmed)) {
		throw new Error(`LLM_REASONING_EFFORT 非法值 "${trimmed}":合法值:${ALLOWED_REASONING_EFFORTS.join(" / ")}`);
	}
	return trimmed as ModelThinkingLevel;
}

/**
 * 读取并解析 `LLM_EXTRA_MODELS_JSON` 环境变量(可选)
 *
 * @returns 额外模型清单数组;若 env 缺失或为空字符串则返回空数组
 * @throws JSON 解析失败 / 结构非数组 / 单项缺关键字段 / `nativeApi` 非法时抛错
 */
export function getExtraModels(): BuiltinModelEntry[] {
	const raw = process.env.LLM_EXTRA_MODELS_JSON;
	if (!raw || raw.trim() === "") {
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`LLM_EXTRA_MODELS_JSON 解析失败:${msg}`);
	}

	if (!Array.isArray(parsed)) {
		throw new Error("LLM_EXTRA_MODELS_JSON 必须是数组结构");
	}

	const result: BuiltinModelEntry[] = [];
	for (let i = 0; i < parsed.length; i++) {
		const item = parsed[i];
		if (typeof item !== "object" || item === null) {
			throw new Error(`LLM_EXTRA_MODELS_JSON[${i}] 必须是对象`);
		}
		const obj = item as Record<string, unknown>;

		if (typeof obj.id !== "string" || obj.id.trim() === "") {
			throw new Error(`LLM_EXTRA_MODELS_JSON[${i}].id 必填且为非空字符串`);
		}
		if (typeof obj.nativeApi !== "string") {
			throw new Error(`LLM_EXTRA_MODELS_JSON[${i}].nativeApi 必填且为字符串`);
		}
		if (!(ALLOWED_APIS as readonly string[]).includes(obj.nativeApi)) {
			throw new Error(
				`LLM_EXTRA_MODELS_JSON[${i}].nativeApi 非法值 "${obj.nativeApi}":合法值:${ALLOWED_APIS.join(" / ")}`,
			);
		}

		// 其余字段缺失走默认值
		// 透传 thinkingLevelMap(运维通过 LLM_EXTRA_MODELS_JSON 注入的模型也允许带此字段;
		// 不做深度校验,信任用户 — 类型由 pi-ai 在运行时解释)
		const thinkingLevelMap =
			typeof obj.thinkingLevelMap === "object" && obj.thinkingLevelMap !== null
				? (obj.thinkingLevelMap as ThinkingLevelMap)
				: undefined;
		result.push({
			id: obj.id,
			name: typeof obj.name === "string" ? obj.name : obj.id,
			contextWindow: typeof obj.contextWindow === "number" ? obj.contextWindow : 128_000,
			maxTokens: typeof obj.maxTokens === "number" ? obj.maxTokens : 16_384,
			reasoning: typeof obj.reasoning === "boolean" ? obj.reasoning : false,
			input: Array.isArray(obj.input)
				? (obj.input.filter((x) => x === "text" || x === "image") as ("text" | "image")[])
				: ["text"],
			cost:
				typeof obj.cost === "object" && obj.cost !== null
					? {
							input: (obj.cost as Record<string, number>).input ?? 0,
							output: (obj.cost as Record<string, number>).output ?? 0,
							cacheRead: (obj.cost as Record<string, number>).cacheRead ?? 0,
							cacheWrite: (obj.cost as Record<string, number>).cacheWrite ?? 0,
						}
					: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			nativeApi: obj.nativeApi as BuiltinModelEntry["nativeApi"],
			thinkingLevelMap,
		});
	}

	return result;
}

/**
 * 合并 `BUILTIN_MODELS` 与 `LLM_EXTRA_MODELS_JSON` 注入的额外模型清单
 *
 * @returns 合并后的清单(同 id 时 extras 覆盖 builtin)
 */
export function getMergedModels(): BuiltinModelEntry[] {
	const extras = getExtraModels();
	if (extras.length === 0) {
		return [...BUILTIN_MODELS];
	}
	// id 重复时 extras 覆盖 builtin
	const map = new Map<string, BuiltinModelEntry>();
	for (const m of BUILTIN_MODELS) {
		map.set(m.id, m);
	}
	for (const m of extras) {
		map.set(m.id, m);
	}
	return Array.from(map.values());
}
