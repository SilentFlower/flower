import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { macSigningPolicy } from "../scripts/macos-signing.mjs";
import {
	createMacDesktopUpdater,
	macApplicationId,
	macReleaseFeed,
	macReleaseNames,
	macUpdateChannel,
} from "../workbench/desktop-update-macos.mjs";

const current = "1.2.3";
const newer = "1.2.4";
const stable = "https://github.com/SilentFlower/flower/releases/download/flower-desktop-stable/";

test("回环 QA 用 Developer ID 签名，正式制品额外要求公证凭据", () => {
	const certificate = {
		MAC_CERTIFICATE_P12: "fixture",
		MAC_CERTIFICATE_PASSWORD: "fixture",
		APPLE_TEAM_ID: "ABCD123456",
	};
	const notarization = { APPLE_ID: "fixture", APPLE_APP_SPECIFIC_PASSWORD: "fixture" };
	assert.deepEqual(macSigningPolicy({}, false), { id: "preview", signing: false, notarize: false });
	assert.deepEqual(macSigningPolicy(certificate, true), { id: "qa", signing: true, notarize: false });
	assert.deepEqual(macSigningPolicy({ ...certificate, ...notarization }, true), {
		id: "qa",
		signing: true,
		notarize: false,
	});
	assert.deepEqual(macSigningPolicy({ ...certificate, ...notarization, FLOWER_MAC_REQUIRE_SIGNING: "1" }, false), {
		id: "stable",
		signing: true,
		notarize: true,
	});
	assert.throws(() => macSigningPolicy({}, true), /MAC_CERTIFICATE_P12/);
	assert.throws(() => macSigningPolicy({ ...certificate, APPLE_TEAM_ID: "invalid" }, true), /APPLE_TEAM_ID/);
	assert.throws(() => macSigningPolicy({ ...certificate, FLOWER_MAC_REQUIRE_SIGNING: "1" }, false), /APPLE_ID/);
	assert.throws(
		() => macSigningPolicy({ ...certificate, ...notarization, FLOWER_MAC_REQUIRE_SIGNING: "1" }, true),
		/FLOWER_MAC_REQUIRE_SIGNING=0/,
	);
});

function harness(id = "stable") {
	const native = new EventEmitter();
	const config = macUpdateChannel({ id, arch: "arm64" }, "arm64");
	const calls = [];
	let busy = false;
	native.setFeedURL = (opts) => calls.push(["feed", opts]);
	native.checkForUpdates = () => calls.push(["check"]);
	native.quitAndInstall = () => {
		calls.push(["quit"]);
		native.emit("before-quit-for-update", {});
	};
	const updater = createMacDesktopUpdater({
		native,
		config,
		version: current,
		notify: () => calls.push(["notify"]),
		busy: () => busy,
		beforeRestart: () => calls.push(["before-restart"]),
		restartFailed: () => calls.push(["restart-failed"]),
	});
	return {
		native,
		updater,
		calls,
		setBusy: (value) => {
			busy = value;
		},
	};
}

test("Mac 固定频道与 Squirrel 清单各自使用实际执行架构", () => {
	for (const arch of ["arm64", "x64"]) {
		const names = macReleaseNames(newer, arch);
		assert.equal(names.dmg, `Flower-Desktop-1.2.4-darwin-${arch}.dmg`);
		assert.equal(names.zip, `Flower-Desktop-1.2.4-darwin-${arch}.zip`);
		assert.equal(names.feed, `flower-desktop-mac-${arch}.json`);
		const config = { id: "stable", arch, manifestUrl: "https://other.invalid/ignore.json" };
		assert.equal(macUpdateChannel(config, arch).url.href, stable + names.feed);
		assert.deepEqual(macReleaseFeed({ version: newer, arch, config, date: new Date(0) }), {
			currentRelease: newer,
			releases: [
				{
					version: newer,
					updateTo: {
						version: newer,
						name: newer,
						notes: "",
						pub_date: "1970-01-01T00:00:00.000Z",
						url: stable + names.zip,
					},
				},
			],
		});
	}
	assert.throws(() => macUpdateChannel({ id: "stable", arch: "x64" }, "arm64"), /架构/);
	assert.throws(() => macReleaseNames("1.2.4\n", "x64"), /版本/);
	assert.throws(() => macReleaseNames("1.2.4", "ia32"), /架构/);
	assert.notEqual(macApplicationId("preview"), macApplicationId("stable"));
	assert.notEqual(macApplicationId("qa"), macApplicationId("stable"));
});

test("本地 Mac 升级只接受带架构的回环源，未签名预演跳过原生检查", () => {
	const arch = "arm64";
	const manifestUrl = "http://127.0.0.1:12345/flower-desktop-mac-arm64.json";
	const config = { id: "qa", arch, manifestUrl };
	assert.equal(
		macReleaseFeed({ version: newer, arch, config }).releases[0].updateTo.url,
		"http://127.0.0.1:12345/Flower-Desktop-1.2.4-darwin-arm64.zip",
	);
	for (const url of [
		manifestUrl.replace("127.0.0.1", "example.org"),
		manifestUrl.replace("arm64", "x64"),
		`${manifestUrl}?unsafe=1`,
	]) {
		assert.throws(() => macUpdateChannel({ ...config, manifestUrl: url }, arch), /频道/);
	}
	const { updater, calls } = harness("preview");
	assert.equal(updater.check().phase, "unavailable");
	assert.deepEqual(calls, []);
});

test("Mac 更新状态接收原生进度，保护任务并在显式重启时交接一次", () => {
	const { native, updater, calls, setBusy } = harness();
	assert.deepEqual(calls[0], ["feed", { url: `${stable}flower-desktop-mac-arm64.json`, serverType: "json" }]);
	assert.equal(updater.check().phase, "checking");
	updater.check();
	assert.equal(calls.filter(([command]) => command === "check").length, 1);
	native.emit("update-available", {});
	assert.equal(updater.state().phase, "downloading");
	native.emit("update-downloaded", {}, "核对更新", newer, new Date(), stable + macReleaseNames(newer, "arm64").zip);
	assert.equal(updater.state().phase, "ready");
	assert.equal(updater.state().notes, "核对更新");
	assert.equal(updater.state().installPolicy, "on-exit");
	assert.equal(updater.state().scheduled, true);
	assert.equal(updater.wantsInstall(), false);
	updater.onQuit();
	assert(!calls.some(([command]) => command === "quit"));
	setBusy(true);
	assert.equal(updater.state().canRestart, false);
	assert.throws(() => updater.restart(), /任务正在处理/);
	setBusy(false);
	assert.equal(updater.restart().phase, "installing");
	assert(!calls.some(([command]) => command === "quit"));
	updater.onQuit();
	updater.onQuit();
	assert.deepEqual(calls.slice(-2), [["quit"], ["before-restart"]]);
});

test("Mac 更新拒绝旧版本与串架构状态，失败后保留已下载更新", () => {
	const { native, updater, calls } = harness();
	updater.check();
	native.emit("update-not-available", {});
	assert.equal(updater.state().phase, "current");
	updater.check();
	native.emit("update-downloaded", {}, "", "1.2.2", new Date(), stable + macReleaseNames("1.2.2", "arm64").zip);
	assert.equal(updater.state().phase, "error");
	updater.check();
	native.emit("update-downloaded", {}, "", newer, new Date(), stable + macReleaseNames(newer, "x64").zip);
	assert.equal(updater.state().phase, "error");
	updater.check();
	native.emit("error", new Error("包含私有系统信息"));
	assert.match(updater.state().error, /暂时无法/);
	updater.check();
	native.emit("update-downloaded", "", newer, new Date(), stable + macReleaseNames(newer, "arm64").zip);
	updater.restart();
	updater.cancelRestart();
	assert.equal(updater.state().phase, "ready");
	assert.deepEqual(calls.at(-1), ["restart-failed"]);
	updater.restart();
	native.quitAndInstall = () => {
		throw new Error("系统拒绝唤起");
	};
	updater.onQuit();
	assert.equal(updater.state().phase, "ready");
	assert.equal(updater.state().canRestart, true);
	assert.match(updater.state().error, /无法重启安装更新/);
	updater.stop();
	native.emit("error", new Error("退出过程中的迟发事件"));
});
