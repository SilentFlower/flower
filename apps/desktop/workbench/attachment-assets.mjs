import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";
import {
	approveWorkspace,
	canAttachWorkspaceFile,
	previewWorkspaceFile,
	readAttachmentEvidence,
} from "./workspace.mjs";

const sessionPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const assetPattern = /^asset:([a-f\d]{64})$/;
const fileLimit = 16 * 1024 * 1024;
const imageLimit = 4 * 1024 * 1024;
const imageFilename = /\.(png|jpe?g|jpe|jfif|webp)$/i;
const readFlags = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function sessionId(session) {
	if (typeof session !== "string" || !sessionPattern.test(session)) throw new Error("附件会话标识无效。");
	return session.toLowerCase();
}

function safeName(name) {
	if (
		typeof name !== "string" ||
		!name ||
		(process.platform === "win32" ? name.length : Buffer.byteLength(name)) > 255 ||
		win32.basename(name) !== name ||
		/[:*?"<>|]/.test(name) ||
		/[. ]$/.test(name) ||
		[...name].some((character) => character.charCodeAt(0) < 32) ||
		/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i.test(name)
	) {
		throw new Error("附件文件名无效。");
	}
	return name;
}

const samePath = (left, right) =>
	process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameFile = (left, right) =>
	right.isFile() &&
	sameIdentity(left, right) &&
	left.size === right.size &&
	left.mtimeMs === right.mtimeMs &&
	left.ctimeMs === right.ctimeMs;

function makeRef(session, name, bytes) {
	const hash = createHash("sha256")
		.update(JSON.stringify([session, name]))
		.update(bytes)
		.digest("hex");
	return { id: `asset:${hash}`, name };
}

async function readSelectedFile(path, limit, signal) {
	signal?.throwIfAborted();
	const before = await lstat(path);
	if (!before.isFile()) throw new Error("只能导入或读取普通文件。");
	if (before.size > limit) throw new Error("附件超过读取上限。");
	const actual = await realpath(path);
	const handle = await open(actual, readFlags);
	try {
		const opened = await handle.stat();
		if (!sameFile(before, opened) || !sameFile(opened, await lstat(path))) throw new Error("附件位置或内容已变化。");
		const bytes = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset !== bytes.length || !sameFile(opened, await handle.stat()) || !sameFile(opened, await lstat(path))) {
			throw new Error("附件位置或内容已变化。");
		}
		signal?.throwIfAborted();
		return { bytes, info: opened };
	} finally {
		await handle.close();
	}
}

async function ensurePrivateDirectory(path) {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
}

async function ownDirectory(path) {
	const info = await lstat(path);
	if (!info.isDirectory()) throw new Error("附件目录无效。");
	const workspace = await approveWorkspace(path);
	if (!samePath(workspace.root, path) || !sameIdentity(info, workspace)) throw new Error("附件目录位置已变化。");
	return workspace;
}

async function sessionFolder(directory, session, create = false) {
	if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("附件存储目录无效。");
	if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await lstat(resolve(directory))).isDirectory()) throw new Error("附件存储目录无效。");
	const assets = join(await realpath(directory), "attachment-assets");
	if (create) await ensurePrivateDirectory(assets);
	await ownDirectory(assets);
	const path = join(assets, session);
	if (create) await ensurePrivateDirectory(path);
	return ownDirectory(path);
}

async function storedFile(directory, session, ref, signal) {
	signal?.throwIfAborted();
	const owner = sessionId(session);
	const token = typeof ref?.id === "string" ? assetPattern.exec(ref.id)?.[1] : undefined;
	if (!token) throw new Error("附件引用无效。");
	const name = safeName(ref.name);
	if (!canAttachWorkspaceFile(name)) throw new Error("附件引用的文件格式无效。");
	const ownerFolder = await sessionFolder(directory, owner);
	const workspace = await ownDirectory(join(ownerFolder.root, token));
	const entries = await readdir(workspace.root, { withFileTypes: true });
	if (entries.length !== 1 || entries[0].name !== name || !entries[0].isFile())
		throw new Error("附件引用与快照不匹配。");
	const path = join(workspace.root, name);
	const { bytes, info } = await readSelectedFile(path, imageFilename.test(name) ? imageLimit : fileLimit, signal);
	if (makeRef(owner, name, bytes).id !== ref.id) throw new Error("附件引用与快照不匹配。");
	return { workspace, name, path, info };
}

async function confirmStoredFile({ workspace, path, info }) {
	const current = await ownDirectory(workspace.root);
	if (!sameIdentity(workspace, current) || !sameFile(info, await lstat(path))) throw new Error("附件快照已变化。");
}

async function storeFile(directory, session, name, bytes, expectedMime) {
	if (!canAttachWorkspaceFile(name)) throw new Error("该文件格式暂不支持作为附件。");
	const ref = makeRef(session, name, bytes);
	const owner = await sessionFolder(directory, session, true);
	const target = join(owner.root, ref.id.slice("asset:".length));
	const temporary = await mkdtemp(join(owner.root, ".import-"));
	try {
		await writeFile(join(temporary, name), bytes, { flag: "wx", mode: 0o600, flush: true });
		const preview = await previewWorkspaceFile(await ownDirectory(temporary), name);
		if (expectedMime && (preview.kind !== "image" || preview.mime !== expectedMime)) {
			throw new Error("截图内容不是有效的 PNG 图片。");
		}
		if (preview.kind === "image" && bytes.length > imageLimit) throw new Error("附件图片超过 4 MiB。");
		if (!sameIdentity(owner, await sessionFolder(directory, session))) throw new Error("附件目录位置已变化。");
		// 完整写入并校验后再公布 ID。并发导入同一快照时复用已经存在的记录。
		try {
			await rename(temporary, target);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
			await storedFile(directory, session, ref);
		}
		return ref;
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

/** 从用户明确选择的单个绝对路径导入会话附件快照。
 * @param directory Host 与 worker 共用的 sessions 目录
 * @param session 附件所属会话 UUID
 * @param absolutePath 由 Host 获得的原生绝对文件路径
 * @returns 可持久化的附件引用，包含 id 和文件名
 */
export async function importAttachmentFile(directory, session, absolutePath) {
	const owner = sessionId(session);
	if (typeof absolutePath !== "string" || !isAbsolute(absolutePath) || absolutePath.includes("\0")) {
		throw new Error("请选择一个本机文件。");
	}
	const name = safeName(basename(absolutePath));
	if (!canAttachWorkspaceFile(name)) throw new Error("该文件格式暂不支持作为附件。");
	const { bytes } = await readSelectedFile(absolutePath, imageFilename.test(name) ? imageLimit : fileLimit);
	return storeFile(directory, owner, name, bytes);
}

/** 导入明确粘贴或选取的 PNG 截图。
 * @param directory Host 与 worker 共用的 sessions 目录
 * @param session 附件所属会话 UUID
 * @param pngBytes PNG 原始字节
 * @param displayName 截图显示文件名，非 .png 结尾时补上 .png
 * @returns 可持久化的附件引用，包含 id 和文件名
 */
export async function importAttachmentImage(directory, session, pngBytes, displayName = "截图.png") {
	const owner = sessionId(session);
	const bytes = pngBytes instanceof ArrayBuffer ? new Uint8Array(pngBytes) : pngBytes;
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > imageLimit) {
		throw new Error("请选择不超过 4 MiB 的 PNG 截图。");
	}
	const filename = safeName(displayName);
	const name = /\.png$/i.test(filename) ? filename : safeName(`${filename}.png`);
	return storeFile(directory, owner, name, Buffer.from(bytes), "image/png");
}

/** 读取当前会话中已保存的附件证据。
 * @param directory Host 与 worker 共用的 sessions 目录
 * @param session 当前会话 UUID
 * @param ref 导入时返回的 {id, name}
 * @param signal 当前任务取消信号
 * @returns 可交给 pi 的附件内容块
 */
export async function readStoredEvidence(directory, session, ref, signal) {
	const stored = await storedFile(directory, session, ref, signal);
	const evidence = await readAttachmentEvidence(stored.workspace, stored.name, signal);
	await confirmStoredFile(stored);
	signal?.throwIfAborted();
	return evidence;
}

/** 为 worker 的全量读取工具解析单个附件的内部快照。
 * @param directory Host 与 worker 共用的 sessions 目录
 * @param session 当前会话 UUID
 * @param ref 导入时返回的 {id, name}
 * @param signal 当前任务取消信号
 * @returns 单附件快照目录和相对文件名，仅用于内部读取该文件
 */
export async function resolveStoredSource(directory, session, ref, signal) {
	const stored = await storedFile(directory, session, ref, signal);
	await confirmStoredFile(stored);
	signal?.throwIfAborted();
	return { workspace: stored.workspace, path: stored.name };
}

/** 读取当前会话导入的文件，并在读取后复核副本身份。
 * @param directory 会话记录目录 @param session 会话标识 @param ref 已校验归属的附件
 * @param signal 取消信号 @returns 工作区阅读器使用的预览内容
 */
export async function readStoredPreview(directory, session, ref, signal) {
	const stored = await storedFile(directory, session, ref, signal);
	const preview = await previewWorkspaceFile(stored.workspace, stored.name, signal);
	await confirmStoredFile(stored);
	signal?.throwIfAborted();
	return preview;
}

/** 读取当前会话中的原始图片快照。
 * @param directory Host 与 worker 共用的 sessions 目录
 * @param session 当前会话 UUID
 * @param ref 导入时返回的 {id, name}
 * @param signal 当前预览取消信号
 * @returns MIME 类型和 Uint8Array 原始字节
 */
export async function readStoredImage(directory, session, ref, signal) {
	if (!imageFilename.test(ref?.name)) throw new Error("该附件不是可预览的图片。");
	const preview = await readStoredPreview(directory, session, ref, signal);
	if (preview.kind !== "image") throw new Error("该附件不是可预览的图片。");
	return { mime: preview.mime, bytes: preview.bytes };
}

/** 仅移除当前会话指定的附件快照，调用方负责保留已发送的引用。
 * @param directory Host 与 worker 共用的 sessions 目录
 * @param session 当前会话 UUID
 * @param ref 导入时返回的 {id, name}
 * @returns 本次是否删除了附件
 */
export async function removeStoredAttachment(directory, session, ref) {
	try {
		const stored = await storedFile(directory, session, ref);
		await confirmStoredFile(stored);
		await unlink(stored.path);
		await rmdir(stored.workspace.root).catch((error) => {
			if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
		});
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
