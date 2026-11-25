import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import JSZip from "jszip";
import {
	findPortableInstallation,
	stagePortableVersion,
	startPortableUpdate,
} from "../workbench/portable-update-install.mjs";

const oldVersion = "0.1.0";
const newVersion = "0.1.1";
const executable = "Flower Desktop.exe";
const markerName = "flower-desktop-build.json";
const validMarker = (version) => ({ product: "Flower Desktop", platform: "win32-x64", channel: "qa", version });

function windowsExecutable(id, machine = 0x8664) {
	const header = Buffer.alloc(96);
	header.writeUInt16LE(0x5a4d, 0);
	header.writeUInt32LE(64, 60);
	header.writeUInt32LE(0x00004550, 64);
	header.writeUInt16LE(machine, 68);
	header.writeUInt16LE(0x020b, 88);
	return Buffer.concat([header, Buffer.from(id)]);
}

async function fixture(context) {
	const base = await mkdtemp(join(await realpath(tmpdir()), "flower-stage-"));
	context.after(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "Portable Flower");
	const current = join(root, "versions", oldVersion);
	await mkdir(join(current, "resources"), { recursive: true });
	await Promise.all([
		writeFile(join(root, executable), "MZ root"),
		writeFile(join(root, ".flower-desktop-managed"), "flower-desktop-portable-1\n"),
		writeFile(join(root, "current.txt"), `${oldVersion}\n`),
		writeFile(join(current, executable), windowsExecutable("current")),
		writeFile(join(current, "resources", "app.asar"), "old archive"),
		writeFile(join(current, markerName), JSON.stringify(validMarker(oldVersion))),
	]);
	const running = join(current, executable);
	const installation = await findPortableInstallation(running, oldVersion, "qa");
	assert.deepEqual(installation, { root, version: oldVersion, channel: "qa" });
	return { base, root, installation, running, destination: join(root, "versions", newVersion) };
}

async function release(base, edit = () => {}, editArchive = () => {}) {
	const zip = new JSZip();
	zip.file(executable, windowsExecutable("new"));
	zip.file(markerName, JSON.stringify(validMarker(newVersion)));
	zip.file("resources/app.asar", "new archive");
	zip.file("locales/zh-CN.pak", "语言");
	zip.file("resources/empty.txt", "");
	edit(zip);
	const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
	editArchive(bytes);
	const zipFile = join(base, "release.zip");
	await writeFile(zipFile, bytes);
	return {
		zipFile,
		candidate: {
			version: newVersion,
			digest: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.length,
			channel: "qa",
		},
	};
}

test("准备真实 ZIP 后从新进程条件完整复核，当前文件和指针保持有效", async (context) => {
	const { base, root, installation, running, destination } = await fixture(context);
	const { zipFile, candidate } = await release(base);
	assert.equal(await stagePortableVersion(installation, zipFile, candidate), destination);
	assert.equal(await readFile(join(destination, "resources", "app.asar"), "utf8"), "new archive");
	assert.equal(await readFile(join(destination, "locales", "zh-CN.pak"), "utf8"), "语言");
	assert.equal(await readFile(join(root, "current.txt"), "utf8"), `${oldVersion}\n`);
	assert.deepEqual(await readFile(running), windowsExecutable("current"));

	const reopened = await findPortableInstallation(running, oldVersion, "qa");
	assert.equal(await stagePortableVersion(reopened, zipFile, candidate), destination);
	await writeFile(join(destination, "resources", "app.asar"), "old archive");
	await assert.rejects(startPortableUpdate(reopened, candidate, { restart: true, userData: base }), /已变化/);
	await assert.rejects(stagePortableVersion(reopened, zipFile, candidate), /已变化/);
	assert.equal(await readFile(join(root, "current.txt"), "utf8"), `${oldVersion}\n`);
});

test("拒绝复用带多余文件的目标及篡改或失效的更新包", async (context) => {
	const { base, root, installation, destination } = await fixture(context);
	const { zipFile, candidate } = await release(base);
	await assert.rejects(stagePortableVersion(installation, zipFile, { ...candidate, digest: "0".repeat(64) }), /SHA-256/);
	await assert.rejects(
		stagePortableVersion(installation, zipFile, { ...candidate, size: candidate.size - 1 }),
		/大小无效/,
	);
	await assert.rejects(stagePortableVersion(installation, zipFile, { ...candidate, version: "0.0.9" }), /版本/);
	const signal = AbortSignal.abort();
	await assert.rejects(stagePortableVersion(installation, zipFile, candidate, signal), { name: "AbortError" });
	assert.deepEqual(await readdir(join(root, "versions")), [oldVersion]);
	await stagePortableVersion(installation, zipFile, candidate);
	await writeFile(join(destination, "foreign.dll"), "extra");
	await assert.rejects(stagePortableVersion(installation, zipFile, candidate), /清单之外/);
	await assert.rejects(startPortableUpdate(installation, candidate, { restart: true, userData: base }), /清单之外/);
});

test("只识别运行中的原生便携版本树、频道和当前指针", async (context) => {
	const { root, running } = await fixture(context);
	assert.equal(await findPortableInstallation(join(root, executable), oldVersion, "qa"), undefined);
	assert.equal(await findPortableInstallation(running, oldVersion, "stable"), undefined);
	await writeFile(join(root, "current.txt"), `${newVersion}\n`);
	assert.equal(await findPortableInstallation(running, oldVersion, "qa"), undefined);
});

test("拒绝不安全 Windows ZIP 文件、碰撞和错误的包内身份", async (context) => {
	const { base, root, installation } = await fixture(context);
	const invalid = [
		["越界", (zip) => zip.file("../escape.txt", "逃逸", { createFolders: false }), /invalid relative path/],
		["设备名", (zip) => zip.file("locales/COM¹.txt", "设备"), /不安全/],
		["ADS", (zip) => zip.file("locales/test.txt:backup", "ADS"), /不安全/],
		["尾随点", (zip) => zip.file("locales/name.", "."), /不安全/],
		["别名碰撞", (zip) => zip.file("Locales/other.pak", "目录"), /冲突/],
		["同名碰撞", (zip) => zip.file("locales/ZH-cn.pak", "文件"), /冲突/],
		["软链接", (zip) => zip.file("symlink", "..", { unixPermissions: 0o120777 }), /不安全/],
		["特殊文件", (zip) => zip.file("fifo", "", { unixPermissions: 0o010644 }), /不安全/],
		["缺少应用", (zip) => zip.remove("resources/app.asar"), /缺少必要/],
		["错误版本", (zip) => zip.file(markerName, JSON.stringify(validMarker(oldVersion))), /清单不符/],
		[
			"错误平台",
			(zip) => zip.file(markerName, JSON.stringify({ ...validMarker(newVersion), platform: "linux-x64" })),
			/清单不符/,
		],
		["错误架构", (zip) => zip.file(executable, windowsExecutable("wrong", 0xaa64)), /不是 Windows x64/],
		[
			"错误频道",
			(zip) => zip.file(markerName, JSON.stringify({ ...validMarker(newVersion), channel: "stable" })),
			/清单不符/,
		],
	];
	for (const [name, edit, expected] of invalid) {
		await context.test(name, async () => {
			const { zipFile, candidate } = await release(base, edit);
			await assert.rejects(stagePortableVersion(installation, zipFile, candidate), expected);
			assert.deepEqual(await readdir(join(root, "versions")), [oldVersion]);
			assert.equal(await readFile(join(root, "current.txt"), "utf8"), `${oldVersion}\n`);
		});
	}
});

test("摘要匹配的 ZIP 也拒绝损坏内容与超限声明", async (context) => {
	const { base, root, installation } = await fixture(context);
	const central = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
	const edits = [
		["错误 CRC", (bytes, offset) => bytes.writeUInt32LE(0, offset + 16), /文件校验失败/],
		["大于 512 MiB 的单文件", (bytes, offset) => bytes.writeUInt32LE(512 * 1024 ** 2 + 1, offset + 24), /超限文件/],
	];
	for (const [name, edit, error] of edits) {
		await context.test(name, async () => {
			const { zipFile, candidate } = await release(base, undefined, (bytes) => {
				const offset = bytes.indexOf(central);
				assert.ok(offset >= 0);
				edit(bytes, offset);
			});
			await assert.rejects(stagePortableVersion(installation, zipFile, candidate), error);
			assert.deepEqual(await readdir(join(root, "versions")), [oldVersion]);
		});
	}
});

test("中途取消解压回收临时版本，之后可重新从发布包准备", async (context) => {
	const { base, root, installation, destination } = await fixture(context);
	const { zipFile, candidate } = await release(base, (zip) => {
		zip.file("resources/synthetic.bin", Buffer.alloc(6 * 1024 ** 2, 0x3f));
	});
	const cancellation = new AbortController();
	const installing = stagePortableVersion(installation, zipFile, candidate, cancellation.signal);
	const aborted = assert.rejects(installing, { name: "AbortError" });
	void aborted.catch(() => {});
	const deadline = Date.now() + 10000;
	while (!cancellation.signal.aborted && Date.now() < deadline) {
		if ((await readdir(join(root, "versions"))).some((name) => name.startsWith(".prepare-"))) cancellation.abort();
		else await setTimeout(2);
	}
	await aborted;
	assert.deepEqual(await readdir(join(root, "versions")), [oldVersion]);
	assert.equal(await stagePortableVersion(installation, zipFile, candidate), destination);
});

test("目标版本目录为符号链接时拒绝复用", { skip: process.platform === "win32" }, async (context) => {
	const { base, root, installation, destination } = await fixture(context);
	const { zipFile, candidate } = await release(base);
	await symlink(join(root, "versions", oldVersion), destination, "dir");
	await assert.rejects(stagePortableVersion(installation, zipFile, candidate), /目录位置无效/);
	assert.equal(await readFile(join(root, "current.txt"), "utf8"), `${oldVersion}\n`);
});

test("助手必须确认本次父进程、动作和资料目录后才可退出", { skip: process.platform === "win32" }, async (context) => {
	const { base, root, installation } = await fixture(context);
	const { zipFile, candidate } = await release(base);
	const argsFile = join(root, "received");
	const launcher = join(root, executable);
	await writeFile(
		launcher,
		`#!/bin/sh
printf '%s\\n' "$@" > received
printf '%s\\n' "$7" > ".flower-update-$7.ready"
sleep 1
`,
	);
	await chmod(launcher, 0o700);
	await stagePortableVersion(installation, zipFile, candidate);
	// 检查下一版失败后，已经准备好的候选仍可按原授权安装。
	await assert.rejects(
		stagePortableVersion(installation, zipFile, { ...candidate, version: "0.1.2", digest: "0".repeat(64) }),
		/SHA-256/,
	);
	const profile = join(base, "用户资料");
	const alias = join(base, "profile-alias");
	await mkdir(profile);
	await symlink(profile, alias, "dir");
	await startPortableUpdate(installation, candidate, { restart: true, userData: alias });
	const args = (await readFile(argsFile, "utf8")).trimEnd().split("\n");
	assert.deepEqual(args.slice(0, 6), [
		"--flower-apply-update",
		String(process.pid),
		oldVersion,
		newVersion,
		"restart",
		profile,
	]);
	assert.match(args[6], /^[a-f0-9]{32}$/);
	assert.equal(await readFile(join(root, "current.txt"), "utf8"), `${oldVersion}\n`);
});
