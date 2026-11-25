import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createDesktopUpdater, desktopUpdateChannel, electronReleaseFetch } from "../workbench/desktop-update.mjs";
import { launchDesktop } from "./desktop-harness.mjs";

const archive = Buffer.alloc(160, 1);
const manifest = {
	product: "Flower Desktop",
	platform: "win32-x64",
	channel: "qa",
	version: "1.0.1",
	download: "Flower-Desktop-1.0.1-win32-x64.zip",
	size: archive.length,
	sha256: createHash("sha256").update(archive).digest("hex"),
	notes: "中文版本说明",
};

async function host(t, config, overrides = {}) {
	const directory = await mkdtemp(join(tmpdir(), "flower-update-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const phases = [];
	const staged = [];
	const handoff = [];
	const profile = join(directory, "隔离资料");
	const installation = { root: directory, version: "1.0.0", channel: config.id };
	const launch = (options = {}) => {
		const updater = createDesktopUpdater({
			available: true,
			config,
			version: installation.version,
			executable: join(directory, "Flower Desktop.exe"),
			userData: profile,
			directory,
			findInstallation: async () => installation,
			busy: () => false,
			notify: () => phases.push(updater.state()),
			stage: async (root, zip, candidate) => {
				assert.equal(root, installation);
				assert.deepEqual(await readFile(zip), archive);
				staged.push(candidate.version);
			},
			startInstall: async (root, candidate, plan) => {
				assert.equal(root, installation);
				handoff.push({ version: candidate.version, ...plan });
			},
			storage: {
				isEncryptionAvailable: () => true,
				encryptString: (s) => Buffer.from(s),
				decryptString: (b) => b.toString(),
			},
			...overrides,
			...options,
		});
		t.after(updater.stop);
		return updater;
	};
	return { launch, phases, staged, handoff, profile };
}

async function serve(t, serveRequest) {
	const server = createServer(serveRequest);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return desktopUpdateChannel({
		id: "qa",
		manifestUrl: `http://127.0.0.1:${server.address().port}/flower-desktop-update.json`,
	});
}

test("正式包绑定 Flower 稳定 Release，仅允许受信的 GitHub 附件跳转", async (t) => {
	const config = desktopUpdateChannel({ id: "stable", manifestUrl: "https://example.org/fake.json" });
	assert.equal(
		config.url.href,
		"https://github.com/SilentFlower/flower/releases/download/flower-desktop-stable/flower-desktop-update.json",
	);
	for (const url of [
		"http://example.org:9090/flower-desktop-update.json",
		"http://127.0.0.1:9090/wrong.json",
		"http://127.0.0.1:9090/flower-desktop-update.json?source=other",
	]) {
		assert.throws(() => desktopUpdateChannel({ id: "qa", manifestUrl: url }), /频道/);
	}
	const calls = [];
	const { launch } = await host(t, config);
	const asset =
		"https://release-assets.githubusercontent.com/github-production-release-asset/flower/manifest?signature=fixture";
	let redirect = "http://127.0.0.1:9090/flower-desktop-update.json";
	const updater = launch({
		fetcher: async (url, options) => {
			calls.push(url.href);
			assert.equal(options.redirect, "manual");
			assert.equal(options.credentials, "omit");
			if (url.href === config.url.href) return Response.redirect(redirect);
			if (url.href === asset) return Response.json({ ...manifest, channel: "stable" });
			assert.equal(url.href, new URL(manifest.download, config.url).href);
			return new Response(archive);
		},
	});
	assert.match((await updater.check()).error, /信任/);
	assert.deepEqual(calls, [config.url.href]);
	redirect = asset;
	assert.equal((await updater.check()).phase, "ready");
	assert.deepEqual(calls, [config.url.href, config.url.href, asset, new URL(manifest.download, config.url).href]);
});

test("正式清单尚未发布显示中立状态，区分失联和制品缺失", async (t) => {
	const config = desktopUpdateChannel();
	const { launch } = await host(t, config);
	let mode = "unpublished";
	const requests = [];
	const updater = launch({
		fetcher: async (url) => {
			requests.push(url.href);
			if (mode === "offline") throw new Error("连接失败");
			if (mode === "unpublished" || url.href !== config.url.href) return new Response(null, { status: 404 });
			return Response.json({ ...manifest, channel: "stable" });
		},
	});
	const unpublished = await updater.check();
	assert.equal(unpublished.phase, "unpublished");
	assert.equal(unpublished.error, undefined);
	assert.equal(unpublished.canRestart, false);
	assert.deepEqual(requests, [config.url.href]);
	mode = "offline";
	assert.match((await updater.check()).error, /无法连接/);
	mode = "assetMissing";
	assert.match((await updater.check()).error, /制品暂时不可用/);
});

test("系统代理传输暴露手动跳转和续传响应，超时会取消请求", async () => {
	let mode = "redirect";
	const events = [];
	const fetcher = electronReleaseFetch((options) => {
		assert.equal(options.credentials, "omit");
		assert.equal(options.redirect, "manual");
		const request = new EventEmitter();
		request.setHeader = (name, value) => events.push({ name, value });
		request.abort = () => {
			events.push("abort");
			request.emit("close");
		};
		request.end = () => {
			if (mode === "redirect") {
				request.emit("redirect", 302, "GET", "https://example.org/asset");
				request.emit("error", new Error("Electron 取消未跟随的跳转"));
				request.emit("close");
			}
			if (mode === "range") {
				const body = Readable.from([archive.subarray(55)]);
				body.statusCode = 206;
				body.headers = { "content-range": "bytes 55-159/160" };
				request.emit("response", body);
				body.once("end", () => request.emit("close"));
			}
		};
		return request;
	});
	const url = desktopUpdateChannel().url;
	const signal = new AbortController();
	const redirect = await fetcher(url, { headers: {}, signal: signal.signal });
	assert.equal(redirect.status, 302);
	assert.equal(redirect.headers.get("location"), "https://example.org/asset");
	mode = "range";
	const range = await fetcher(url, { headers: { range: "bytes=55-" }, signal: signal.signal });
	assert.equal(range.status, 206);
	assert.equal(range.headers.get("content-range"), "bytes 55-159/160");
	assert.deepEqual(Buffer.from(await range.arrayBuffer()), archive.subarray(55));
	mode = "hold";
	const held = fetcher(url, { headers: {}, signal: signal.signal });
	signal.abort();
	await assert.rejects(held, { name: "AbortError" });
	assert.deepEqual(events, [{ name: "range", value: "bytes=55-" }, "abort"]);
});

test("真实回环断线后重新启动续传，只有实际退出才触发安排的完整更新", async (t) => {
	const ranges = [];
	const fragmentStored = Promise.withResolvers();
	const config = await serve(t, (req, res) => {
		if (req.url === "/flower-desktop-update.json") return res.end(JSON.stringify(manifest));
		assert.equal(req.url, `/${manifest.download}`);
		ranges.push(req.headers.range);
		if (ranges.length === 1) {
			res.setHeader("Content-Length", archive.length);
			res.write(archive.subarray(0, 55));
			// 等主进程落盘后才断线，避免慢机器还未收到第一段就被夹具关闭。
			const fallback = setTimeout(() => res.destroy(), 5000).unref();
			void fragmentStored.promise.then(() => {
				clearTimeout(fallback);
				res.destroy();
			});
			return;
		}
		assert.equal(req.headers.range, "bytes=55-");
		res.writeHead(206, { "Content-Range": "bytes 55-159/160" });
		res.end(archive.subarray(55));
	});
	const { launch, phases, staged, handoff, profile } = await host(t, config);
	const first = launch({
		notify: () => {
			if (first.state().received === 55) fragmentStored.resolve();
		},
	});
	assert.equal((await first.check()).phase, "error");
	assert.equal(first.state().received, 55);
	first.stop();
	let busy = true;
	const second = launch({ busy: () => busy });
	assert.equal((await second.check()).phase, "ready");
	assert.deepEqual(ranges, [undefined, "bytes=55-"]);
	assert.ok(phases.some(({ phase, received }) => phase === "downloading" && received === 55));
	assert.equal(second.state().notes, manifest.notes);
	assert.equal(second.state().canRestart, false);
	assert.throws(() => second.restart(), /正在处理/);
	assert.equal(second.wantsInstall(), false);
	await second.schedule(true);
	assert.equal(second.wantsInstall(), true);
	await second.schedule(false);
	assert.equal(second.wantsInstall(), false);
	await second.schedule(true);
	assert.deepEqual(handoff, []);
	second.stop();
	busy = false;
	const third = launch();
	assert.equal((await third.check()).scheduled, true);
	assert.deepEqual(staged, ["1.0.1", "1.0.1"]);
	assert.deepEqual(handoff, []);
	await third.onQuit();
	assert.deepEqual(handoff, [{ version: "1.0.1", restart: false, userData: profile }]);
});

test("失败清单、摘要、降级及退出取消均保留当前版", async (t) => {
	let published = { ...manifest, channel: "stable" };
	let archiveRequests = 0;
	const config = await serve(t, (req, res) => {
		if (req.url === "/flower-desktop-update.json") return res.end(JSON.stringify(published));
		archiveRequests++;
		res.end(archive);
	});
	const { launch, handoff, profile } = await host(t, config);
	const updater = launch();
	for (const invalid of [
		{ channel: "stable" },
		{ platform: "linux" },
		{ download: "../arbitrary.zip" },
		{ version: "1.0.1\n", download: "Flower-Desktop-1.0.1\n-win32-x64.zip" },
		{ sha256: `${manifest.sha256}\n` },
	]) {
		published = { ...manifest, ...invalid };
		assert.match((await updater.check()).error, /清单/);
	}
	published = { ...manifest, version: "0.9.9", download: "Flower-Desktop-0.9.9-win32-x64.zip" };
	assert.equal((await updater.check()).phase, "current");
	assert.equal(archiveRequests, 0);
	published = { ...manifest, sha256: "0".repeat(64) };
	assert.match((await updater.check()).error, /SHA-256/);
	assert.equal(updater.wantsInstall(), false);
	published = manifest;
	assert.equal((await updater.check()).phase, "ready");
	assert.equal(updater.restart().phase, "installing");
	updater.cancelRestart();
	assert.equal(updater.wantsInstall(), false);
	assert.deepEqual(handoff, []);
	assert.equal(updater.restart().phase, "installing");
	await updater.onQuit();
	assert.deepEqual(handoff, [{ version: "1.0.1", restart: true, userData: profile }]);
});

test("助手交接失败后恢复已准备版本并撤销旧的退出安排", async (t) => {
	const config = await serve(t, (req, res) => {
		if (req.url === "/flower-desktop-update.json") return res.end(JSON.stringify(manifest));
		res.end(archive);
	});
	const { launch, handoff } = await host(t, config);
	const first = launch({
		startInstall: async () => {
			throw new Error("测试助手未准备好");
		},
	});
	assert.equal((await first.check()).phase, "ready");
	await first.schedule(true);
	await assert.rejects(first.onQuit(), /测试助手/);
	const reopened = launch();
	await reopened.check();
	assert.equal(reopened.state().phase, "ready");
	assert.match(reopened.state().error, /上次更新未能交给启动器/);
	assert.equal(reopened.wantsInstall(), false);
	await reopened.onQuit();
	assert.deepEqual(handoff, []);
});

test("旧平铺或开发入口通过受限 preload 返回迁移状态", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-update-legacy-"));
	const desktop = await launchDesktop(root, { version: "1.0.0" });
	t.after(async () => {
		await desktop.close();
		await rm(root, { force: true, recursive: true });
	});
	const state = await desktop.state((value) => value.ready);
	assert.equal(state.desktopUpdate.phase, "unavailable");
	assert.equal((await desktop.api.desktopUpdateState()).currentVersion, "1.0.0");
	assert.equal((await desktop.api.checkDesktopUpdate()).phase, "unavailable");
});
