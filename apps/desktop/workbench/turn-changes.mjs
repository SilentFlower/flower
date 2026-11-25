import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "./storage.mjs";
import {
	checkRoot,
	inspectGeneratedOutputs,
	isGeneratedOutput,
	undoGeneratedOutputs,
	validOutputReceipt,
} from "./workspace.mjs";

const uid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;

function sessionLedger(directory, session) {
	if (typeof session !== "string" || !uid.test(session)) throw new Error("文件变更的会话无效。");
	return join(directory, "turn-changes", session);
}

function requestLedger(directory, session, requestId) {
	if (typeof requestId !== "string" || !uid.test(requestId)) throw new Error("文件变更的请求无效。");
	return join(sessionLedger(directory, session), requestId);
}

async function ledgerEntries(path) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

async function recordedGroups(directory, workspace, session, requestId) {
	const folder = requestLedger(directory, session, requestId);
	const entries = await ledgerEntries(folder);
	const groups = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json") || !uid.test(entry.name.slice(0, -5))) continue;
		const path = join(folder, entry.name);
		const record = await readJson(path);
		if (!record) continue;
		if (
			record.workspaceId !== workspace.id ||
			!validOutputReceipt(record.receipt) ||
			entry.name !== `${record.receipt.directory.slice("Flower-分析-".length)}.json`
		) {
			throw new Error("文件变更记录与当前工作区不符。");
		}
		groups.push({ path, record });
	}
	return groups;
}

/** 从实际工具回执提取产物路径，兼容无撤销证明的旧记录。
 * @param record 共享运行时返回的真实请求记录
 * @returns 本轮由写入工具报告的固定格式产物
 */
export function turnArtifacts(record) {
	const paths = new Set();
	for (const result of record.toolResults ?? []) {
		if (result.isError || !["analyze_excel", "write_report"].includes(result.toolName)) continue;
		for (const message of result.text ?? []) {
			try {
				const { artifacts } = JSON.parse(message);
				if (Array.isArray(artifacts)) for (const path of artifacts) if (isGeneratedOutput(path)) paths.add(path);
			} catch {}
		}
	}
	return [...paths];
}

/** 将工具独占创建的真实产物组绑定到单条请求。
 * @param directory 本机工作台的会话存储目录
 * @param workspace 运行时绑定的授权工作区
 * @param session 所属会话 ID
 * @param requestId 所属请求 ID
 * @param receipt 工作区写入回执
 * @returns 账本落盘完成的 Promise
 */
export async function recordTurnChanges(directory, workspace, session, requestId, receipt) {
	if (!validOutputReceipt(receipt)) throw new Error("无法验证本轮写入结果。");
	await checkRoot(workspace);
	const folder = requestLedger(directory, session, requestId);
	const key = receipt.directory.slice("Flower-分析-".length);
	// 每个工具独占一个产物目录，独立落盘，避免同一请求多个工具互相覆盖回执。
	await writeJson(join(folder, `${key}.json`), { workspaceId: workspace.id, receipt });
}

/** 列出某会话有实际写入账本的请求，供历史按需显示变更卡。
 * @param directory 本机工作台的会话存储目录
 * @param session 所属会话 ID
 * @returns 有写入账本的请求 ID 集合
 */
export async function recordedTurnChangeIds(directory, session) {
	const entries = await ledgerEntries(sessionLedger(directory, session));
	return new Set(entries.filter((entry) => entry.isDirectory() && uid.test(entry.name)).map(({ name }) => name));
}

async function changeFiles(directory, workspace, session, requestId, artifacts, allowed) {
	await checkRoot(workspace);
	const groups = await recordedGroups(directory, workspace, session, requestId);
	const files = new Map();
	let undone = 0;
	for (const path of artifacts) if (isGeneratedOutput(path)) files.set(path, { path, status: "legacy" });
	for (const { path: ledgerPath, record } of groups) {
		const { receipt } = record;
		const confirmed = allowed === true || (allowed && receipt.files.every(({ path }) => allowed.has(path)));
		let result = await inspectGeneratedOutputs(workspace, receipt, record.recovery);
		if (confirmed && !record.undoneAt && result.status === "ready") {
			const recovery = `.flower-撤销-${randomUUID()}`;
			// 在移动前保存恢复位置，崩溃重启能区分已经移动和仍可重试的产物组。
			await writeJson(ledgerPath, { ...record, recovery });
			result = await undoGeneratedOutputs(workspace, receipt, recovery);
			if (result.moved) {
				undone += receipt.files.length;
				await writeJson(ledgerPath, { ...record, recovery, undoneAt: Date.now() });
			}
		}
		for (const { path } of receipt.files) {
			const { recoveryPath } = result;
			const status = record.undoneAt ? "undone" : result.status;
			files.set(path, recoveryPath ? { path, status, recoveryPath } : { path, status });
		}
	}
	return { files: [...files.values()], undone };
}

/** 返回当前工作区与已核验请求相符的轻量变更预览。
 * @param directory 本机工作台的会话存储目录
 * @param workspace 当前会话授权工作区
 * @param session 所属会话 ID
 * @param requestId 所属请求 ID
 * @param artifacts 已校验的旧回执路径，用于兼容显示
 * @returns 每个产物相对路径、状态及可能的恢复目录
 */
export async function listTurnChanges(directory, workspace, session, requestId, artifacts = []) {
	return (await changeFiles(directory, workspace, session, requestId, artifacts)).files;
}

/** 撤销已由用户明确确认、可核验的当前请求产物。
 * @param directory 本机工作台的会话存储目录
 * @param workspace 当前会话授权工作区
 * @param session 所属会话 ID
 * @param requestId 所属请求 ID
 * @param artifacts 已校验的旧回执路径，用于兼容显示
 * @param allowedPaths 可选，用户在确认时实际看到的产物范围
 * @returns 完整变更预览及本次撤销的文件数量
 */
export async function undoTurnChanges(directory, workspace, session, requestId, artifacts = [], allowedPaths) {
	return changeFiles(
		directory,
		workspace,
		session,
		requestId,
		artifacts,
		allowedPaths === undefined || new Set(allowedPaths),
	);
}
