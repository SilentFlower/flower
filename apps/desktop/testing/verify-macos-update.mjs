import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { _electron as electron } from "playwright-core";
import { macSigningEnvironment, verifyMacApplicationSignature } from "../scripts/macos-signing.mjs";
import { macApplicationId, macReleaseNames, macUpdateChannel } from "../workbench/desktop-update-macos.mjs";

const { values } = parseArgs({
	options: {
		"from-version": { type: "string" },
		"from-dir": { type: "string" },
		version: { type: "string" },
		arch: { type: "string" },
		output: { type: "string" },
		"qa-source": { type: "string" },
	},
});
const { version, arch, output } = values;
const oldVersion = values["from-version"];
const from = values["from-dir"];
assert(from && isAbsolute(from) && output && isAbsolute(output) && from !== output, "请使用两个分开的制品绝对目录。");
assert(process.platform === "darwin" && process.arch === arch, "请使用与 --arch 匹配的原生 macOS Node 运行。");
const newer = macReleaseNames(version, arch);
const older = macReleaseNames(oldVersion, arch);
const config = macUpdateChannel({ id: "qa", arch, manifestUrl: values["qa-source"] }, arch);
const appZip = join(output, newer.zip);
const appSize = (await stat(appZip)).size;
const feed = await readFile(join(output, newer.feed));
const parsed = JSON.parse(feed);
assert.equal(parsed.currentRelease, version);
assert.equal(parsed.releases[0].updateTo.url, new URL(newer.zip, config.url).href);

const scratch = await mkdtemp(join(await realpath(tmpdir()), "flower-squirrel-check-"));
const app = join(scratch, "Flower Desktop.app");
const profile = join(scratch, "profile");
const plist = join(app, "Contents", "Info.plist");
const executable = join(app, "Contents", "MacOS", "Flower Desktop");
const readPlist = (name) =>
	execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${name}`, plist], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
const requests = [];
const server = createServer((request, response) => {
	requests.push(request.url);
	if (request.method !== "GET") {
		response.writeHead(405).end();
	} else if (request.url === config.url.pathname) {
		response.writeHead(200, { "Content-Type": "application/json", "Content-Length": feed.length });
		response.end(feed);
	} else if (request.url === `/${newer.zip}`) {
		response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": appSize });
		const stream = createReadStream(appZip);
		stream.on("error", () => response.destroy());
		response.on("close", () => stream.destroy());
		stream.pipe(response);
	} else response.writeHead(404).end();
});
const environment = { ...process.env };
for (const name of macSigningEnvironment) delete environment[name];
let electronApp;
try {
	await mkdir(profile);
	execFileSync("/usr/bin/ditto", ["-x", "-k", join(from, older.zip), scratch], { stdio: "inherit" });
	assert.equal(readPlist("CFBundleIdentifier"), macApplicationId("qa"), "升级试验须使用独立签名 QA 包。");
	assert.equal(readPlist("CFBundleShortVersionString"), oldVersion);
	const before = verifyMacApplicationSignature(app, {
		expectedTeam: process.env.APPLE_TEAM_ID,
		certificatePrefix: join(scratch, "before-cert-"),
	});
	await new Promise((done, reject) => {
		server.once("error", reject);
		server.listen(Number(config.url.port), "127.0.0.1", done);
	});
	const launch = () =>
		electron.launch({
			executablePath: executable,
			args: [`--user-data-dir=${profile}`],
			chromiumSandbox: true,
			env: environment,
			timeout: 30000,
		});
	electronApp = await launch();
	const page = await electronApp.firstWindow();
	await page.waitForFunction(async () => (await window.flower?.state())?.ready, undefined, { polling: 100 });
	const note = "Mac 升级验收：金额保留两位小数。";
	await page.evaluate((text) => window.flower.saveInstructions(text), note);
	const nativeFeed = await electronApp.evaluate(({ autoUpdater }) => autoUpdater.getFeedURL());
	assert.equal(nativeFeed, config.url.href);
	await page.evaluate(() => window.flower.checkDesktopUpdate());
	await page.waitForFunction(
		async ({ latest, previous }) => {
			const state = await window.flower.desktopUpdateState();
			if (state.phase === "error") throw new Error(state.error);
			return state.phase === "ready" && state.version === latest && state.currentVersion === previous && state.canRestart;
		},
		{ latest: version, previous: oldVersion },
		{ polling: 180, timeout: 180000 },
	);
	assert(requests.includes(config.url.pathname) && requests.includes(`/${newer.zip}`));
	await electronApp.close();
	electronApp = undefined;

	// 正常退出后 ShipIt 原子替换原应用。等原位置的包切换后，再用同一资料目录正常启动。
	const end = Date.now() + 90000;
	while (Date.now() < end) {
		try {
			if (readPlist("CFBundleShortVersionString") === version) break;
		} catch {
			// 换包期间原路径可短暂无文件。
		}
		await delay(250);
	}
	assert.equal(readPlist("CFBundleIdentifier"), macApplicationId("qa"));
	assert.equal(readPlist("CFBundleShortVersionString"), version);
	const after = verifyMacApplicationSignature(app, {
		expectedTeam: before.team,
		certificatePrefix: join(scratch, "after-cert-"),
	});
	assert.equal(after.fingerprint, before.fingerprint, "两个 QA 版本须使用同一 Developer ID 证书。");
	electronApp = await launch();
	const upgraded = await electronApp.firstWindow();
	await upgraded.waitForFunction(
		async (expected) => {
			const state = await window.flower?.state();
			return state?.ready && state.version === expected;
		},
		version,
		{ polling: 100 },
	);
	assert.equal(await upgraded.evaluate(async () => (await window.flower.state()).instructions), note);
	console.log(
		JSON.stringify({
			arch,
			from: oldVersion,
			to: version,
			asset: basename(appZip),
			team: after.team,
			signingCertificateSha256: after.fingerprint,
			requests,
			result: "正常退出后原位置升级成功",
		}),
	);
} finally {
	await electronApp?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((done) => server.close(done));
	await rm(scratch, { recursive: true, force: true });
}
