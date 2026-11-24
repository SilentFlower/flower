import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 为本机工作区生成固定长度的本机路径标识。
 * @param value 受信任的分区信息
 * @returns 文件名安全的哈希
 */
export function storageKey(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 读取可选的本机 JSON 文件。
 * @param path Host 构造的路径
 * @returns 已保存的 JSON，文件不存在时为空
 */
export async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** 原子替换工作台资料或加密设置。
 * @param path Host 构造的路径
 * @param value 需要保存的 JSON
 * @returns 落盘完成的 Promise
 */
export async function writeJson(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
