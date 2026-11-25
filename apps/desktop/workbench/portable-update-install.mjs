import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";

// 安装目录中的 app.asar 是待校验的二进制文件，必须使用绕过 Electron 虚拟目录的文件 API。
const installFs = process.versions.electron ? createRequire(import.meta.url)("original-fs") : fs;
const { constants, createWriteStream } = installFs;
const { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } = installFs.promises;

const executableName = "Flower Desktop.exe";
const product = "Flower Desktop";
const platform = "win32-x64";
const buildMarker = "flower-desktop-build.json";
const managedMarker = ".flower-desktop-managed";
const managedIdentity = "flower-desktop-portable-1";
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maxEntries = 4096;
const maxExpanded = 2 * 1024 ** 3;
const maxFileSize = 512 * 1024 ** 2;
const maxArchive = 1024 ** 3;
const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
const openZip = promisify(yauzl.fromRandomAccessReader);
const preparedVersions = new WeakMap();

function validVersion(version) {
	return typeof version === "string" && version === version.trim() && versionPattern.test(version);
}

function newerThan(version, installed) {
	const before = installed.split(".").map(Number);
	const after = version.split(".").map(Number);
	const firstDifference = before.findIndex((value, index) => value !== after[index]);
	return firstDifference >= 0 && after[firstDifference] > before[firstDifference];
}

function validChannel(channel) {
	return channel === "stable" || channel === "qa";
}

function samePath(first, second) {
	return process.platform === "win32" ? first.toUpperCase() === second.toUpperCase() : first === second;
}

async function directoryAt(path) {
	if (!(await lstat(path)).isDirectory() || !samePath(await realpath(path), path)) {
		throw new Error("Flower Desktop 安装目录位置无效。");
	}
}

function sameFile(first, second) {
	return (
		first.dev === second.dev &&
		first.ino === second.ino &&
		first.size === second.size &&
		first.mtimeNs === second.mtimeNs &&
		first.ctimeNs === second.ctimeNs
	);
}

async function openRegular(path, limit, minimum = 0) {
	const before = await lstat(path, { bigint: true });
	if (!before.isFile() || before.size < BigInt(minimum) || before.size > BigInt(limit) || before.nlink !== 1n) {
		throw new Error("Flower Desktop 更新文件类型或大小无效。");
	}
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		if (!sameFile(before, await handle.stat({ bigint: true }))) throw new Error("更新文件已变化，请重新检查。");
		return { handle, before };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function readText(path, limit) {
	const { handle, before } = await openRegular(path, limit);
	try {
		const buffer = Buffer.alloc(Number(before.size));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== buffer.length || !sameFile(before, await handle.stat({ bigint: true }))) {
			throw new Error("更新文件已变化，请重新检查。");
		}
		return buffer.toString("utf8");
	} finally {
		await handle.close();
	}
}

function versionDirectory(root, version) {
	return join(root, "versions", version);
}

async function verifyExecutable(path) {
	const { handle, before } = await openRegular(path, maxFileSize, 90);
	try {
		const dos = Buffer.alloc(64);
		const { bytesRead } = await handle.read(dos, 0, dos.length, 0);
		const offset = dos.readUInt32LE(60);
		if (
			bytesRead !== dos.length ||
			dos.readUInt16LE(0) !== 0x5a4d ||
			offset < dos.length ||
			offset + 26 > Number(before.size)
		) {
			throw new Error("更新包内的 Windows 可执行文件格式无效。");
		}
		const pe = Buffer.alloc(26);
		const header = await handle.read(pe, 0, pe.length, offset);
		if (
			header.bytesRead !== pe.length ||
			pe.readUInt32LE(0) !== 0x00004550 ||
			pe.readUInt16LE(4) !== 0x8664 ||
			pe.readUInt16LE(24) !== 0x020b
		) {
			throw new Error("更新包内的可执行文件不是 Windows x64。");
		}
	} finally {
		await handle.close();
	}
}

async function verifyIdentity(directory, version, channel) {
	await directoryAt(directory);
	await directoryAt(join(directory, "resources"));
	const marker = JSON.parse(await readText(join(directory, buildMarker), 8192));
	if (
		marker?.product !== product ||
		marker.platform !== platform ||
		marker.version !== version ||
		marker.channel !== channel
	) {
		throw new Error("更新包内的产品、版本、Windows 平台或频道与清单不符。");
	}
	await verifyExecutable(join(directory, executableName));
	const { handle } = await openRegular(join(directory, "resources", "app.asar"), maxFileSize, 1);
	await handle.close();
}

async function verifyCurrent({ root, version, channel }) {
	if (!isAbsolute(root) || !validVersion(version) || !validChannel(channel)) {
		throw new Error("Flower Desktop 便携安装信息无效。");
	}
	await directoryAt(root);
	await directoryAt(join(root, "versions"));
	const { handle } = await openRegular(join(root, executableName), maxFileSize, 1);
	await handle.close();
	if (
		(await readText(join(root, managedMarker), 100)).trimEnd() !== managedIdentity ||
		(await readText(join(root, "current.txt"), 100)).trimEnd() !== version
	) {
		throw new Error("当前运行的 Flower Desktop 与便携启动指针不一致。");
	}
	await verifyIdentity(versionDirectory(root, version), version, channel);
}

/**
 * 根据正在运行的真实可执行文件识别可自动更新的便携安装。
 * @param {string} executable 当前进程的可执行文件绝对路径
 * @param {string} version 包内应用版本
 * @param {"stable" | "qa"} channel 包内更新频道
 * @returns {Promise<{root: string, version: string, channel: string} | undefined>} 校验通过的便携安装
 */
export async function findPortableInstallation(executable, version, channel) {
	if (!validVersion(version) || !validChannel(channel) || typeof executable !== "string" || !isAbsolute(executable)) {
		return undefined;
	}
	const executablePath = resolve(executable);
	const root = dirname(dirname(dirname(executablePath)));
	if (!samePath(executablePath, join(versionDirectory(root, version), executableName))) return undefined;
	try {
		const installation = { root, version, channel };
		await verifyCurrent(installation);
		return installation;
	} catch {
		return undefined;
	}
}

function checkCandidate(installation, candidate) {
	if (
		!validVersion(installation.version) ||
		!validVersion(candidate?.version) ||
		!validChannel(candidate.channel) ||
		candidate.channel !== installation.channel ||
		!newerThan(candidate.version, installation.version) ||
		typeof candidate.digest !== "string" ||
		!digestPattern.test(candidate.digest) ||
		!Number.isSafeInteger(candidate.size) ||
		candidate.size < 22 ||
		candidate.size > maxArchive
	) {
		throw new Error("更新清单的版本、频道或校验信息无效。");
	}
}

async function* readChunks(handle, start, end, signal) {
	while (start < end) {
		signal?.throwIfAborted();
		const buffer = Buffer.allocUnsafe(Math.min(end - start, 256 * 1024));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		if (!bytesRead) throw new Error("读取更新文件时意外结束。");
		start += bytesRead;
		yield buffer.subarray(0, bytesRead);
	}
}

// 摘要核对和解压共享同一个文件句柄，避免路径替换让两步读到不同文件。
class ZipReader extends yauzl.RandomAccessReader {
	constructor(handle) {
		super();
		this.handle = handle;
	}

	_readStreamForRange(start, end) {
		return Readable.from(readChunks(this.handle, start, end), { objectMode: false });
	}
}

function validPart(part) {
	const device = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])$/i;
	return (
		part.length > 0 &&
		part.length <= 255 &&
		!/[<>:"\\|?*\p{Cc}]/u.test(part) &&
		!/[. ]$/.test(part) &&
		!device.test(part.split(".")[0].trimEnd())
	);
}

function nextEntry(zip) {
	return new Promise((resolveEntry, rejectEntry) => {
		function cleanup() {
			zip.off("entry", entry);
			zip.off("end", end);
			zip.off("error", error);
		}
		function entry(value) {
			cleanup();
			resolveEntry(value);
		}
		function end() {
			cleanup();
			resolveEntry(undefined);
		}
		function error(value) {
			cleanup();
			rejectEntry(value);
		}
		zip.on("entry", entry);
		zip.on("end", end);
		zip.on("error", error);
		zip.readEntry();
	});
}

async function archivePlan(zip, signal) {
	if (zip.entryCount > maxEntries) throw new Error("更新包中的文件数量超过上限。");
	const folded = new Map();
	let total = 0;
	for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
		signal?.throwIfAborted();
		const directory = entry.fileName.endsWith("/");
		const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
		const parts = path.split("/");
		const type = (entry.externalFileAttributes >>> 16) & 0o170000;
		if (
			path.length > 512 ||
			parts.length > 16 ||
			!parts.every(validPart) ||
			(type !== 0 && type !== (directory ? 0o040000 : 0o100000)) ||
			entry.externalFileAttributes & 0x400 ||
			entry.generalPurposeBitFlag & 1 ||
			![0, 8].includes(entry.compressionMethod) ||
			entry.uncompressedSize > maxFileSize ||
			(directory && entry.uncompressedSize !== 0)
		) {
			throw new Error("更新包包含不安全的 Windows 路径、文件类型或超限文件。");
		}
		total += entry.uncompressedSize;
		if (total > maxExpanded) throw new Error("更新包解压后的大小超过上限。");

		// Windows 路径按大小写折叠。先登记隐含父目录也能发现路径别名和文件目录冲突。
		for (let index = 0; index < parts.length; index++) {
			const relative = parts.slice(0, index + 1).join("/");
			const key = relative.normalize("NFC").toUpperCase();
			const explicit = index === parts.length - 1;
			const isDirectory = !explicit || directory;
			const existing = folded.get(key);
			if (
				existing &&
				(relative !== existing.relative || !existing.directory || !isDirectory || (explicit && existing.entry))
			) {
				throw new Error("更新包包含重复或冲突的 Windows 路径。");
			}
			if (!existing || explicit) {
				folded.set(key, { relative, directory: isDirectory, entry: explicit ? entry : undefined });
			}
			if (folded.size > maxEntries) throw new Error("更新包中的文件数量超过上限。");
		}
	}
	const entries = new Map(Array.from(folded.values(), (item) => [item.relative, item]));
	for (const required of [buildMarker, executableName, "resources/app.asar"]) {
		const item = entries.get(required);
		if (!item || item.directory || item.entry.uncompressedSize === 0) {
			throw new Error("更新包缺少必要的应用文件。");
		}
	}
	if (entries.get(buildMarker).entry.uncompressedSize > 8192) throw new Error("更新包内的版本标记超限。");
	return entries;
}

async function hashFile(handle, size, signal) {
	const hash = createHash("sha256");
	for await (const chunk of readChunks(handle, 0, size, signal)) hash.update(chunk);
	return hash.digest("hex");
}

function openEntry(zip, entry) {
	return new Promise((resolveEntry, rejectEntry) => {
		zip.openReadStream(entry, (error, stream) => (error ? rejectEntry(error) : resolveEntry(stream)));
	});
}

async function stageFiles(zip, entries, directory, extract, signal) {
	const files = new Map();
	for (const [relative, item] of entries) {
		signal?.throwIfAborted();
		const path = join(directory, relative);
		if (item.directory) {
			if (extract) await mkdir(path);
			continue;
		}
		const source = await openEntry(zip, item.entry);
		const digest = createHash("sha256");
		let crc = 0;
		const consume = (chunk) => {
			digest.update(chunk);
			crc = crc32(chunk, crc);
		};
		if (extract) {
			const meter = new Transform({
				transform(chunk, _encoding, done) {
					consume(chunk);
					done(null, chunk);
				},
			});
			await pipeline(source, meter, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
		} else {
			for await (const chunk of source) {
				signal?.throwIfAborted();
				consume(chunk);
			}
		}
		if (crc !== item.entry.crc32) throw new Error("更新包内的文件校验失败。");
		files.set(relative, { size: item.entry.uncompressedSize, digest: digest.digest("hex") });
	}
	return files;
}

async function verifyTree(root, plan, files, signal, parent = "") {
	signal?.throwIfAborted();
	await directoryAt(join(root, parent));
	let count = 0;
	for (const name of await readdir(join(root, parent))) {
		signal?.throwIfAborted();
		const relative = parent ? `${parent}/${name}` : name;
		const item = plan.get(relative);
		if (!item) throw new Error("已准备的更新目录包含清单之外的文件。请检查安装目录。");
		count++;
		if (item.directory) {
			count += await verifyTree(root, plan, files, signal, relative);
			continue;
		}
		const path = join(root, relative);
		const { size, digest } = files.get(relative);
		const { handle, before } = await openRegular(path, size, size);
		try {
			const actual = size === 0 ? createHash("sha256").digest("hex") : await hashFile(handle, size, signal);
			if (actual !== digest || !sameFile(before, await handle.stat({ bigint: true }))) {
				throw new Error("已准备的更新文件已变化。请检查安装目录。");
			}
		} finally {
			await handle.close();
		}
	}
	return count;
}

async function exists(path) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * 复核发布摘要，验证或准备并列版本目录，供独立启动器接管。
 * @param {{root: string, version: string, channel: string}} installation 当前便携安装
 * @param {string} archivePath 已下载的正式制品路径
 * @param {{version: string, digest: string, size: number, channel: string}} candidate 受信清单中的制品信息
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<string>} 已验证待启用版本目录
 */
export async function stagePortableVersion(installation, archivePath, candidate, signal) {
	signal?.throwIfAborted();
	checkCandidate(installation, candidate);
	await verifyCurrent(installation);
	const destination = versionDirectory(installation.root, candidate.version);
	const { handle, before } = await openRegular(archivePath, candidate.size, candidate.size);
	let zip;
	let temporary;
	try {
		if ((await hashFile(handle, candidate.size, signal)) !== candidate.digest)
			throw new Error("更新包 SHA-256 校验失败。");
		zip = await openZip(new ZipReader(handle), candidate.size, {
			lazyEntries: true,
			autoClose: false,
			strictFileNames: true,
		});
		const plan = await archivePlan(zip, signal);
		const reuse = await exists(destination);
		if (!reuse) temporary = await mkdtemp(join(dirname(destination), ".prepare-"));
		const staged = temporary ?? destination;
		const files = await stageFiles(zip, plan, staged, !reuse, signal);
		await verifyIdentity(staged, candidate.version, candidate.channel);
		if (!sameFile(before, await handle.stat({ bigint: true }))) throw new Error("更新包已变化，请重新检查。");
		if ((await verifyTree(staged, plan, files, signal)) !== plan.size) throw new Error("已准备的更新缺少清单文件。");
		await verifyCurrent(installation);
		signal?.throwIfAborted();
		if (temporary) {
			await rename(temporary, destination);
			temporary = undefined;
		}
		preparedVersions.set(installation, {
			version: candidate.version,
			digest: candidate.digest,
			size: candidate.size,
			plan,
			files,
		});
		return destination;
	} finally {
		zip?.close();
		await handle.close();
		if (temporary) await rm(temporary, { recursive: true, force: true });
	}
}

/**
 * 启动独立助手并等候其确认绑定了当前进程，调用方收到成功后可退出。
 * @param {{root: string, version: string, channel: string}} installation 当前便携安装
 * @param {{version: string, digest: string, size: number, channel: string}} candidate 已复核的待启用版本
 * @param {{restart: boolean, userData: string}} options 更新后是否重启及要沿用的资料目录
 * @returns {Promise<void>} 助手已准备好接管的确认
 */
export async function startPortableUpdate(installation, candidate, { restart, userData }) {
	checkCandidate(installation, candidate);
	const prepared = preparedVersions.get(installation);
	if (
		prepared?.version !== candidate.version ||
		prepared.digest !== candidate.digest ||
		prepared.size !== candidate.size ||
		typeof restart !== "boolean" ||
		typeof userData !== "string" ||
		!isAbsolute(userData)
	) {
		throw new Error("新版尚未通过本机安装复核。");
	}
	await verifyCurrent(installation);
	const target = versionDirectory(installation.root, candidate.version);
	await verifyIdentity(target, candidate.version, candidate.channel);
	if ((await verifyTree(target, prepared.plan, prepared.files, AbortSignal.timeout(90000))) !== prepared.plan.size) {
		throw new Error("已准备的更新缺少清单文件。");
	}
	const nonce = randomBytes(16).toString("hex");
	const acknowledgement = join(installation.root, `.flower-update-${nonce}.ready`);
	const helper = spawn(
		join(installation.root, executableName),
		[
			"--flower-apply-update",
			String(process.pid),
			installation.version,
			candidate.version,
			restart ? "restart" : "exit",
			// 既有便携启动器按完整路径校验资料目录，先展开 Windows 用户名的 8.3 别名。
			await realpath(userData),
			nonce,
		],
		{ cwd: installation.root, detached: true, stdio: "ignore", windowsHide: true },
	);
	let didExit = false;
	helper.once("error", () => {
		didExit = true;
	});
	helper.once("exit", () => {
		didExit = true;
	});
	const timeout = Date.now() + 8000;
	try {
		while (!didExit && Date.now() < timeout) {
			// 助手先创建回执再写入。文件可见但尚未写完时，继续等完整 nonce。
			const ready = await readText(acknowledgement, 64).catch(() => "");
			if (ready === `${nonce}\n` && !didExit) {
				helper.unref();
				return;
			}
			await setTimeout(50);
		}
		throw new Error("更新助手未准备好。可继续使用当前版本，稍后重试。");
	} catch (error) {
		if (!didExit) helper.kill();
		await rm(acknowledgement, { force: true }).catch(() => {});
		throw error;
	}
}
