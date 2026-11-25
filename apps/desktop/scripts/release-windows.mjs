import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	buildMarker,
	feedName,
	managedIdentity,
	managedMarker,
	platform,
	product,
	releaseVersion,
} from "./windows-release-contract.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { notes: { type: "string" } } });
const [payloadArg, outputArg] = positionals;
assert(positionals.length === 2, "用法：release:windows -- <平铺版本目录> <新发行目录> [--notes <更新说明文件>]");
assert((await lstat(resolve(payloadArg))).isDirectory(), "平铺版本必须是实际目录");
const payload = await realpath(resolve(payloadArg));
const outputPath = resolve(outputArg);
const outputParent = await realpath(dirname(outputPath));
const output = join(outputParent, basename(outputPath));
const outputRelative = relative(payload, output);
assert(outputRelative.startsWith(`..${sep}`), "发行目录和版本载荷目录应独立");

// ZIP 只包含完整的普通文件。提前拒绝符号链接，防止制品带入载荷以外的文件。
async function checkDirectory(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await checkDirectory(path);
		else assert(entry.isFile(), `载荷文件类型无效 ${path}`);
	}
}
await checkDirectory(payload);
const marker = JSON.parse(await readFile(join(payload, buildMarker), "utf8"));
const { version, channel } = marker ?? {};
assert(
	marker?.product === product &&
		marker.platform === platform &&
		typeof version === "string" &&
		releaseVersion.test(version) &&
		(channel === "stable" || channel === "qa"),
	"版本载荷的产品、平台、版本号或频道标记无效",
);
for (const file of [`${product}.exe`, "resources/app.asar"]) {
	const metadata = await lstat(join(payload, file));
	assert(metadata.isFile() && metadata.size > 0, `版本载荷缺少完整文件 ${file}`);
}
const notes = values.notes ? (await readFile(resolve(values.notes), "utf8")).trim() : "";
assert(notes.length <= 4000, "发行说明限 4000 字符");

const nativeWindows = process.platform === "win32";
const pathForWindows = (path) =>
	nativeWindows ? path : execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim();
const hostPath = (path) => (nativeWindows ? path : execFileSync("wslpath", ["-u", path], { encoding: "utf8" }).trim());
const cmd = nativeWindows ? process.env.ComSpec : hostPath("C:\\Windows\\System32\\cmd.exe");
const systemRoot = nativeWindows
	? process.env.SystemRoot
	: execFileSync(cmd, ["/d", "/c", "echo %SystemRoot%"], { encoding: "utf8", cwd: dirname(cmd) }).trim();
const csc = hostPath(win32.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"));
const source = fileURLToPath(new URL("./PortableLauncher.cs", import.meta.url));
const iconSource = fileURLToPath(new URL("../workbench/ui/flower-icon.png", import.meta.url));

async function compileLauncher(path) {
	const scratch = await mkdtemp(join(output, ".launcher-"));
	try {
		// Windows 图标容器保留应用已有的 256 像素 PNG。
		const png = await readFile(iconSource);
		assert(png.readUInt32BE(16) === 256 && png.readUInt32BE(20) === 256, "应用图标必须是 256 像素 PNG");
		const header = Buffer.alloc(22);
		header.writeUInt16LE(1, 2);
		header.writeUInt16LE(1, 4);
		header.writeUInt16LE(1, 10);
		header.writeUInt16LE(32, 12);
		header.writeUInt32LE(png.length, 14);
		header.writeUInt32LE(header.length, 18);
		const icon = join(scratch, "flower.ico");
		await writeFile(icon, Buffer.concat([header, png]));
		execFileSync(
			csc,
			[
				"/nologo",
				"/target:winexe",
				"/platform:x64",
				"/optimize+",
				"/codepage:65001",
				"/r:System.Web.Extensions.dll",
				"/r:System.Windows.Forms.dll",
				`/win32icon:${pathForWindows(icon)}`,
				`/out:${pathForWindows(path)}`,
				pathForWindows(source),
			],
			{ cwd: scratch, stdio: "inherit" },
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

await mkdir(output);
try {
	const managed = join(output, "install");
	const versions = join(managed, "versions");
	const updates = join(output, "updates");
	await mkdir(versions, { recursive: true });
	await mkdir(updates);
	await cp(payload, join(versions, version), { recursive: true });
	await writeFile(join(managed, managedMarker), `${managedIdentity}\n`);
	await writeFile(join(managed, "current.txt"), `${version}\n`);
	await cp(join(payload, "使用说明.txt"), join(managed, "使用说明.txt"));
	await compileLauncher(join(managed, `${product}.exe`));

	const download = `Flower-Desktop-${version}-${platform}.zip`;
	const archive = join(updates, download);
	const zipScript = fileURLToPath(new URL("./windows-archive.py", import.meta.url));
	const zip = (directory, file) =>
		execFileSync(nativeWindows ? "python" : "python3", [zipScript, directory, file], { stdio: "inherit" });
	zip(payload, archive);
	// 首装压缩包保留顶层启动器和版本指针，用户以后可沿用同一入口安装更新。
	zip(managed, join(updates, `Flower-Desktop-${version}-${platform}-portable.zip`));
	const { size } = await stat(archive);
	assert(size <= 1024 ** 3, "更新包超过 1 GiB");
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(archive)) digest.update(chunk);
	const sha256 = digest.digest("hex");
	await writeFile(
		join(updates, feedName),
		`${JSON.stringify({ product, platform, version, download, size, sha256, notes, channel }, null, 2)}\n`,
	);
	console.log(`Windows 启动入口 ${join(managed, `${product}.exe`)}`);
	console.log(`Windows 发行清单 ${join(updates, feedName)}`);
	console.log(`Windows 更新包 ${archive}（SHA-256 ${sha256}）`);
} catch (error) {
	await rm(output, { recursive: true, force: true });
	throw error;
}
