import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { parseEffortLevels } from "./model-library.mjs";
import { normalizeBaseUrl, parseModelId } from "./model-settings.mjs";

/** 从 Host 已配置的服务读取模型名，认证信息和原始响应留在 Host。
 * @param settings 当前服务设置
 * @param fetcher HTTP 调用，测试时可替换
 * @param effortCatalog 可选容器，仅接收服务明确声明的档位
 * @returns 经校验和去重的模型名
 */
export async function listAvailableModels(settings, fetcher = fetch, effortCatalog) {
	if (!settings) throw new Error("请先配置模型服务。");
	if (settings.keyUnavailable) throw new Error("请在模型设置中重新输入或清除已保存的 API Key。");
	const endpoint = `${normalizeBaseUrl(settings.baseUrl)}/models`;
	const signal = AbortSignal.timeout(8000);
	let response;
	try {
		response = await fetcher(endpoint, {
			headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {},
			redirect: "error",
			signal,
		});
	} catch {
		throw new Error("无法连接模型列表，可手动输入模型名。");
	}
	if (!response.ok || !response.body) {
		void response.body?.cancel().catch(() => {});
		if ([401, 403].includes(response.status)) throw new Error("服务拒绝读取模型列表，请检查模型设置。");
		if ([404, 405, 501].includes(response.status)) throw new Error("服务未提供模型列表，可手动输入模型名。");
		throw new Error("暂时无法读取模型列表，可手动输入模型名。");
	}
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 1_048_576) throw new Error();
			chunks.push(value);
		}
		const catalog = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
		if (!Array.isArray(catalog?.data)) throw new Error();
		const ids = new Set();
		for (const item of catalog.data) {
			const id = parseModelId(item?.id);
			if (!id || id === settings.apiKey) continue;
			const allowed = parseEffortLevels(item.effort?.supported_levels);
			// 重复模型 ID 的元数据存在歧义，交回本机预设判断。
			if (ids.has(id)) effortCatalog?.delete(id);
			else if (allowed) effortCatalog?.set(id, allowed);
			ids.add(id);
		}
		if (ids.size > 1000) throw new Error();
		return [...ids];
	} catch {
		void reader.cancel().catch(() => {});
		throw new Error("模型列表无效、过大或读取超时，可手动输入模型名。");
	} finally {
		reader.releaseLock();
	}
}

/** 在 Host 内连接用户配置的 OpenAI 兼容模型。
 * @param options 私有模型设置、运行上下文、取消信号和可替换的 HTTP 调用
 * @returns 可转发给运行时的 pi 模型事件
 */
export function openModelStream({ settings, model, reasoning, context, signal, maxTokens, fetcher = fetch }) {
	if (!settings || !model || model.baseUrl !== settings.baseUrl || model.id !== settings.modelId) {
		throw new Error("请先配置模型。");
	}
	let imageCharacters = 0;
	const textLength = JSON.stringify(context ?? {}, (_key, part) => {
		if (part?.type !== "image" || typeof part.data !== "string") return part;
		imageCharacters += part.data.length;
		return { ...part, data: "" };
	}).length;
	if (
		!Array.isArray(context?.messages) ||
		context.messages.length > 500 ||
		textLength > 1_500_000 ||
		imageCharacters > 32 * 1024 * 1024
	) {
		throw Object.assign(new Error("会话上下文超出模型请求限制。"), { code: "context-limit" });
	}
	const endpoint = new URL(`${settings.baseUrl}/chat/completions`).href;
	return streamSimple(model, context, {
		// pi 要求构造客户端时给出非空值。无 Key 时显式省略线上授权头。
		apiKey: settings.apiKey ?? "unused",
		headers: settings.apiKey ? undefined : { authorization: null },
		signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
		reasoning,
		maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, model.maxTokens) : undefined,
		fetch: (input, options) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.href !== endpoint) throw new Error("已拒绝不匹配的模型请求地址。");
			const headers = new Headers(options?.headers);
			if (settings.apiKey) headers.set("authorization", `Bearer ${settings.apiKey}`);
			else headers.delete("authorization");
			return fetcher(input, { ...options, headers, redirect: "error" });
		},
	});
}
