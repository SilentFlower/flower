/**
 * 内置模型清单 + provider/api 映射表
 *
 * 设计要点:
 * - 4 个公开 provider 名(`havefun-*`)对应 pi-ai 的 4 个 LLM 协议
 * - 每个模型只声明一个原生协议(`nativeApi`),由它决定注册到哪个 provider
 *   理由见 PRD ADR-6:走原生协议才能拿到家族特性(Claude 原生 thinking /
 *   Gemini thinking budget / GPT-5.x reasoning summary),走 openai-completions
 *   会降级到最小公约数
 */

import type { Api, ThinkingLevelMap } from "@earendil-works/pi-ai";

/**
 * 本包公开的 4 个 provider 名(联合类型,便于编辑器补全 + 类型校验)
 *
 * - `havefun-openai`:OpenAI Chat Completions 协议,兜底接口,默认无内置模型,
 *   通过 `LLM_EXTRA_MODELS_JSON` 注入只支持 openai-completions 的模型(如 grok / qwen / glm 等)
 * - `havefun-openai-responses`:OpenAI Responses 协议,挂 GPT-5.x codex 系列
 * - `havefun-anthropic`:Anthropic Messages 协议,挂 Claude 系列(支持原生 thinking)
 * - `havefun-gemini`:Google Generative AI 协议,挂 Gemini 系列
 */
export type ProviderName = "havefun-openai" | "havefun-openai-responses" | "havefun-anthropic" | "havefun-gemini";

/**
 * provider 名 → pi-ai Api 字段的映射
 *
 * @remarks 注意 pi-ai 的正式字段名是 `anthropic-messages` / `google-generative-ai`,
 *          不是 `anthropic` / `gemini`(网关侧使用的是后者短名,容易混淆)
 */
export const PROVIDER_TO_API: Record<ProviderName, Api> = {
	"havefun-openai": "openai-completions",
	"havefun-openai-responses": "openai-responses",
	"havefun-anthropic": "anthropic-messages",
	"havefun-gemini": "google-generative-ai",
};

/**
 * pi-ai Api 字段 → provider 名的反向映射
 *
 * @remarks 用于按 `nativeApi` 查"模型应注册到哪个 provider"
 */
export const API_TO_PROVIDER: Record<string, ProviderName> = {
	"openai-completions": "havefun-openai",
	"openai-responses": "havefun-openai-responses",
	"anthropic-messages": "havefun-anthropic",
	"google-generative-ai": "havefun-gemini",
};

/**
 * pi-ai 中合法的 4 个 LLM 协议字段值
 *
 * @remarks 用于校验 `LLM_EXTRA_MODELS_JSON` 注入的 `nativeApi` 是否合法
 */
export const ALLOWED_APIS: readonly Api[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

/**
 * 4 个 provider 的合法名(给 fail-fast 错误信息引用)
 */
export const ALLOWED_PROVIDER_NAMES: readonly ProviderName[] = [
	"havefun-openai",
	"havefun-openai-responses",
	"havefun-anthropic",
	"havefun-gemini",
];

/**
 * 每个 provider 注入到 pi-ai SDK 时,需要在 `LLM_BASE_URL`(根)之后追加的版本路径
 *
 * @remarks 不同 LLM SDK 对 `baseURL` 字段的预期不同:
 *          - **OpenAI SDK**(`api: "openai-completions"` / `"openai-responses"`):
 *            SDK 内部拼 `${baseURL}/chat/completions` 或 `${baseURL}/responses`,
 *            所以 baseURL 必须已经包含 `/v1`
 *          - **Anthropic SDK**(`api: "anthropic-messages"`):
 *            SDK 内部拼 `${baseURL}/v1/messages`,所以 baseURL 应**不**带 `/v1`
 *          - **Google Generative AI SDK**(`api: "google-generative-ai"`):
 *            pi-ai google.js 显式设置 `apiVersion = ""`,并要求 `baseUrl` 已包含
 *            版本路径(`/v1beta`),否则 SDK 不会自动追加
 *
 *          策略:用户在 `LLM_BASE_URL` 里只配根 URL(如 `https://jp-ai.havefun.eu.cc`),
 *          本表为每个 provider 自动拼正确后缀,避免用户记住 4 套规则。
 */
export const PROVIDER_PATH_SUFFIX: Record<ProviderName, string> = {
	"havefun-openai": "/v1",
	"havefun-openai-responses": "/v1",
	"havefun-anthropic": "",
	"havefun-gemini": "/v1beta",
};

/**
 * 单个模型的元数据(对齐 pi-ai `ProviderModelConfig` 的字段子集 + 一个 `nativeApi` 字段)
 *
 * @remarks 与 pi 的 `ProviderModelConfig` 差异:
 *          - 多一个 `nativeApi`(本包用来决定注册到哪个 provider)
 *          - `api` 字段在注册到 pi 时由 `nativeApi` 推出来,不直接写在 entry 上
 */
export interface BuiltinModelEntry {
	/** 模型 id(网关识别用,需与网关 `/v1/models` 一致) */
	id: string;
	/** 给 UI 显示用的友好名称 */
	name: string;
	/** 上下文窗口 token 数 */
	contextWindow: number;
	/** 单次输出最大 token 数 */
	maxTokens: number;
	/** 是否支持 reasoning / thinking */
	reasoning: boolean;
	/** 支持的输入类型(text / image) */
	input: readonly ("text" | "image")[];
	/** 单 token 计费(per token,美元) */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/**
	 * 该模型走哪个 pi-ai api(原生协议),由它决定注册到哪个 provider
	 *
	 * @remarks 见 PRD ADR-6。合法值见 `ALLOWED_APIS`。
	 */
	nativeApi: Api;
	/**
	 * 把 pi 统一的 `ThinkingLevel`(5 级:minimal/low/medium/high/xhigh)映射到
	 * 该 model 自家实际 effort/budget 字符串或数字。缺失则走 pi-ai 内部默认 mapping。
	 *
	 * @remarks 典型使用场景:Anthropic Opus 4.7 实际最高 effort 是 `"max"`,但 pi 的
	 *          `ThinkingLevel` 没有 max。声明 `{ xhigh: "max", ... }` 后,运维只需把
	 *          `LLM_REASONING_EFFORT` 调到 `xhigh` 即可拿到 Opus 4.7 的最高 effort。
	 *          值为 `null` 表示该 level 在本 model 上不支持(pi 会跳过 reasoning)。
	 */
	thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * 内置模型清单(8 条)
 *
 * @remarks 数据来源 / 字段含义:
 *          - 每条 `nativeApi` 以**人工知识**为准,不机械跟随网关 `/v1/models` 返回(例如 `gpt-5.5`
 *            网关漏报对 openai-response 的支持,这里仍写 `openai-responses`)
 *          - `cost` 字段全填 0 — 接通计费系统后再补真实数据(PRD Out of Scope 已说明)
 *          - `contextWindow` / `maxTokens`:按各家官方文档真实值填写
 *            (Claude / Gemini 见官方 docs;GPT-5.x 按网关侧 Codex 模式上限,gpt-5.5 上下文窗口
 *            收敛到 400K)
 *          - `reasoning`:仅当官方文档明确支持 extended thinking / reasoning 才写 true。
 *            Haiku 4.5 与 Gemini 2.5 Flash Lite 实测不支持,写 false
 *          - `thinkingLevelMap`:仅当 pi 默认 5 级映射无法覆盖该 model 的实际最高 effort
 *            时显式声明(如 Opus 4.7 实际最高是 `"max"`,pi 默认拿不到)
 */
export const BUILTIN_MODELS: readonly BuiltinModelEntry[] = [
	// ---- Claude 家族(原生协议 anthropic-messages,支持原生 thinking)----
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		// Anthropic 官方:Opus 4.7 在 platform.claude.com 上提供 1M 上下文窗口、128K 单次输出
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		nativeApi: "anthropic-messages",
		// PRD ADR-1:Opus 4.7 effort 实际最高是 "max",但 pi 抽象层 `ThinkingLevel`
		// 只到 xhigh(无 max,经 pi-ai 0.75.3 源码确认是 deliberate 设计 — max 是
		// anthropic 专有,放进抽象层会污染其他 provider 的语义)。
		//
		// pi 官方解决方案就是这个 thinkingLevelMap:声明把 pi 抽象级 xhigh 映射到
		// anthropic 实际的 max。其他 level(low/medium/high/minimal)缺省即可,
		// 由 pi-ai `mapThinkingLevelToEffort` 的 switch fallback 自动得到恒等映射
		// (见 node_modules/.../providers/anthropic.js:546-561)。
		thinkingLevelMap: { xhigh: "max" },
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		// Anthropic 官方:Sonnet 4.6 同样支持 1M 上下文窗口;maxTokens 64K
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		nativeApi: "anthropic-messages",
		// PRD ADR-3:Sonnet 4.6 不显式声明 thinkingLevelMap,走 pi 默认(xhigh 降级为 "high")。
		// 后续若实测支持 max 再补。
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		// Anthropic 官方:Haiku 4.5 标准 200K 上下文,maxTokens 64K
		contextWindow: 200_000,
		maxTokens: 64_000,
		// PRD ADR-2:Anthropic 官方 extended-thinking 文档未列 Haiku 4.5,
		// 且明确说 Haiku 模型上 thinking blocks 会被从上下文移除,因此写 false
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		nativeApi: "anthropic-messages",
	},
	// ---- Gemini 家族(原生协议 google-generative-ai,支持原生 thinking budget)----
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		// Google 官方:2.5 Pro 上下文 1,048,576 token,maxTokens 65,536
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		nativeApi: "google-generative-ai",
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		// Google 官方:Flash 上下文 1,048,576 token,maxTokens 65,535(比 Pro 少 1)
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		nativeApi: "google-generative-ai",
	},
	{
		id: "gemini-2.5-flash-lite",
		name: "Gemini 2.5 Flash Lite",
		// Google 官方:Flash Lite 与 Flash 同窗口,轻量定位,reasoning 关闭
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		nativeApi: "google-generative-ai",
	},
	// ---- GPT-5.x 家族(原生协议 openai-responses,支持 reasoning summary + service tier)----
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		// 网关侧 Codex 模式:gpt-5.4 上下文窗口 1,050,000 token,maxTokens 128K
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		nativeApi: "openai-responses",
	},
	{
		// 注:网关 /v1/models 漏报 gpt-5.5 对 openai-response 的支持,实测支持,以人工知识为准
		id: "gpt-5.5",
		name: "GPT-5.5",
		// 网关侧 Codex 模式:gpt-5.5 在网关上的上下文窗口收敛到 400,000,maxTokens 128K
		contextWindow: 400_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		nativeApi: "openai-responses",
	},
];
