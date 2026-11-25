import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { placeholderTitle } from "./session-title.mjs";
import { readJson, writeJson } from "./storage.mjs";

const idPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const writeModes = new Set(["read", "ask", "auto"]);
const intentDirectory = (directory) => join(directory, ".first-send");

function markerPath(directory, id) {
	if (typeof id !== "string" || !idPattern.test(id)) throw new Error("草稿标识无效。");
	return join(intentDirectory(directory), `${id}.json`);
}

async function directoryInfo(path) {
	const info = await lstat(path).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (info && !info.isDirectory()) throw new Error("本机草稿目录位置已变化。");
	return info;
}

/** 登记临时附件归属或首发意图，供两次原子写入之间的恢复使用。
 * @param {string} directory 本机会话目录
 * @param {object} owner 草稿的本机归属
 * @returns {Promise<void>} 只落盘目录与权限信息
 */
export async function saveFirstIntent(directory, { id, workspace, writeMode }) {
	await directoryInfo(directory);
	await directoryInfo(intentDirectory(directory));
	await writeJson(markerPath(directory, id), { id, workspace, writeMode });
}

/** 从实际落盘快照核对首条请求是否已被运行时接受。
 * @param {string} directory 本机会话目录
 * @param {object} owner 草稿的本机归属
 * @returns {Promise<object | undefined>} 已接受的第一条请求
 */
export async function acceptedFirst(directory, { id, workspace }) {
	if (!idPattern.test(id)) throw new Error("草稿标识无效。");
	const file = join(directory, `${id}.json`);
	const info = await lstat(file).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (!info) return;
	if (!info.isFile()) throw new Error("首发记录位置已变化。");
	const snapshot = await readJson(file);
	const first = snapshot?.requests?.[0];
	if (
		snapshot?.version !== 1 ||
		snapshot.workspaceId !== workspace.id ||
		first?.workspaceId !== workspace.id ||
		!idPattern.test(first.requestId) ||
		typeof first.input !== "string"
	) {
		throw new Error("首发记录与草稿不匹配。");
	}
	return first;
}

/** 清除已处理的首发意图，放弃草稿时同时回收其私有附件。
 * @param {string} directory 本机会话目录
 * @param {string} id 草稿 UUID
 * @param {boolean} discard 此草稿未首发且可归还附件副本
 * @returns {Promise<void>} 本地清理完成
 */
export async function finishFirstIntent(directory, id, discard = false) {
	const marker = markerPath(directory, id);
	if (!(await directoryInfo(directory)) || !(await directoryInfo(intentDirectory(directory)))) return;
	if (discard) {
		const assets = join(directory, "attachment-assets");
		if (await directoryInfo(assets)) await rm(join(assets, id), { recursive: true, force: true, maxRetries: 2 });
	}
	await rm(marker, { force: true });
}

/** 启动时还原已经接收的首发，回收仅登记过临时附件的草稿。
 * @param {string} directory 本机会话目录
 * @param {Set<string>} known 当前数据库已登记或待删除的 UUID
 * @returns {Promise<object[]>} 尚未进入工作台索引的会话
 */
export async function recoverFirstSessions(directory, known) {
	if (!(await directoryInfo(directory)) || !(await directoryInfo(intentDirectory(directory)))) return [];
	const recovered = [];
	for (const entry of await readdir(intentDirectory(directory), { withFileTypes: true })) {
		const id = entry.name.slice(0, -5);
		if (!entry.isFile() || !entry.name.endsWith(".json") || !idPattern.test(id)) continue;
		try {
			if (known.has(id)) {
				await finishFirstIntent(directory, id);
				continue;
			}
			const marker = await readJson(markerPath(directory, id));
			if (
				marker?.id !== id ||
				typeof marker.workspace?.root !== "string" ||
				typeof marker.workspace.id !== "string" ||
				!writeModes.has(marker.writeMode)
			)
				continue;
			const first = await acceptedFirst(directory, marker);
			if (first) recovered.push({ ...marker, title: placeholderTitle(first.input) || "新会话" });
			else await finishFirstIntent(directory, id, true);
		} catch {
			// 保留暂不可读的意图与附件，下次打开时仍可恢复。
		}
	}
	return recovered;
}
