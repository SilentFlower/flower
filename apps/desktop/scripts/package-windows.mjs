import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildMarker, packChannel, platform, product, releaseVersion } from "./windows-release-contract.mjs";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { version: { type: "string" }, "qa-source": { type: "string" } },
});
const [zipArg, sumsArg, outputArg] = positionals;
assert(
	positionals.length === 3,
	"用法：package:windows -- <Electron zip> <SHASUMS256.txt> <新交付目录> [--version 1.2.3] [--qa-source 回环清单]",
);
const zip = resolve(zipArg);
const output = resolve(outputArg);
const workspace = fileURLToPath(new URL("../", import.meta.url));
const repo = resolve(workspace, "../..");
const runtime = "packages/agent-runtime";
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const application = await readJson(join(workspace, "package.json"));
const { electronVersion } = application.config;
const distro = `electron-v${electronVersion}-win32-x64.zip`;
const version = values.version ?? application.version;
assert(releaseVersion.test(version), "产品版本应使用三段数字版本号");
const channel = packChannel(values["qa-source"]);
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
// Windows 的 npm.cmd 需要额外一层 shell，直接让当前 Node 运行同一套 npm CLI 可保留空格路径。
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const runNpm = (args, cwd) =>
	process.platform === "win32" ? run(process.execPath, [npmCli, ...args], cwd) : run("npm", args, cwd);

try {
	const lock = await readJson(join(repo, "package-lock.json"));
	await mkdir(install);
	for (const file of ["package.json", "package-lock.json", ".npmrc"]) await cp(join(repo, file), join(install, file));
	for (const group of ["apps", "packages"]) {
		for (const name of await readdir(join(repo, group))) {
			const path = `${group}/${name}`;
			if (!lock.packages[path]) continue;
			await mkdir(join(install, path), { recursive: true });
			await cp(join(repo, path, "package.json"), join(install, path, "package.json"));
		}
	}
	runNpm(
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
	for (const file of ["@xterm/xterm/lib/xterm.js", "@xterm/xterm/css/xterm.css", "@xterm/addon-fit/lib/addon-fit.js"])
		await access(join(modules, file));
	// .node、ConPTY DLL 和控制台程序由 Windows 原生加载，保留 x64 运行文件并在 ASAR 外成组放置。
	const ptyRelative = "node_modules/node-pty/prebuilds/win32-x64";
	const prebuilds = join(modules, "node-pty", "prebuilds");
	for (const name of await readdir(prebuilds)) {
		if (name !== "win32-x64") await rm(join(prebuilds, name), { recursive: true, force: true });
	}
	const pty = join(prebuilds, "win32-x64");
	for (const file of await readdir(pty)) {
		if (file.endsWith(".pdb")) await rm(join(pty, file));
	}
	const ptyFiles = ["conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"];
	for (const file of ptyFiles) await access(join(pty, file));
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
	// 原生 npm 会把本应用也链接回临时 workspace；桌面入口已位于 ASAR 根目录。
	await rm(join(scope, "flower-desktop"), { recursive: true, force: true });
	await rm(join(scope, "flower-desktop-preview"), { recursive: true, force: true });
	await rm(installed, { recursive: true, force: true });
	await mkdir(installed);
	for (const file of ["package.json", "LICENSE", "dist"]) {
		await cp(join(repo, runtime, file), join(installed, file), { recursive: true });
	}
	await mkdir(bundle);
	await rename(modules, join(bundle, "node_modules"));
	await writeFile(join(bundle, "package.json"), JSON.stringify({ ...application, version }));
	await cp(join(workspace, "workbench"), join(bundle, "workbench"), {
		recursive: true,
		filter: (path) => !path.endsWith(".test.mjs"),
	});
	await writeFile(join(bundle, "workbench", "update-channel.json"), JSON.stringify(channel));
	await mkdir(native);
	if (process.platform === "win32") run("tar.exe", ["-xf", zip, "-C", native], scratch);
	else run("unzip", ["-q", zip, "-d", native], scratch);
	assert.equal((await readFile(join(native, "version"), "utf8")).trim(), electronVersion);
	await rm(join(native, "resources", "default_app.asar"), { force: true });
	runNpm(
		[
			"exec",
			"--yes",
			"--package=@electron/asar@4.3.2",
			"--",
			"asar",
			"pack",
			"--unpack-dir",
			ptyRelative,
			bundle,
			join(native, "resources", "app.asar"),
		],
		scratch,
	);
	for (const file of ptyFiles) await access(join(native, "resources", "app.asar.unpacked", ptyRelative, file));
	await rename(join(native, "electron.exe"), join(native, `${product}.exe`));
	try {
		await rename(join(native, "electron_wer.dll"), join(native, `${product}_wer.dll`));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await writeFile(join(native, buildMarker), JSON.stringify({ product, platform, version, channel: channel.id }));
	await cp(native, output, { recursive: true });
	await cp(join(workspace, "README.Windows.txt"), join(output, "使用说明.txt"));
	// 字体许可要求保留协议文本，交付目录根部另放一份便于查阅
	await cp(join(workspace, "workbench", "ui", "fonts", "LICENSE_Fonts"), join(output, "HarmonyOS-Sans-字体许可.txt"));
	console.log(`Windows ${version} ${channel.id} 版本载荷已生成 ${join(output, `${product}.exe`)}`);
} catch (error) {
	await rm(output, { recursive: true, force: true });
	throw error;
} finally {
	await rm(scratch, { recursive: true, force: true });
}
