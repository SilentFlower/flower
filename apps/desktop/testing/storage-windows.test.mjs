import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readJson, writeJson } from "../workbench/storage.mjs";

/** 用普通 Windows 读句柄禁止替换，直到测试释放它。
 * @param t 测试上下文，负责清理子进程与临时文件
 * @returns 原文件、目录及释放句柄的操作
 */
async function lockedSnapshot(t) {
	const directory = await mkdtemp(join(tmpdir(), "flower-session-lock-"));
	const path = join(directory, "session.json");
	await writeJson(path, { text: "前半句" });
	const reader = spawn(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$f=[IO.File]::Open($env:FLOWER_TEST_FILE,'Open','Read','ReadWrite');try{[Console]::WriteLine('ready');[Console]::Out.Flush();[void][Console]::ReadLine()}finally{$f.Dispose()}",
		],
		{ env: { ...process.env, FLOWER_TEST_FILE: path }, windowsHide: true },
	);
	const closed = once(reader, "exit");
	const release = () => reader.stdin.end();
	t.after(async () => {
		release();
		await closed;
		await rm(directory, { recursive: true, force: true });
	});
	await Promise.race([
		once(reader.stdout, "data"),
		closed.then(() => {
			throw new Error("测试读句柄未就绪");
		}),
	]);
	return { directory, path, release };
}

test("Windows 读句柄短暂占用时，原子替换在释放后完成", { skip: process.platform !== "win32" }, async (t) => {
	const { directory, path, release } = await lockedSnapshot(t);
	const unlock = delay(200).then(release);
	await writeJson(path, { text: "完整回复" });
	await unlock;
	assert.deepEqual(await readJson(path), { text: "完整回复" });
	assert.deepEqual(await readdir(directory), ["session.json"]);
});

test("Windows 文件持续占用时，保留上次快照并清理临时文件", { skip: process.platform !== "win32" }, async (t) => {
	const { directory, path } = await lockedSnapshot(t);
	await assert.rejects(writeJson(path, { text: "新回复" }), (error) =>
		["EBUSY", "EACCES", "EPERM"].includes(error.code),
	);
	assert.deepEqual(await readJson(path), { text: "前半句" });
	assert.deepEqual(await readdir(directory), ["session.json"]);
});
