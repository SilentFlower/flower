import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { parseDocument } from "yaml";
import { writeJson } from "./storage.mjs";
import { checkRoot, workspaceTools } from "./workspace.mjs";

const packageLimit = 16 * 1024;
const storeLimit = 2 * 1024 * 1024;
const workspaceLimit = 16;
const profileLimit = 100;
const extensionId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const workspacePattern = /^[a-f\d]{64}$/;
const tokenPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const allowed = new Set([
	"schemaVersion",
	"id",
	"name",
	"description",
	"action",
	"contains",
	"caseSensitive",
	"maxMatches",
]);
const skillFields = new Set(["kind", "schemaVersion", "id", "name", "description", "body"]);
const actions = {
	"find-lines": "提取匹配行",
	"count-lines": "统计匹配行",
};
const pathArgument = {
	type: "object",
	properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
	required: ["path"],
	additionalProperties: false,
};
const noArguments = { type: "object", properties: {}, additionalProperties: false };

function boundedText(text, limit) {
	return typeof text === "string" && Boolean(text.trim()) && text.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(text);
}

function normalizePackage(raw) {
	if (raw?.kind === "skill") return normalizeSkill(raw);
	if (!raw || typeof raw !== "object" || Object.keys(raw).some((key) => !allowed.has(key)))
		throw new Error("扩展包含有无法识别的字段。");
	if (raw.schemaVersion !== 1) throw new Error("这个扩展包版本不受支持。");
	if (typeof raw.id !== "string" || raw.id.length > 40 || !extensionId.test(raw.id))
		throw new Error("扩展标识须为最多 40 字符的小写英文、数字或连字符。");
	if (!boundedText(raw.name, 60) || !boundedText(raw.description, 320) || !boundedText(raw.contains, 100))
		throw new Error("扩展名称、说明或匹配文字无效。");
	if (typeof raw.action !== "string" || !Object.hasOwn(actions, raw.action))
		throw new Error("扩展包声明了本版本不支持的能力。");
	const caseSensitive = raw.caseSensitive === undefined ? false : raw.caseSensitive;
	const maxMatches = raw.maxMatches === undefined ? 20 : raw.maxMatches;
	if (typeof caseSensitive !== "boolean" || !Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 50)
		throw new Error("请使用有效的大小写选项和 1 到 50 条匹配上限。");
	return {
		schemaVersion: 1,
		id: raw.id,
		name: raw.name.trim(),
		description: raw.description.trim(),
		action: raw.action,
		contains: raw.contains,
		caseSensitive,
		maxMatches,
	};
}

function skillId(name) {
	const candidate = name.toLowerCase().replace(/[\s_]+/gu, "-");
	return candidate.length <= 40 && extensionId.test(candidate)
		? candidate
		: `skill-${createHash("sha256").update(name.normalize("NFC")).digest("hex").slice(0, 20)}`;
}

function normalizeSkill(raw) {
	if (
		raw.schemaVersion !== 1 ||
		Object.keys(raw).some((key) => !skillFields.has(key)) ||
		!boundedText(raw.name, 60) ||
		!boundedText(raw.description, 320) ||
		typeof raw.body !== "string" ||
		!raw.body.trim() ||
		raw.body.includes("\0") ||
		Buffer.byteLength(raw.body) > packageLimit ||
		raw.id !== skillId(raw.name.trim())
	)
		throw new Error("技能名称、说明或 Markdown 正文无效。");
	return {
		kind: "skill",
		schemaVersion: 1,
		id: raw.id,
		name: raw.name.trim(),
		description: raw.description.trim(),
		body: raw.body,
	};
}

function parseSkill(markdown) {
	const sections = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
	if (!sections) throw new Error("技能文件须以 YAML 头部声明 name 和 description，并包含 Markdown 正文。");
	let name;
	let description;
	try {
		const document = parseDocument(sections[1], { schema: "core", uniqueKeys: true, strict: true });
		if (document.errors.length || document.warnings.length) throw new Error();
		// 只取两项字符串标量。其余元数据不转换为对象，别名和脚本声明不参与执行。
		name = document.get("name");
		description = document.get("description");
	} catch {
		throw new Error("技能文件的 YAML 头部无效。");
	}
	if (typeof name !== "string" || typeof description !== "string")
		throw new Error("技能文件须声明文字类型的 name 和 description。");
	name = name.trim();
	description = description.replace(/\s+/gu, " ").trim();
	return normalizeSkill({ kind: "skill", schemaVersion: 1, id: skillId(name), name, description, body: sections[2] });
}

async function readBoundedText(file, limit, message, optional = false) {
	const info = await lstat(file).catch((error) => {
		if (optional && error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!info && optional) return;
	if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error(message);
	const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
			throw new Error(message);
		// 按选择时的大小读入，避免外部应用在打开后持续追加内容。
		const bytes = Buffer.alloc(info.size + 1);
		let consumed = 0;
		while (consumed < bytes.length) {
			const { bytesRead } = await handle.read(bytes, consumed, bytes.length - consumed, consumed);
			if (!bytesRead) break;
			consumed += bytesRead;
		}
		const last = await handle.stat();
		if (consumed !== info.size || last.size !== info.size || last.mtimeMs !== info.mtimeMs) throw new Error(message);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, consumed));
		} catch {
			throw new Error(message);
		}
	} finally {
		await handle.close();
	}
}

function parseJson(text, message) {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(message);
	}
}

function requireWorkspaceId(value) {
	if (typeof value !== "string" || !workspacePattern.test(value)) throw new Error("请选择已授权的工作区。");
}

function publicEntry({ manifest, enabled }) {
	if (manifest.kind === "skill") return { ...skillContent(manifest), enabled };
	return {
		id: manifest.id,
		name: manifest.name,
		description: manifest.description,
		toolName: toolName(manifest),
		action: manifest.action,
		contains: manifest.contains,
		caseSensitive: manifest.caseSensitive,
		maxMatches: manifest.maxMatches,
		enabled,
	};
}

function skillContent({ id, name, description, body }) {
	return { kind: "skill", id, name, description, toolName: toolName({ kind: "skill", id }), body };
}

function toolName({ kind, id }) {
	return `flower_${kind === "skill" ? "skill" : "extension"}_${id.replaceAll("-", "_")}`;
}

/**
 * 读取用户在原生对话框中选定的扩展包。
 * @param {string} absolutePath 主进程从原生对话框得到的本机文件路径
 * @returns {Promise<object>} 可供展示与确认安装的规范化清单
 */
export async function readLocalExtensionPackage(absolutePath) {
	if (typeof absolutePath !== "string" || !isAbsolute(absolutePath)) throw new Error("请选择本机扩展包文件。");
	const suffix = extname(absolutePath).toLowerCase();
	if (suffix === ".md" || suffix === ".markdown") {
		const markdown = await readBoundedText(
			absolutePath,
			packageLimit,
			"技能包须为不超过 16 KiB 的普通 UTF-8 Markdown 文件。",
		);
		return parseSkill(markdown);
	}
	if (suffix !== ".json") throw new Error("请选择 Markdown 技能或 JSON 扩展文件。");
	const message = "扩展包须为不超过 16 KiB 的普通 UTF-8 JSON 文件。";
	return normalizePackage(parseJson(await readBoundedText(absolutePath, packageLimit, message), message));
}

/**
 * 管理指定 Flower 本机资料中的工作区扩展。安装记录由主进程写，工具执行时重新读取。
 * @param {string} directory Flower 本机工作台资料目录
 * @returns 工作区扩展目录、安装操作和只读调用入口
 */
export function createLocalExtensions(directory) {
	const location = join(directory, "local-extensions.json");
	let writes = Promise.resolve();

	async function read() {
		const message = "本机扩展记录无法读取。";
		const text = await readBoundedText(location, storeLimit, message, true);
		if (text === undefined) return [];
		const stored = parseJson(text, message);
		if (stored?.schemaVersion !== 1 || !Array.isArray(stored.entries) || stored.entries.length > profileLimit)
			throw new Error("本机扩展记录格式无效。");
		const seen = new Set();
		return stored.entries.map((entry) => {
			requireWorkspaceId(entry?.workspaceId);
			if (typeof entry.enabled !== "boolean" || typeof entry.token !== "string" || !tokenPattern.test(entry.token))
				throw new Error("本机扩展记录格式无效。");
			const manifest = normalizePackage(entry.manifest);
			const key = `${entry.workspaceId}:${manifest.id}`;
			if (seen.has(key)) throw new Error("本机扩展记录包含重复项。");
			seen.add(key);
			return { workspaceId: entry.workspaceId, enabled: entry.enabled, token: entry.token, manifest };
		});
	}

	function modify(apply) {
		const next = writes.then(async () => {
			const entries = await read();
			const result = apply(entries);
			const next = { schemaVersion: 1, entries };
			if (Buffer.byteLength(JSON.stringify(next)) > storeLimit) throw new Error("本机扩展资料已达到大小上限。");
			await writeJson(location, next);
			return result;
		});
		writes = next.catch(() => {});
		return next;
	}

	function find(entries, workspaceId, id) {
		const index = entries.findIndex((entry) => entry.workspaceId === workspaceId && entry.manifest.id === id);
		if (index < 0) throw new Error("当前工作区未安装该扩展。");
		return index;
	}

	async function current(workspaceId, id, token) {
		const entries = await read();
		const entry = entries[find(entries, workspaceId, id)];
		if (!entry.enabled || (token && entry.token !== token)) throw new Error("扩展已停用或安装状态已变化。");
		return entry;
	}

	async function matchLines(workspace, manifest, path, signal) {
		if (typeof path !== "string" || !path.trim() || path.length > 1024)
			throw new Error("请输入工作区内的相对文本文件路径。");
		const { action, contains, caseSensitive, maxMatches } = manifest;
		// 与普通 Agent 读取使用同一路径和文件大小校验，扩展无权扩大文件访问范围。
		const readText = workspaceTools(workspace, () => "deny").find(({ name }) => name === "read_text_file");
		const data = await readText.execute(undefined, { path }, signal);
		const source = data.content[0].text;
		const lines = source === "" ? [] : source.replace(/(?:\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/);
		const keyword = caseSensitive ? contains : contains.toLowerCase();
		const matches = [];
		let matched = 0;
		let truncated = false;
		for (const [index, line] of lines.entries()) {
			if (!(caseSensitive ? line : line.toLowerCase()).includes(keyword)) continue;
			matched++;
			if (action === "count-lines") continue;
			if (matches.length >= maxMatches) {
				truncated = true;
				continue;
			}
			const characters = [...line];
			if (characters.length > 400) truncated = true;
			matches.push({ line: index + 1, text: characters.slice(0, 400).join("") });
		}
		return { path, examined: lines.length, matched, matches, truncated };
	}

	async function execute(workspace, id, path, signal, token, skillOnly = false) {
		signal?.throwIfAborted();
		requireWorkspaceId(workspace?.id);
		await checkRoot(workspace);
		const entry = await current(workspace.id, id, token);
		const isSkill = entry.manifest.kind === "skill";
		if (skillOnly && !isSkill) throw new Error("请选择 Markdown 技能。");
		const result = isSkill ? skillContent(entry.manifest) : await matchLines(workspace, entry.manifest, path, signal);
		// 避免在读取期间停用、卸载或重新安装后仍交出先前的能力结果。
		await current(workspace.id, id, entry.token);
		await checkRoot(workspace);
		signal?.throwIfAborted();
		return { result, token: entry.token };
	}

	return {
		/**
		 * 列出当前工作区可管理的扩展。
		 * @param {string} workspaceId Host 授权的工作区身份
		 * @returns {Promise<object[]>} 供界面展示的列表
		 */
		async list(workspaceId) {
			requireWorkspaceId(workspaceId);
			return (await read()).filter((entry) => entry.workspaceId === workspaceId).map(publicEntry);
		},
		/**
		 * 安装已核对的扩展包。
		 * @param {string} workspaceId 用户已选中的工作区身份
		 * @param {object} raw 当前确认引用的主进程清单
		 * @returns {Promise<object>} 已安装并启用的扩展
		 */
		install(workspaceId, raw) {
			requireWorkspaceId(workspaceId);
			const manifest = normalizePackage(raw);
			return modify((entries) => {
				const siblings = entries.filter((entry) => entry.workspaceId === workspaceId);
				if (siblings.some((entry) => entry.manifest.id === manifest.id))
					throw new Error("工作区已安装同一扩展。请先卸载旧版本。");
				if (siblings.length >= workspaceLimit || entries.length >= profileLimit)
					throw new Error("已达到本机扩展安装上限。");
				const entry = { workspaceId, manifest, enabled: true, token: randomUUID() };
				entries.push(entry);
				return publicEntry(entry);
			});
		},
		/**
		 * 启用或停用当前工作区的一项扩展。
		 * @param {string} workspaceId 用户已选中的工作区身份
		 * @param {string} id 扩展标识
		 * @param {boolean} enabled 目标启用状态
		 * @returns {Promise<object>} 更新后的扩展
		 */
		setEnabled(workspaceId, id, enabled) {
			requireWorkspaceId(workspaceId);
			if (typeof enabled !== "boolean") throw new Error("无效的扩展状态。");
			return modify((entries) => {
				const entry = entries[find(entries, workspaceId, id)];
				if (entry.enabled !== enabled) entry.token = randomUUID();
				entry.enabled = enabled;
				return publicEntry(entry);
			});
		},
		/**
		 * 从当前工作区移除扩展注册。
		 * @param {string} workspaceId 用户已选中的工作区身份
		 * @param {string} id 扩展标识
		 * @returns {Promise<void>} 删除落盘完成
		 */
		uninstall(workspaceId, id) {
			requireWorkspaceId(workspaceId);
			return modify((entries) => {
				entries.splice(find(entries, workspaceId, id), 1);
			});
		},
		/**
		 * 用当前工作区的已启用扩展直接处理一个文本。
		 * @param {object} workspace 已经批准的工作区
		 * @param {string} id 扩展标识
		 * @param {string} path 工作区相对路径
		 * @param {AbortSignal} [signal] 会话更换或调用取消时使用的信号
		 * @returns {Promise<object>} 有界的匹配结果
		 */
		async run(workspace, id, path, signal) {
			return (await execute(workspace, id, path, signal)).result;
		},
		/**
		 * 校验用户选择的只读 Markdown 技能并返回本次安装令牌。
		 * @param {object} workspace 当前会话已经批准的工作区
		 * @param {string} id 用户选择的技能标识
		 * @param {AbortSignal} [signal] 当前请求的取消信号
		 * @param {string} [token] 提交时绑定的安装令牌
		 * @returns {Promise<object>} 只读说明和仅供宿主使用的令牌
		 */
		async selectedSkill(workspace, id, signal, token) {
			const selected = await execute(workspace, id, undefined, signal, token, true);
			return { ...selected.result, token: selected.token };
		},
		/**
		 * 按本轮授权为 pi 提供工作区已启用的工具。
		 * @param {object} workspace 当前会话授权的工作区
		 * @returns {Promise<object[]>} 有约束参数和真实执行入口的 pi 工具
		 */
		async tools(workspace) {
			requireWorkspaceId(workspace?.id);
			const entries = await read();
			return entries
				.filter((entry) => entry.enabled && entry.workspaceId === workspace.id)
				.map(({ manifest, token }) => {
					const isSkill = manifest.kind === "skill";
					return {
						name: toolName(manifest),
						label: isSkill ? "读取本机技能" : actions[manifest.action],
						// 显示说明取自包。模型工具说明只描述受信实现的操作及数据范围。
						description: isSkill
							? `读取当前工作区已启用的本机技能说明。技能名称为 ${JSON.stringify(manifest.name)}。仅返回 Markdown 文本，脚本及链接只作为文字。`
							: `在指定工作区文本内${actions[manifest.action]}。匹配文字由已安装的本地扩展确定。仅接受工作区相对路径，返回来源行号和统计结果。`,
						parameters: isSkill ? noArguments : pathArgument,
						async execute(_invocation, params, signal) {
							const { result } = await execute(workspace, manifest.id, isSkill ? undefined : params?.path, signal, token);
							return {
								content: [{ type: "text", text: isSkill ? result.body : JSON.stringify(result) }],
								details: result,
							};
						},
					};
				});
		},
	};
}
