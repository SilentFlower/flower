import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [zipArg, sumsArg, outputArg] = process.argv.slice(2);
assert(zipArg && sumsArg && outputArg, "用法：package:windows -- <Electron zip> <SHASUMS256.txt> <新交付目录>");
const zip = resolve(zipArg);
const output = resolve(outputArg);
const workspace = fileURLToPath(new URL("../", import.meta.url));
const repo = resolve(workspace, "../..");
const runtime = "packages/agent-runtime";
const desktop = "apps/desktop";
const version = "45.3.2";
const distro = `electron-v${version}-win32-x64.zip`;
const executable = "Flower Desktop";
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const checkedSum = (await readFile(resolve(sumsArg), "utf8"))
	.split(/\r?\n/)
	.find((line) => line.trim().split(/\s+/)[1]?.replace(/^\*/, "") === distro)
	?.split(/\s+/)[0];
assert(checkedSum, "缺少官方 Windows x64 SHA-256");
const hash = createHash("sha256");
for await (const chunk of createReadStream(zip)) hash.update(chunk);
assert.equal(hash.digest("hex"), checkedSum, "Electron zip SHA-256 与官方记录不符");
await access(join(repo, runtime, "dist", "index.js"));
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const scratch = await mkdtemp(join(tmpdir(), "flower-desktop-package-"));
const native = join(scratch, "windows");
const install = join(scratch, "install");
const bundle = join(scratch, "app");
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });

try {
	const lock = await readJson(join(repo, "package-lock.json"));
	await mkdir(install);
	for (const file of ["package.json", "package-lock.json", ".npmrc"]) await cp(join(repo, file), join(install, file));
	for (const group of ["apps", "packages"]) {
		for (const name of await readdir(join(repo, group))) {
			const path = join(group, name);
			if (!lock.packages[path]) continue;
			await mkdir(join(install, path), { recursive: true });
			await cp(join(repo, path, "package.json"), join(install, path, "package.json"));
		}
	}
	run(
		"npm",
		[
			"ci",
			"--workspace",
			"@flower-ai/flower-desktop",
			"--omit=dev",
			"--ignore-scripts",
			"--bin-links=false",
			"--no-audit",
			"--no-fund",
			"--prefer-offline",
			"--os=win32",
			"--cpu=x64",
		],
		install,
	);
	const modules = join(install, "node_modules");
	for (const file of ["lib/marked.umd.js", "LICENSE"]) await access(join(modules, "marked", file));
	// Chromium 使用阅读器入口，Node 工作者使用 legacy 入口提取附件文字。
	const pdf = join(modules, "pdfjs-dist");
	const pdfSource = join(scratch, "pdfjs-dist");
	await rename(pdf, pdfSource);
	await mkdir(join(pdf, "build"), { recursive: true });
	for (const resource of [
		"LICENSE",
		"package.json",
		"build/pdf.mjs",
		"build/pdf.worker.mjs",
		"legacy/build/pdf.mjs",
		"legacy/build/pdf.worker.mjs",
		"cmaps",
		"iccs",
		"standard_fonts",
		"wasm",
	]) {
		await cp(join(pdfSource, resource), join(pdf, resource), { recursive: true });
	}
	// PDF 附件只提取文字，两个入口都由 Chromium 或受限的 Node 消息端处理，无需原生 canvas。
	const nativeCanvas = ["@napi-rs/canvas", "@napi-rs/canvas-win32-x64-msvc"];
	const sharedCanvas = Object.entries(lock.packages).some(
		([path, pkg]) =>
			path !== "node_modules/pdfjs-dist" &&
			path !== "node_modules/@napi-rs/canvas" &&
			nativeCanvas.some(
				(name) => pkg.dependencies?.[name] || pkg.optionalDependencies?.[name] || pkg.peerDependencies?.[name],
			),
	);
	if (!sharedCanvas) {
		for (const name of nativeCanvas) await rm(join(modules, name), { recursive: true, force: true });
	}
	const scope = join(modules, "@flower-ai");
	const installed = join(scope, "agent-runtime");
	await rm(join(scope, "flower-desktop-preview"), { recursive: true, force: true });
	await rm(installed, { recursive: true, force: true });
	await mkdir(installed);
	for (const file of ["package.json", "LICENSE", "dist"]) {
		await cp(join(repo, runtime, file), join(installed, file), { recursive: true });
	}
	await mkdir(bundle);
	await rename(modules, join(bundle, "node_modules"));
	await cp(join(repo, desktop, "package.json"), join(bundle, "package.json"));
	await cp(join(workspace, "workbench"), join(bundle, "workbench"), {
		recursive: true,
		filter: (path) => !path.endsWith(".test.mjs"),
	});
	await mkdir(native);
	run("unzip", ["-q", zip, "-d", native], scratch);
	assert.equal((await readFile(join(native, "version"), "utf8")).trim(), version);
	await rm(join(native, "resources", "default_app.asar"), { force: true });
	run(
		"npm",
		[
			"exec",
			"--yes",
			"--package=@electron/asar@4.3.2",
			"--",
			"asar",
			"pack",
			bundle,
			join(native, "resources", "app.asar"),
		],
		scratch,
	);
	await rename(join(native, "electron.exe"), join(native, `${executable}.exe`));
	try {
		await rename(join(native, "electron_wer.dll"), join(native, `${executable}_wer.dll`));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await cp(native, output, { recursive: true });
	await cp(join(workspace, "README.Windows.txt"), join(output, "使用说明.txt"));
	// 字体许可要求保留协议文本，交付目录根部另放一份便于查阅
	await cp(join(workspace, "workbench", "ui", "fonts", "LICENSE_Fonts"), join(output, "HarmonyOS-Sans-字体许可.txt"));
	console.log(`Windows 解压版已生成 ${join(output, `${executable}.exe`)}`);
} catch (error) {
	await rm(output, { recursive: true, force: true });
	throw error;
} finally {
	await rm(scratch, { recursive: true, force: true });
}
