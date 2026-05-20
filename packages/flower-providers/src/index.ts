/**
 * @flower-ai/flower-providers 公开 API
 *
 * 把目标 LLM 网关(自部署 vLLM / 内部 AI Gateway / 第三方 OpenAI 兼容服务)
 * 统一接入 pi 系列 agent。两个产品(code-reviewer / ops-bot)的 LLM 调用都
 * 经由本包,任何 baseUrl / 模型清单 / header 的变更只改这一处。
 */

export type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
export type { ProviderName } from "./catalog.js";
export { registerHavefunProviders } from "./register.js";
export type { BuildPiCliArgsInput } from "./runtime.js";
export { buildHavefunModel, buildPiCliArgs, getDefaultModel, getDefaultReasoningEffort } from "./runtime.js";
