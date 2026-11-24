import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	catalogModelId,
	describeContextWindow,
	describeModel,
	normalizeBaseUrl,
	parseContextWindow,
	parseModelId,
} from "./model-settings.mjs";
import { readJson, storageKey, writeJson } from "./storage.mjs";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const modes = new Set(["auto", "none", "standard"]);
const catalogModels = [anthropicProvider, deepseekProvider, openaiProvider].flatMap((provider) =>
	provider().getModels(),
);
const inputKinds = new Map(catalogModels.map((model) => [model.id, model.input]));
const sdkModels = new Map(
	catalogModels
		.filter((model) => model.reasoning)
		.map((model) => [
			model.id,
			{
				provider: model.provider,
				levels: getSupportedThinkingLevels(model),
				standardOff: model.thinkingLevelMap?.off === "none",
			},
		]),
);

function deepSeekDirect(service, model) {
	if (!service || model?.provider !== "deepseek") return false;
	const url = new URL(service.baseUrl);
	return url.origin === "https://api.deepseek.com" && ["/", "/v1"].includes(url.pathname);
}

function supportsEncryption(safeStorage) {
	return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
}

function keyValue(value) {
	if (value === undefined || value === "") return undefined;
	if (typeof value !== "string" || !/^[!-~]{1,8192}$/.test(value.trim())) throw new Error("请输入有效的 API Key。");
	return value.trim();
}

function modelRecord(input) {
	const id = parseModelId(input?.id);
	const mode = input?.mode ?? "auto";
	if (!id || !modes.has(mode)) throw new Error("模型设置无效。");
	const allowed =
		mode === "standard" && Array.isArray(input.levels)
			? levels.filter((level) => input.levels.includes(level))
			: undefined;
	if (mode === "standard" && !allowed?.length) throw new Error("请至少选择一个服务支持的推理档位。");
	const contextWindow = parseContextWindow(input.contextWindow);
	return {
		id,
		mode,
		levels: allowed,
		effort: levels.includes(input.effort) ? input.effort : "default",
		...(contextWindow === undefined ? {} : { contextWindow }),
	};
}

function serviceName(value, baseUrl) {
	const name = value ?? new URL(baseUrl).host.slice(0, 64);
	if (typeof name !== "string" || !name.trim() || /\p{Cc}/u.test(name) || name.trim().length > 64)
		throw new Error("请输入有效的服务名称。");
	return name.trim();
}

function effortScope(service) {
	return storageKey([service.id, service.baseUrl, service.encryptedKey ?? null]);
}

function verifiedEffort(service, catalog) {
	if (!catalog?.size) return;
	const models = service.models.flatMap(({ id }) => {
		const declared = parseEffortLevels(catalog.get(id));
		return declared ? [[id, declared]] : [];
	});
	if (models.length) return { scope: effortScope(service), models };
}

function restoreService(input, safeStorage) {
	const baseUrl = normalizeBaseUrl(input.baseUrl);
	const modelId = input.modelId ? parseModelId(input.modelId) : "";
	if (modelId === undefined) throw new Error("请输入有效的模型名。");
	const models = (input.models ?? (modelId ? [{ id: modelId }] : [])).map(modelRecord);
	const service = {
		id: input.id ?? randomUUID(),
		name: serviceName(input.name, baseUrl),
		baseUrl,
		modelId,
		models,
		encryptedKey: input.encryptedKey,
	};
	const saved = input.verifiedEffort;
	if (saved?.scope === effortScope(service) && Array.isArray(saved.models)) {
		const entries = saved.models.filter((entry) => Array.isArray(entry) && entry.length === 2);
		service.verifiedEffort = verifiedEffort(service, new Map(entries));
	}
	if (!service.encryptedKey) return service;
	try {
		if (!supportsEncryption(safeStorage)) throw new Error();
		const apiKey = keyValue(safeStorage.decryptString(Buffer.from(service.encryptedKey, "base64")));
		if (!apiKey) throw new Error();
		return { ...service, apiKey };
	} catch {
		return { ...service, keyUnavailable: true };
	}
}

/** 读取本机服务并识别旧的单服务文件。@param {string} path 设置路径 @param {object} safeStorage 主进程凭据保护 @returns {Promise<object>} 主进程专用服务库 */
export async function loadModelLibrary(path, safeStorage) {
	const stored = await readJson(path);
	if (!stored) return { activeId: "", services: [] };
	if (stored.version === undefined) {
		const service = restoreService(stored, safeStorage);
		return { activeId: service.id, services: [service] };
	}
	if (stored.version !== 2 || !Array.isArray(stored.services)) throw new Error("模型设置版本无效。");
	const services = stored.services.map((service) => restoreService(service, safeStorage));
	return { activeId: stored.activeId, services };
}

/** 落盘服务目录与各自的加密凭据。@param {string} path 设置路径 @param {object} library 主进程服务库 @returns {Promise<void>} 写入结果 */
export function writeModelLibrary(path, library) {
	return writeJson(path, {
		version: 2,
		activeId: library.activeId,
		services: library.services.map(({ apiKey, keyUnavailable, ...service }) => service),
	});
}

/** 按稳定 ID 查找主进程保存的服务。@param {object} library 服务库 @param {string} id 服务 ID @returns {object|undefined} 匹配服务 */
export function findService(library, id = library.activeId) {
	return library.services.find((item) => item.id === id);
}

/** 保存已加入服务的模型档位。@param {object} library 服务库 @param {string} id 服务 ID @param {Map} catalog 本次服务声明 @returns {object} 更新后的服务库 */
export function rememberModelEffortCatalog(library, id, catalog) {
	const service = findService(library, id);
	if (!service || service.keyUnavailable) return library;
	const verified = verifiedEffort(service, catalog);
	if (JSON.stringify(verified) === JSON.stringify(service.verifiedEffort)) return library;
	const services = library.services.map((item) => (item === service ? { ...item, verifiedEffort: verified } : item));
	return { ...library, services };
}

/** 解析服务明确公布的档位。@param {unknown} value 服务模型的 effort.supported_levels @returns {string[]|undefined} 经校验的档位 */
export function parseEffortLevels(value) {
	if (!Array.isArray(value) || value.length > levels.length) return;
	const declared = new Set(value.map((level) => (level === "none" ? "off" : level)));
	if ([...declared].some((level) => !levels.includes(level))) return;
	return levels.filter((level) => declared.has(level));
}

/**
 * 选出关闭思考的发送方式。
 * @param {object|undefined} model pi 目录中的推理模型
 * @param {string} fallback 非 DeepSeek 模型的方式
 * @returns {"deepseek"|"none"|"omit"} deepseek 发 thinking.type，none 发 reasoning_effort=none，omit 不带推理字段
 */
function offMethod(model, fallback) {
	// DeepSeek 不认 reasoning_effort=none，只能用自家的 thinking.type 关闭；兼容网关一般原样转发该字段。
	return model?.provider === "deepseek" ? "deepseek" : fallback;
}

function recommendation(service, id, catalog) {
	const model = sdkModels.get(catalogModelId(id));
	const format = deepSeekDirect(service, model) ? "deepseek" : "openai";
	const saved = service?.keyUnavailable ? undefined : service?.verifiedEffort?.models;
	const declared = catalog ? catalog.get(id) : saved?.find(([modelId]) => modelId === id)?.[1];
	if (declared) {
		// DeepSeek 的目录只列思考开启时的 effort。关闭通过单独的 thinking.type 发送。
		const addOff =
			model?.provider === "deepseek" && declared.length && model.levels.includes("off") && !declared.includes("off");
		return { source: "service", format, off: offMethod(model, "none"), levels: addOff ? ["off", ...declared] : declared };
	}
	if (!model) return { source: "default", levels: [] };
	// pi 目录已标明能否关闭思考；没有标准关闭字段的模型（如 Claude）不带推理字段即为关闭。
	return { source: "builtin", format, off: offMethod(model, model.standardOff ? "none" : "omit"), levels: model.levels };
}

/** 生成模型推理推荐摘要供设置页使用。@param {object} service 已保存服务 @param {string} value 模型名 @param {Map} catalog 服务声明 @returns {object} 来源与推荐档位 */
export function describeEffortPreset(service, value, catalog) {
	const { source, levels } = recommendation(service, parseModelId(value), catalog);
	return { source, levels };
}

function capability(service, model, catalog) {
	if (model?.mode === "none") return {};
	if (model?.mode === "standard") {
		const native = sdkModels.get(catalogModelId(model.id));
		return {
			format: deepSeekDirect(service, native) ? "deepseek" : "openai",
			off: offMethod(native, "none"),
			levels: model.levels,
		};
	}
	return recommendation(service, model?.id, catalog);
}

function selection(service, catalog) {
	const entry = service.models.find(({ id }) => id === service.modelId);
	const result = capability(service, entry, catalog);
	const available = result.levels ?? [];
	// 未选过或已失效的档位落到最左档：能关闭思考时为关闭，否则为最低档。
	const effort = available.includes(entry?.effort) ? entry.effort : (available[0] ?? "default");
	return { ...result, available, effort };
}

/** 生成可发送给渲染器的设置摘要。@param {object} service 主进程服务 @param {Map} catalog 服务声明 @returns {object|undefined} 去除凭据的摘要 */
export function publicService(service, catalog) {
	if (!service) return;
	const { id, name, baseUrl, modelId, models, encryptedKey, keyUnavailable } = service;
	const { available, effort } = selection(service, catalog);
	const context = modelId
		? describeContextWindow(modelId, models.find((entry) => entry.id === modelId)?.contextWindow)
		: undefined;
	return {
		id,
		name,
		baseUrl,
		modelId,
		models,
		hasKey: Boolean(encryptedKey),
		keyUnavailable,
		available,
		effort,
		context,
	};
}

/** 保存一个服务并选用它，旧地址凭据仅属于原服务。@param {object} library 服务库 @param {object} input 表单值 @param {object} safeStorage 凭据保护 @returns {object} 新服务库 */
export function updateService(library, input, safeStorage) {
	const previousId = input.serviceId === undefined ? library.activeId : input.serviceId;
	const previous = previousId ? findService(library, previousId) : undefined;
	if (previousId && !previous) throw new Error("模型服务已变化，请重新打开设置。");
	const baseUrl = normalizeBaseUrl(input.baseUrl);
	const modelId = input.modelId ? parseModelId(input.modelId) : "";
	if (modelId === undefined) throw new Error("请输入有效的模型名。");
	const sameAddress = previous?.baseUrl === baseUrl;
	const newKey = keyValue(input.apiKey);
	const keepKey = sameAddress && !newKey && input.clearKey !== true;
	const encryptedKey = keepKey ? previous.encryptedKey : undefined;
	let prior = sameAddress ? previous.models : [];
	if (sameAddress && !keepKey && previous.verifiedEffort) {
		// 自动档位由原凭据验证。手动声明继续使用用户自己的设置。
		const verifiedIds = new Set(previous.verifiedEffort.models.map(([id]) => id));
		prior = prior.map((entry) =>
			entry.mode === "auto" && verifiedIds.has(entry.id) ? { ...entry, effort: "default" } : entry,
		);
	}
	const current = prior.find(({ id }) => id === modelId);
	const record = modelId && modelRecord({ ...current, ...input.capability, id: modelId });
	const models = record
		? current
			? prior.map((entry) => (entry.id === modelId ? record : entry))
			: [...prior, record]
		: prior;
	const next = {
		id: previous?.id ?? randomUUID(),
		name: serviceName(input.name ?? previous?.name, baseUrl),
		baseUrl,
		modelId: input.keepSelectedModel === true && current ? previous.modelId : modelId,
		models,
		encryptedKey,
		apiKey: keepKey ? previous.apiKey : undefined,
		keyUnavailable: keepKey ? previous.keyUnavailable : undefined,
		verifiedEffort: keepKey ? previous.verifiedEffort : undefined,
	};
	if (newKey && input.clearKey !== true) {
		if (!supportsEncryption(safeStorage)) throw new Error("系统凭据保护不可用。可留空，用无 Key 的服务。");
		next.encryptedKey = safeStorage.encryptString(newKey).toString("base64");
		next.apiKey = newKey;
	}
	return replaceService(library, next);
}

function replaceService(library, service) {
	const services = library.services.some(({ id }) => id === service.id)
		? library.services.map((item) => (item.id === service.id ? service : item))
		: [...library.services, service];
	return { activeId: service.id, services };
}

/** 更换当前服务的模型。@param {object} library 服务库 @param {string} value 模型 ID @returns {object} 新服务库 */
export function selectModel(library, value) {
	const service = findService(library);
	const id = parseModelId(value);
	if (!service || !id) throw new Error("请输入有效的模型名。");
	const models = service.models.some((model) => model.id === id)
		? service.models
		: [...service.models, modelRecord({ id })];
	return replaceService(library, { ...service, modelId: id, models });
}

/** 校验并保存当前模型的推理档位。@param {object} library 服务库 @param {string} effort 推理档位 @param {Map} catalog 服务声明 @returns {object} 新服务库 */
export function setModelEffort(library, effort, catalog) {
	const service = findService(library);
	const available = service?.modelId && selection(service, catalog).available;
	if (!available?.includes(effort)) {
		throw new Error("当前模型不支持此推理档位。");
	}
	const models = service.models.map((entry) => (entry.id === service.modelId ? { ...entry, effort } : entry));
	return replaceService(library, { ...service, models });
}

/** 生成 pi 描述与当前发送所需的推理策略。@param {object} service 主进程服务 @param {Map} catalog 服务声明 @returns {object} 非敏感模型及强度 */
export function runtimeSelection(service, catalog) {
	const model = describeModel(service);
	if (!model) return {};
	// 未收录的兼容网关由服务端协商图片输入；已知纯文本模型在发送前提示。
	model.input = inputKinds.get(catalogModelId(model.id)) ?? ["text", "image"];
	const { available, format, off, effort } = selection(service, catalog);
	if (!available.length) return { model };
	const thinkingLevelMap = Object.fromEntries(
		levels.map((level) => [level, available.includes(level) && level !== "off" ? level : null]),
	);
	let thinkingFormat = format;
	if (effort === "off") {
		// pi 在未指定档位时按 thinkingLevelMap.off 关闭：DeepSeek 格式下键缺省即发 thinking.type=disabled，
		// 标准协议下为字符串时发 reasoning_effort，为 null 时不带推理字段。
		if (off === "deepseek") {
			thinkingFormat = "deepseek";
			delete thinkingLevelMap.off;
		} else if (off === "none") thinkingLevelMap.off = "none";
	}
	return {
		model: {
			...model,
			reasoning: true,
			thinkingLevelMap,
			compat: { thinkingFormat, supportsReasoningEffort: true },
		},
		reasoning: effort === "off" ? undefined : effort,
	};
}
