import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { packager } from "@electron/packager";
import {
	macApplicationId,
	macReleaseFeed,
	macReleaseNames,
	macUpdateChannel,
} from "../workbench/desktop-update-macos.mjs";
import { macSigningPolicy } from "./macos-signing.mjs";

const { values } = parseArgs({
	options: {
		version: { type: "string" },
		arch: { type: "string" },
		output: { type: "string" },
		notes: { type: "string" },
		"qa-source": { type: "string" },
	},
});
const { version, arch, output } = values;
const names = macReleaseNames(version, arch);
assert(output && isAbsolute(output), "请指定 --output <全新绝对目录>。");
assert(process.platform === "darwin" && process.arch === arch, "请使用与 --arch 匹配的原生 macOS Node 运行。");

const qa = values["qa-source"];
const { id, signing, notarize } = macSigningPolicy(process.env, qa !== undefined);
const {
	MAC_CERTIFICATE_P12: certificate,
	MAC_CERTIFICATE_PASSWORD: certificatePassword,
	APPLE_ID: appleId,
	APPLE_APP_SPECIFIC_PASSWORD: applePassword,
	APPLE_TEAM_ID: team,
} = process.env;
const channel = { id, arch, ...(qa && { manifestUrl: qa }) };
macUpdateChannel(channel, arch);

const product = "Flower Desktop";
const desktop = fileURLToPath(new URL("../", import.meta.url));
const repo = resolve(desktop, "../..");
const runtime = join(repo, "packages", "agent-runtime");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const notes = values.notes ? await readFile(values.notes, "utf8") : "";
const application = await readJson(join(desktop, "package.json"));
const { electronVersion } = application.config;
const lock = await readJson(join(repo, "package-lock.json"));
await access(join(runtime, "dist", "index.js"));

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });
function secureRun(label, command, args) {
	try {
		return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		// 凭据可能出现在子进程异常的命令参数里，统一输出无凭据的错误。
		throw new Error(label);
	}
}

await mkdir(dirname(output), { recursive: true });
await mkdir(output);
let scratch;
let keychain;
try {
	scratch = await mkdtemp(join(tmpdir(), "flower-mac-release-"));
	const install = join(scratch, "install");
	await mkdir(install);
	for (const file of ["package.json", "package-lock.json", ".npmrc"]) {
		await cp(join(repo, file), join(install, file));
	}
	for (const path of Object.keys(lock.packages).filter((item) => /^(apps|packages)\/[^/]+$/.test(item))) {
		await mkdir(join(install, path), { recursive: true });
		await cp(join(repo, path, "package.json"), join(install, path, "package.json"));
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
		],
		install,
	);

	const modules = join(install, "node_modules");
	const ptyTarget = `darwin-${arch}`;
	const ptyRelative = `node_modules/node-pty/prebuilds/${ptyTarget}`;
	const prebuilds = join(modules, "node-pty", "prebuilds");
	for (const name of await readdir(prebuilds)) {
		if (name !== ptyTarget) await rm(join(prebuilds, name), { recursive: true });
	}
	const pty = join(prebuilds, ptyTarget);
	await chmod(join(pty, "spawn-helper"), 0o755);
	for (const name of ["pty.node", "spawn-helper"]) {
		run("/usr/bin/lipo", [join(pty, name), "-verify_arch", arch === "x64" ? "x86_64" : arch]);
	}

	// PDF.js 在 Chromium 中预览，在 Node 工作者中仅提取文字，保留两个入口及其本地资源。
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
	const nativeCanvas = ["@napi-rs/canvas", `@napi-rs/canvas-darwin-${arch}`];
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
	const runtimeModule = join(modules, "@flower-ai", "agent-runtime");
	await rm(runtimeModule, { recursive: true, force: true });
	await mkdir(runtimeModule);
	for (const file of ["package.json", "LICENSE", "dist"]) {
		await cp(join(runtime, file), join(runtimeModule, file), { recursive: true });
	}
	await rm(join(modules, "@flower-ai", "flower-desktop"), { recursive: true, force: true });
	await rm(join(modules, "@flower-ai", "flower-desktop-preview"), { recursive: true, force: true });

	const bundle = join(scratch, "bundle");
	await mkdir(bundle);
	await rename(modules, join(bundle, "node_modules"));
	await writeFile(join(bundle, "package.json"), JSON.stringify({ ...application, version }));
	await cp(join(desktop, "workbench"), join(bundle, "workbench"), {
		recursive: true,
		filter: (path) => !path.endsWith(".test.mjs"),
	});
	await writeFile(join(bundle, "workbench", "update-channel.json"), JSON.stringify(channel));

	const iconset = join(scratch, "Flower.iconset");
	const icon = join(scratch, "Flower.icns");
	const source = join(desktop, "workbench", "ui", "flower-icon.png");
	await mkdir(iconset);
	for (const size of [16, 32, 128, 256, 512]) {
		for (const scale of [1, 2]) {
			const pixels = String(size * scale);
			const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
			run("/usr/bin/sips", ["-z", pixels, pixels, source, "--out", join(iconset, name)]);
		}
	}
	run("/usr/bin/iconutil", ["-c", "icns", "-o", icon, iconset]);

	let identity;
	if (signing) {
		const file = join(scratch, "flower.p12");
		const password = randomUUID();
		const path = join(scratch, "flower.keychain-db");
		const security = (label, args) => secureRun(label, "/usr/bin/security", args);
		security("无法创建临时签名钥匙串。", ["create-keychain", "-p", password, path]);
		keychain = path;
		security("无法设置临时签名钥匙串。", ["set-keychain-settings", "-lut", "7200", path]);
		security("无法解锁临时签名钥匙串。", ["unlock-keychain", "-p", password, path]);
		try {
			await writeFile(file, Buffer.from(certificate, "base64"), { mode: 0o600 });
			security("无法导入 Developer ID Application 证书及私钥。", [
				"import",
				file,
				"-k",
				path,
				"-P",
				certificatePassword,
				"-T",
				"/usr/bin/codesign",
			]);
		} finally {
			await rm(file, { force: true });
		}
		security("无法授予 codesign 使用临时私钥的权限。", [
			"set-key-partition-list",
			"-S",
			"apple-tool:,apple:",
			"-s",
			"-k",
			password,
			path,
		]);
		const identities = security("无法读取签名证书。", ["find-identity", "-v", "-p", "codesigning", path]);
		identity = identities.match(new RegExp(`([A-F0-9]{40}) "Developer ID Application: [^"\\n]+ \\(${team}\\)"`))?.[1];
		assert(identity, "临时钥匙串中未找到与 APPLE_TEAM_ID 匹配的有效 Developer ID Application 证书。");
	}

	const [packed] = await packager({
		dir: bundle,
		out: join(scratch, "packed"),
		platform: "darwin",
		arch,
		electronVersion,
		name: product,
		executableName: product,
		appBundleId: macApplicationId(channel.id),
		appVersion: version,
		buildVersion: version,
		icon,
		asar: { unpackDir: ptyRelative, ...(sharedCanvas && { unpack: "*.node" }) },
		prune: false,
		...(signing && {
			osxSign: { identity, keychain, continueOnError: false, ...(qa && { timestamp: "none" }) },
		}),
		...(qa && {
			extendInfo: {
				NSAppTransportSecurity: {
					NSAllowsLocalNetworking: true,
					NSExceptionDomains: { "127.0.0.1": { NSExceptionAllowsInsecureHTTPLoads: true } },
				},
			},
		}),
	});
	const app = join(packed, `${product}.app`);
	const helper = join(app, "Contents", "Resources", "app.asar.unpacked", ptyRelative, "spawn-helper");
	await access(helper, 1);
	if (!signing) run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", app]);
	run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);

	const makeZip = (destination) =>
		run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, destination]);
	function notarizeAndStaple(source, staple) {
		const result = JSON.parse(
			secureRun("Apple 公证提交失败，请检查公证账号和网络。", "/usr/bin/xcrun", [
				"notarytool",
				"submit",
				source,
				"--apple-id",
				appleId,
				"--password",
				applePassword,
				"--team-id",
				team,
				"--wait",
				"--output-format",
				"json",
			]),
		);
		assert.equal(result.status, "Accepted", `Apple 公证未通过。公证记录 ${result.id}`);
		run("/usr/bin/xcrun", ["stapler", "staple", staple]);
		run("/usr/bin/xcrun", ["stapler", "validate", staple]);
	}
	if (notarize) {
		const submission = join(scratch, "notarization.zip");
		makeZip(submission);
		notarizeAndStaple(submission, app);
		await rm(submission);
	}

	const zip = join(output, names.zip);
	const dmg = join(output, names.dmg);
	makeZip(zip);
	const disk = join(scratch, "disk");
	await mkdir(disk);
	run("/usr/bin/ditto", [app, join(disk, `${product}.app`)]);
	await symlink("/Applications", join(disk, "Applications"));
	run("/usr/bin/hdiutil", ["create", "-volname", product, "-srcfolder", disk, "-format", "UDZO", dmg]);
	if (signing) {
		run("/usr/bin/codesign", ["--sign", identity, "--keychain", keychain, qa ? "--timestamp=none" : "--timestamp", dmg]);
		run("/usr/bin/codesign", ["--verify", "--strict", dmg]);
		if (notarize) notarizeAndStaple(dmg, dmg);
	}
	const feed = macReleaseFeed({ version, arch, config: channel, notes });
	await writeFile(join(output, names.feed), `${JSON.stringify(feed, null, 2)}\n`);
} catch (error) {
	await rm(output, { recursive: true, force: true });
	throw error;
} finally {
	try {
		if (keychain) secureRun("无法清理临时签名钥匙串。", "/usr/bin/security", ["delete-keychain", keychain]);
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
	}
}
console.log(`macOS ${arch} ${version} ${channel.id} 制品已生成 ${output}`);
