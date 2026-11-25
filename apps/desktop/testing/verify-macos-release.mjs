import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { _electron as electron } from "playwright-core";
import { macSigningEnvironment, verifyMacApplicationSignature } from "../scripts/macos-signing.mjs";
import {
	macApplicationId,
	macReleaseFeed,
	macReleaseNames,
	macUpdateChannel,
} from "../workbench/desktop-update-macos.mjs";
import { startMockModel } from "./mock-model.mjs";

const { values } = parseArgs({
	options: {
		version: { type: "string" },
		arch: { type: "string" },
		output: { type: "string" },
		"qa-source": { type: "string" },
	},
});
const { version, arch, output } = values;
const names = macReleaseNames(version, arch);
assert(output && isAbsolute(output), "请指定 --output <制品绝对目录>。");
assert(process.platform === "darwin" && process.arch === arch, "请使用与 --arch 匹配的原生 macOS Node 运行。");
const formal = process.env.FLOWER_MAC_REQUIRE_SIGNING === "1";
const qa = values["qa-source"];
assert(!formal || qa === undefined, "正式发布验收使用固定稳定频道。");

const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const plist = (file, key) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, file]).trim();
const executable = (app) => join(app, "Contents", "MacOS", "Flower Desktop");
const asar = (app) => join(app, "Contents", "Resources", "app.asar");
const realFs = (path) => realpath(path).then((resolved) => resolved.normalize("NFC"));
async function sha256(path) {
	const hash = createHash("sha256");
	for await (const data of createReadStream(path)) hash.update(data);
	return hash.digest("hex");
}

const zip = join(output, names.zip);
const dmg = join(output, names.dmg);
const feed = JSON.parse(await readFile(join(output, names.feed), "utf8"));
const scratch = await mkdtemp(join(await realFs(tmpdir()), "flower-mac-check-"));
const extracted = join(scratch, "archive");
const mount = join(scratch, "disk");
const profile = join(scratch, "验收资料");
const workspace = join(scratch, "花朵验收资料");
const filename = "用量核对.md";
const fileText = "# 本机报表\n\n测试记录二十四条。\n";
const prompt = "请核对这个工作区里的报表";
const reply = "已核对。本次回环验收完成。";
const env = { ...process.env };
// 发布凭据只留在签名步骤，启动产品和模型夹具无需使用。
for (const name of macSigningEnvironment) delete env[name];
let fixture;
let mounted = false;
let app;

try {
	await Promise.all([mkdir(extracted), mkdir(mount), mkdir(profile), mkdir(workspace)]);
	await writeFile(join(workspace, filename), fileText);
	run("/usr/bin/ditto", ["-x", "-k", zip, extracted]);
	const zipApp = join(extracted, "Flower Desktop.app");
	const zipInfo = join(zipApp, "Contents", "Info.plist");
	const appId = plist(zipInfo, "CFBundleIdentifier");
	const channelId = qa !== undefined ? "qa" : appId === macApplicationId("stable") ? "stable" : "preview";
	const stable = channelId === "stable";
	assert(!formal || channelId === "stable", "正式发版需要稳定频道和 Developer ID Application 签名。");
	const config = { id: channelId, arch, ...(qa && { manifestUrl: qa }) };
	const expected = macReleaseFeed({ version, arch, config });
	assert.equal(feed.currentRelease, version);
	assert.equal(feed.releases?.length, 1);
	assert.equal(feed.releases[0].version, version);
	for (const key of ["version", "name", "url"]) {
		assert.equal(feed.releases[0].updateTo[key], expected.releases[0].updateTo[key]);
	}
	assert(Number.isFinite(Date.parse(feed.releases[0].updateTo.pub_date)));

	console.log(run("/usr/bin/hdiutil", ["verify", dmg]));
	run("/usr/bin/hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount]);
	mounted = true;
	const diskApp = join(mount, "Flower Desktop.app");
	const macho = arch === "x64" ? "x86_64" : "arm64";
	const verifyArch = (path) => assert.equal(run("/usr/bin/lipo", ["-archs", path]).trim(), macho, path);
	for (const bundle of [diskApp, zipApp]) {
		const info = join(bundle, "Contents", "Info.plist");
		assert.equal(plist(info, "CFBundleIdentifier"), macApplicationId(channelId));
		assert.equal(plist(info, "CFBundleShortVersionString"), version);
		verifyArch(executable(bundle));
		const prebuilds = join(bundle, "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds");
		assert.deepEqual(await readdir(prebuilds), [`darwin-${arch}`]);
		const pty = join(prebuilds, `darwin-${arch}`);
		verifyArch(join(pty, "pty.node"));
		const helper = join(pty, "spawn-helper");
		verifyArch(helper);
		await access(helper, 1);
		if (channelId === "preview") {
			run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
		} else {
			verifyMacApplicationSignature(bundle, { expectedTeam: process.env.APPLE_TEAM_ID, timestamp: stable });
		}
		if (stable) run("/usr/bin/xcrun", ["stapler", "validate", bundle]);
	}
	if (channelId !== "preview") {
		run("/usr/bin/codesign", ["--verify", "--strict", dmg]);
	}
	if (stable) {
		run("/usr/bin/xcrun", ["stapler", "validate", dmg]);
		run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", zipApp]);
	}
	const asarHash = await sha256(asar(zipApp));
	assert.equal(await sha256(asar(diskApp)), asarHash, "DMG 和 ZIP 必须包含同一份应用资源。");
	fixture = await startMockModel({ attachmentReply: () => ({ text: reply }) });

	async function launch() {
		app = await electron.launch({
			executablePath: executable(diskApp),
			args: [`--user-data-dir=${profile}`],
			chromiumSandbox: true,
			env,
			timeout: 30000,
		});
		const expectedUpdate = macUpdateChannel(config, arch);
		const installed = await app.evaluate(({ app, dialog }, selectedPath) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
			return {
				arch: process.arch,
				bundled: app.isPackaged,
				version: app.getVersion(),
				profile: app.getPath("userData"),
			};
		}, workspace);
		assert.equal(installed.arch, arch);
		assert.equal(installed.version, version);
		assert.equal(installed.bundled, true);
		assert.equal(await realFs(installed.profile), await realFs(profile));
		const page = await app.firstWindow({ timeout: 20000 });
		page.setDefaultTimeout(20000);
		await page.waitForFunction(async () => (await window.flower?.state())?.ready, undefined, { polling: 100 });
		const feedUrl = await app.evaluate(({ autoUpdater }) => autoUpdater.getFeedURL());
		assert.equal(feedUrl || "", expectedUpdate.url?.href ?? "");
		const update = await page.evaluate(() => window.flower.desktopUpdateState());
		assert.equal(update.currentVersion, version);
		assert.equal(update.installPolicy, "on-exit");
		assert.equal(update.channel, expectedUpdate.id);
		if (channelId === "preview") {
			assert.equal(update.phase, "unavailable");
			assert.equal((await page.evaluate(() => window.flower.checkDesktopUpdate())).phase, "unavailable");
		}
		return page;
	}

	const page = await launch();
	const session = await page.evaluate(() => window.flower.chooseWorkspace());
	assert(session);
	const preview = await page.evaluate(({ session, filename }) => window.flower.previewWorkspaceFile(session, filename), {
		session,
		filename,
	});
	assert.deepEqual(preview, { kind: "markdown", text: fileText, attachable: true });
	const terminal = await page.evaluate(async (session) => {
		window.macTerminalOutput = "";
		window.flower.subscribe((frame) => {
			if (
				frame.kind === "native-panel" &&
				frame.panel === "terminal" &&
				frame.session === session &&
				frame.type === "output"
			) {
				window.macTerminalOutput += frame.data;
			}
		});
		const { id } = await window.flower.terminalOpen(session, 100, 24);
		await window.flower.terminalInput(session, id, "printf '\\nFLOWER_%s\\n' '终端通过'; /bin/pwd\r");
		return id;
	}, session);
	await page.waitForFunction(
		(path) => {
			const lines = window.macTerminalOutput?.normalize("NFC").split(/\r?\n/);
			return lines?.includes("FLOWER_终端通过") && lines.includes(path);
		},
		await realFs(workspace),
	);
	await page.evaluate(({ session, terminal }) => window.flower.terminalClose(session, terminal), { session, terminal });

	await page.evaluate(
		(baseUrl) => window.flower.saveModel({ serviceId: "", baseUrl, modelId: "local-test", apiKey: "" }),
		fixture.baseUrl,
	);
	const sent = await page.evaluate(({ session, prompt }) => window.flower.submit(session, prompt, true), {
		session,
		prompt,
	});
	await page.waitForFunction(
		async ({ session, requestId, reply }) => {
			const history = await window.flower.history(session);
			return history.some(
				(entry) => entry.requestId === requestId && entry.status === "succeeded" && entry.text === reply,
			);
		},
		{ session, requestId: sent.requestId, reply },
	);
	assert.equal(fixture.observations.model[0]?.model, "local-test");
	await app.close();
	app = undefined;

	const reopened = await launch();
	const restored = await reopened.evaluate(
		async (session) => ({
			selected: (await window.flower.state()).selected,
			history: await window.flower.history(session),
		}),
		session,
	);
	assert.equal(restored.selected, session);
	assert(
		restored.history.some(
			(entry) => entry.requestId === sent.requestId && entry.input === prompt && entry.text === reply,
		),
	);
	console.log(
		JSON.stringify(
			{
				arch,
				version,
				channel: channelId,
				asarSha256: asarHash,
				dmg: names.dmg,
				zip: names.zip,
				pty: "spawn-helper / 中文终端",
				workspace: "工作区预览、回环模型、重启历史",
			},
			null,
			2,
		),
	);
} finally {
	await app?.close().catch(() => {});
	await fixture?.close();
	if (mounted) run("/usr/bin/hdiutil", ["detach", mount]);
	await rm(scratch, { recursive: true, force: true });
}
