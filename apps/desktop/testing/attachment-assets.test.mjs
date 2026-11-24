import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Excel from "exceljs";
import {
	importAttachmentFile,
	importAttachmentImage,
	readStoredEvidence,
	readStoredImage,
	removeStoredAttachment,
	resolveStoredSource,
} from "../workbench/attachment-assets.mjs";
import { approveWorkspace, isWorkspacePath } from "../workbench/workspace.mjs";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC",
	"base64",
);

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "flower-attachment-assets-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, directory: join(root, "sessions"), session: randomUUID() };
}

test("外部文件仅复制所选项，同名同内容并发去重，原文件变化后仍读取旧快照", async (t) => {
	const { root, directory, session } = await fixture(t);
	const workspacePath = join(root, "workspace");
	const path = join(root, "外部报价.csv");
	await mkdir(workspacePath);
	await writeFile(path, "产品,金额\n花盆,13\n");
	await writeFile(join(root, "其他.txt"), "旁边的文件");
	const workspace = await approveWorkspace(workspacePath);
	assert.equal(isWorkspacePath(workspace, path), false);
	assert.equal(isWorkspacePath(workspace, join(workspacePath, "文件.txt")), true);
	assert.equal(isWorkspacePath(workspace, "文件.txt"), false);
	const [first, duplicate] = await Promise.all([
		importAttachmentFile(directory, session, path),
		importAttachmentFile(directory, session, path),
	]);
	assert.deepEqual(first, duplicate);
	assert.deepEqual(Object.keys(first).sort(), ["id", "name"]);
	assert.equal(first.name, "外部报价.csv");
	assert.match(first.id, /^asset:[a-f\d]{64}$/);
	const owned = join(directory, "attachment-assets", session);
	assert.deepEqual(await readdir(owned), [first.id.slice(6)]);
	assert.deepEqual(await readdir(join(owned, first.id.slice(6))), [first.name]);
	await writeFile(path, "产品,金额\n花盆,99\n");
	const updated = await importAttachmentFile(directory, session, path);
	assert.notEqual(updated.id, first.id);
	const [oldEvidence] = await readStoredEvidence(directory, session, first);
	assert.match(oldEvidence.text, /记录 2｜\["花盆","13"\]/);
	assert.match((await readStoredEvidence(directory, session, updated))[0].text, /"99"/);
	await assert.rejects(readStoredImage(directory, session, first), /不是可预览的图片/);
	await assert.rejects(readStoredEvidence(directory, session, first, AbortSignal.abort()), { name: "AbortError" });
});

test("内部来源解析返回单文件快照及相对文件名，可读取完整工作簿", async (t) => {
	const { root, directory, session } = await fixture(t);
	const name = "预算.xlsx";
	const source = join(root, name);
	const book = new Excel.Workbook();
	const sheet = book.addWorksheet("明细");
	sheet.getCell("A1").value = "金额";
	sheet.getCell("A500").value = 500;
	await book.xlsx.writeFile(source);
	const ref = await importAttachmentFile(directory, session, source);
	const { workspace, path } = await resolveStoredSource(directory, session, ref);
	assert.equal(path, name);
	assert.deepEqual(await readdir(workspace.root), [name]);
	assert.notEqual(workspace.root, root);
	const copied = await new Excel.Workbook().xlsx.readFile(join(workspace.root, path));
	assert.equal(copied.getWorksheet("明细").getCell("A500").value, 500);
	await assert.rejects(resolveStoredSource(directory, randomUUID(), ref), { code: "ENOENT" });
	await assert.rejects(resolveStoredSource(directory, session, ref, AbortSignal.abort()), { name: "AbortError" });
});

test("PNG 快照跨进程读取，引用绑定会话和文件名并可定点删除", async (t) => {
	const { root, directory, session } = await fixture(t);
	const other = randomUUID();
	const ref = await importAttachmentImage(directory, session, png, "截图");
	assert.equal(ref.name, "截图.png");
	assert.deepEqual(await importAttachmentImage(directory, session, png, "截图.png"), ref);
	const selected = join(root, ref.name);
	await writeFile(selected, png);
	assert.deepEqual(await importAttachmentFile(directory, session, selected), ref);
	const otherRef = await importAttachmentImage(directory, other, png, "截图");
	assert.notEqual(otherRef.id, ref.id);
	await assert.rejects(readStoredImage(directory, other, ref), { code: "ENOENT" });
	assert.equal(await removeStoredAttachment(directory, other, ref), false);
	await assert.rejects(removeStoredAttachment(directory, session, { ...ref, name: "另一张.png" }), /快照不匹配/);
	await assert.rejects(readStoredEvidence(directory, session, { ...ref, name: "../截图.png" }), /文件名无效/);
	await assert.rejects(readStoredImage(directory, "../elsewhere", ref), /会话标识无效/);
	await assert.rejects(readStoredImage(directory, session, { ...ref, id: "asset:../escape" }), /引用无效/);
	const stored = await readStoredImage(directory, session, ref);
	assert.deepEqual(stored, { mime: "image/png", bytes: Uint8Array.from(png) });
	const moduleURL = new URL("../workbench/attachment-assets.mjs", import.meta.url).href;
	const code = `
		const { readStoredEvidence } = await import(${JSON.stringify(moduleURL)});
		const [directory, session, ref] = process.argv.slice(1);
		process.stdout.write(JSON.stringify(await readStoredEvidence(directory, session, JSON.parse(ref))));
	`;
	const reloaded = execFileSync(
		process.execPath,
		["--input-type=module", "--eval", code, directory, session, JSON.stringify(ref)],
		{
			encoding: "utf8",
			timeout: 5_000,
		},
	);
	assert.deepEqual(JSON.parse(reloaded), [{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
	assert.equal(await removeStoredAttachment(directory, session, ref), true);
	assert.equal(await removeStoredAttachment(directory, session, ref), false);
	assert.deepEqual(await readStoredImage(directory, other, otherRef), stored);
});

test("导入拒绝超限、无效类型和链接，伪造的存储记录无法在另一会话读取", async (t) => {
	const { root, directory, session } = await fixture(t);
	const path = join(root, "源文件.txt");
	await writeFile(path, "只核对这份资料");
	await writeFile(join(root, "归档.zip"), "测试");
	await mkdir(join(root, "文件夹.txt"));
	await symlink(path, join(root, "链接.txt"));
	await assert.rejects(importAttachmentFile(directory, session, "源文件.txt"), /本机文件/);
	await assert.rejects(importAttachmentFile(directory, session, join(root, "归档.zip")), /不支持/);
	await assert.rejects(importAttachmentFile(directory, session, join(root, "文件夹.txt")), /普通文件/);
	await assert.rejects(importAttachmentFile(directory, session, join(root, "链接.txt")), /普通文件/);
	await assert.rejects(importAttachmentImage(directory, session, Buffer.from("无效截图"), "截图"), /扩展名不匹配/);
	await assert.rejects(importAttachmentImage(directory, session, Buffer.alloc(4 * 1024 * 1024 + 1)), /4 MiB/);
	assert.deepEqual(await readdir(join(directory, "attachment-assets", session)), []);
	const ref = await importAttachmentFile(directory, session, path);
	await truncate(path, 16 * 1024 * 1024 + 1);
	await assert.rejects(importAttachmentFile(directory, session, path), /读取上限/);
	const assets = join(directory, "attachment-assets");
	const other = randomUUID();
	await mkdir(join(assets, other));
	await cp(join(assets, session, ref.id.slice(6)), join(assets, other, ref.id.slice(6)), { recursive: true });
	await assert.rejects(readStoredEvidence(directory, other, ref), /快照不匹配/);
	const alias = randomUUID();
	await symlink(join(assets, session), join(assets, alias), "junction");
	await assert.rejects(readStoredEvidence(directory, alias, ref), /附件目录无效/);
	assert.match((await readStoredEvidence(directory, session, ref))[0].text, /只核对这份资料/);
});
