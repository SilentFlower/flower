import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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

/** 在 Windows 读句柄暂时禁止替换时，重用已经刷盘的临时文件。
 * @param temporary 本次写入独占的同目录临时文件
 * @param path 最终文件路径
 * @returns 原子替换完成的 Promise
 */
async function replaceJson(temporary, path) {
	for (let wait = 20; ; wait *= 2) {
		try {
			await rename(temporary, path);
			return;
		} catch (error) {
			// Windows 读取者可禁止删除共享，关闭句柄后同一次 rename 就能成功。
			if (process.platform !== "win32" || !["EBUSY", "EPERM", "EACCES"].includes(error.code) || wait > 640) throw error;
			await delay(wait);
		}
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
		await replaceJson(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
