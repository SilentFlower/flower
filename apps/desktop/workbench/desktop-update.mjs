import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { findPortableInstallation, stagePortableVersion, startPortableUpdate } from "./portable-update-install.mjs";
import { readJson, writeJson } from "./storage.mjs";

const releaseRoot = "https://github.com/SilentFlower/flower/releases/download/flower-desktop-stable/";
const manifestName = "flower-desktop-update.json";
const assetHosts = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const digestPattern = /^[a-f\d]{64}$/;
const maxArchive = 1024 ** 3;
const maxManifest = 32 * 1024;
const product = "Flower Desktop";
const platform = "win32-x64";
const networkError = "暂时无法连接更新频道。可继续使用当前版本，稍后重试。";

/** 从包内配置确定更新频道。正式包使用固定的 GitHub Release。
 * @param config 构建写入应用包内的配置
 * @returns 频道和固定清单地址
 */
export function desktopUpdateChannel(config = { id: "stable" }) {
	if (config?.id === "stable") return { id: "stable", url: new URL(manifestName, releaseRoot) };
	if (config?.id === "qa" && typeof config.manifestUrl === "string") {
		const url = URL.parse(config.manifestUrl);
		if (
			url?.protocol === "http:" &&
			["127.0.0.1", "[::1]"].includes(url.hostname) &&
			url.port &&
			url.pathname === `/${manifestName}` &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		)
			return { id: "qa", url };
	}
	throw new Error("安装包的更新频道配置无效。");
}

/** 读取应用包内的频道。旧平铺包缺少此文件时沿用稳定频道。
 * @returns 已绑定发行源的频道
 */
export function bundledUpdateChannel() {
	try {
		const config = JSON.parse(readFileSync(new URL("./update-channel.json", import.meta.url), "utf8"));
		return desktopUpdateChannel(config);
	} catch (problem) {
		if (problem.code === "ENOENT") return desktopUpdateChannel();
		return undefined;
	}
}

/** 将 Electron 的系统代理网络请求接入更新校验，保留逐跳检查和流式下载。
 * @param request Electron 主进程的 net.request
 * @returns 更新下载器使用的请求函数
 */
export function electronReleaseFetch(request) {
	return (url, { headers, signal }) => {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const connection = request({ url: url.href, method: "GET", redirect: "manual", credentials: "omit" });
			for (const [name, value] of Object.entries(headers)) connection.setHeader(name, value);
			let incoming;
			const abort = () => {
				incoming?.destroy(signal.reason);
				connection.abort();
				reject(signal.reason);
			};
			connection.once("error", reject);
			connection.once("close", () => signal.removeEventListener("abort", abort));
			connection.once("redirect", (status, _method, location) => {
				// Electron 会取消未同步跟随的跳转。由调用方核对目标后另发一条请求。
				resolve(new Response(null, { status, headers: { location } }));
			});
			connection.once("response", (response) => {
				incoming = response;
				response.once("error", reject);
				const status = response.statusCode;
				const body = [204, 205, 304].includes(status)
					? null
					: Readable.toWeb(response, { strategy: { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength } });
				if (!body) response.resume();
				resolve(new Response(body, { status, headers: response.headers }));
			});
			signal.addEventListener("abort", abort, { once: true });
			connection.end();
		});
	};
}

function after(version, current) {
	const proposed = versionPattern.exec(version)?.slice(1).map(Number);
	const installed = versionPattern.exec(current)?.slice(1).map(Number);
	if (!proposed || !installed) return false;
	const different = proposed.findIndex((part, index) => part !== installed[index]);
	return different >= 0 && proposed[different] > installed[different];
}

function candidateOf(config, manifest) {
	const version = manifest?.version;
	if (
		manifest?.product !== product ||
		manifest.platform !== platform ||
		manifest.channel !== config.id ||
		typeof version !== "string" ||
		version !== version.trim() ||
		!versionPattern.test(version) ||
		manifest.download !== `Flower-Desktop-${version}-win32-x64.zip` ||
		typeof manifest.sha256 !== "string" ||
		manifest.sha256.length !== 64 ||
		!digestPattern.test(manifest.sha256) ||
		!Number.isSafeInteger(manifest.size) ||
		manifest.size < 22 ||
		manifest.size > maxArchive
	)
		throw new Error("更新清单的产品、版本、平台或制品校验信息无效。");
	return {
		version,
		channel: config.id,
		download: manifest.download,
		digest: manifest.sha256,
		size: manifest.size,
		notes: typeof manifest.notes === "string" ? manifest.notes.slice(0, 4000) : "",
	};
}

function archiveUrl(config, candidate) {
	return new URL(candidate.download, config.url);
}

async function releaseFetch(config, requested, signal, fetcher, range) {
	let url = requested;
	for (let redirect = 0; redirect < 4; redirect++) {
		let response;
		try {
			const headers = { "accept-encoding": "identity" };
			if (range) headers.range = `bytes=${range}-`;
			response = await fetcher(url, { headers, redirect: "manual", signal, credentials: "omit" });
		} catch {
			throw new Error(networkError);
		}
		if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
			const next = URL.parse(response.headers.get("location"), url);
			await response.body?.cancel().catch(() => {});
			// 清单和版本化制品名称由应用指定。只接受 GitHub 发行附件的 HTTPS 跳转。
			if (
				config.id !== "stable" ||
				!next ||
				next.protocol !== "https:" ||
				next.username ||
				next.password ||
				next.port ||
				next.hash ||
				!assetHosts.has(next.hostname) ||
				!next.pathname.startsWith("/github-production-release-asset")
			)
				throw new Error("更新地址跳转到了未经信任的来源。");
			url = next;
			continue;
		}
		if ((response.ok && response.body) || (range && response.status === 416)) return response;
		await response.body?.cancel().catch(() => {});
		if (response.status === 404) {
			if (config.id === "stable" && url.href === config.url.href) return undefined;
			throw new Error(
				requested.href === config.url.href ? "更新清单暂时不可用，请稍后重试。" : "更新制品暂时不可用，请稍后重试。",
			);
		}
		throw new Error(networkError);
	}
	throw new Error("更新地址跳转次数过多。");
}

async function readManifest(config, signal, fetcher) {
	const response = await releaseFetch(config, config.url, signal, fetcher);
	if (!response) return undefined;
	const reader = response.body.getReader();
	try {
		const chunks = [];
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxManifest) throw new Error();
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
	} catch {
		throw new Error("无法读取更新清单。");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function statIfPresent(path) {
	return lstat(path).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
}

async function trustedFile(path) {
	const info = await statIfPresent(path);
	if (info && !info.isFile()) throw new Error("本机更新缓存位置已变化。");
	return info;
}

async function verifyDownload(path, candidate, signal) {
	const file = await trustedFile(path);
	if (!file || file.size !== candidate.size) return false;
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
	return digest.digest("hex") === candidate.digest;
}

const archiveName = ({ version, digest }) => `${version}-${digest}.zip`;
const receiptName = "ready.json";

async function downloadArchive(config, candidate, folder, signal, fetcher, progress) {
	const final = join(folder, archiveName(candidate));
	const partial = `${final}.part`;
	if (await verifyDownload(final, candidate, signal)) return final;
	await rm(final, { force: true });
	const saved = await trustedFile(partial);
	let offset = saved?.size ?? 0;
	if (offset >= candidate.size) {
		if (await verifyDownload(partial, candidate, signal)) {
			await rename(partial, final);
			return final;
		}
		await rm(partial, { force: true });
		offset = 0;
	}
	const url = archiveUrl(config, candidate);
	let response = await releaseFetch(config, url, signal, fetcher, offset);
	if (
		offset &&
		(response.status === 416 ||
			(response.status === 206 &&
				response.headers.get("content-range") !== `bytes ${offset}-${candidate.size - 1}/${candidate.size}`))
	) {
		await response.body?.cancel().catch(() => {});
		await rm(partial, { force: true });
		offset = 0;
		response = await releaseFetch(config, url, signal, fetcher);
	}
	const reader = response.body.getReader();
	let handle;
	try {
		const range = response.headers.get("content-range");
		const resumed =
			offset > 0 && response.status === 206 && range === `bytes ${offset}-${candidate.size - 1}/${candidate.size}`;
		if (!resumed && response.status !== 200) throw new Error("下载服务器返回了无效的续传范围。");
		const before = await trustedFile(partial);
		if (resumed && before?.size !== offset) throw new Error("本机续传文件已变化。");
		handle = await open(partial, before ? "r+" : "wx", 0o600);
		const opened = await handle.stat();
		if (before && (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size))
			throw new Error("本机更新缓存位置已变化。");
		if (!resumed) {
			await handle.truncate(0);
			offset = 0;
		}
		progress(offset);
		let lastProgress = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (offset + value.byteLength > candidate.size) throw new Error("更新文件大小与发行清单不符。");
			// 断线时保留已写入的字节。续传前重新核对位置，最终对完整 ZIP 校验摘要。
			let written = 0;
			while (written < value.byteLength) {
				const result = await handle.write(value, written, value.byteLength - written, offset + written);
				if (!result.bytesWritten) throw new Error("无法继续写入更新缓存。");
				written += result.bytesWritten;
			}
			offset += value.byteLength;
			const now = Date.now();
			if (offset === candidate.size || now - lastProgress >= 160) {
				progress(offset);
				lastProgress = now;
			}
		}
		await handle.sync();
	} finally {
		await Promise.allSettled([reader.cancel(), handle?.close()]);
		reader.releaseLock();
	}
	if (offset !== candidate.size) throw new Error("更新下载未完成，可重新检查并续传。");
	if (!(await verifyDownload(partial, candidate, signal))) {
		await rm(partial, { force: true });
		throw new Error("更新文件的 SHA-256 校验失败。");
	}
	await rename(partial, final);
	return final;
}

async function pruneCache(folder, keep) {
	const files = await readdir(folder, { withFileTypes: true });
	const stale = files.filter(
		(entry) => entry.isFile() && /^\d+\.\d+\.\d+-[a-f\d]{64}\.zip(?:\.part)?$/.test(entry.name) && entry.name !== keep,
	);
	await Promise.allSettled(stale.map(({ name }) => rm(join(folder, name), { force: true })));
}

/** 管理应用固定更新源、下载进度、待安装版本与用户的退出选择。
 * @param options 当前版本、安装归属、缓存和宿主生命周期入口
 * @returns 状态、检查、安装选择及退出处理入口
 */
export function createDesktopUpdater({
	config,
	version,
	executable,
	userData,
	directory,
	available,
	notify,
	busy,
	storage,
	fetcher = fetch,
	findInstallation = findPortableInstallation,
	stage = stagePortableVersion,
	startInstall = startPortableUpdate,
}) {
	let phase = available ? "idle" : "unavailable";
	let installation;
	let checking;
	let stopping = false;
	let prepared;
	let scheduled = false;
	let restart = false;
	let current;
	let received;
	let error;
	let installFailure;
	const cancellation = new AbortController();
	const folder = join(directory, "updates");
	const receipt = join(folder, receiptName);
	const canSeal = () => storage?.isEncryptionAvailable?.() === true;
	const state = () => ({
		phase,
		currentVersion: version,
		channel: config.id,
		...(current && { version: current.version, notes: current.notes, size: current.size }),
		...(received !== undefined && { received }),
		...(error && { error }),
		scheduled,
		canRestart: phase === "ready" && !busy(),
	});
	function publish(next, problem) {
		phase = next;
		error = problem;
		notify();
	}

	async function saveReceipt() {
		if (!canSeal() || !prepared) return;
		const candidate = prepared;
		const sealed = storage
			.encryptString(
				JSON.stringify({
					manifest: {
						product,
						platform,
						version: candidate.version,
						download: candidate.download,
						channel: candidate.channel,
						sha256: candidate.digest,
						size: candidate.size,
						notes: candidate.notes,
					},
					scheduled,
				}),
			)
			.toString("base64");
		await writeJson(receipt, { sealed });
	}

	const init = available
		? (async () => {
				try {
					installation = await findInstallation(executable, version, config.id);
					if (!installation) return publish("unavailable");
					await mkdir(folder, { recursive: true, mode: 0o700 });
					if (!(await lstat(folder)).isDirectory()) throw new Error("本机更新缓存目录位置已变化。");
					const failure = join(installation.root, "last-update-error.txt");
					const info = await trustedFile(failure);
					if (info?.size > 0 && info.size <= 4096) {
						installFailure = (await readFile(failure, "utf8")).trim().slice(0, 400);
						await rm(failure, { force: true }).catch(() => {});
					}
					const failedStart = join(folder, "failed.json");
					if (await trustedFile(failedStart)) {
						installFailure ||= "上次更新未能交给启动器。可继续使用当前版本并重试。";
						await rm(failedStart, { force: true }).catch(() => {});
					}
					if (!canSeal() || !(await trustedFile(receipt))) {
						if (installFailure) publish("error", installFailure);
						return;
					}
					const { sealed } = await readJson(receipt);
					const stored = JSON.parse(storage.decryptString(Buffer.from(sealed, "base64")));
					const candidate = candidateOf(config, stored.manifest);
					if (!after(candidate.version, version)) {
						await rm(receipt, { force: true });
						await pruneCache(folder);
						return;
					}
					const archive = join(folder, archiveName(candidate));
					await stage(installation, archive, candidate, cancellation.signal);
					current = candidate;
					prepared = candidate;
					scheduled = !installFailure && stored.scheduled === true;
					if (installFailure) await saveReceipt();
					publish("ready", installFailure);
				} catch {
					if (cancellation.signal.aborted) return;
					await rm(receipt, { force: true }).catch(() => {});
					publish("error", "无法恢复本机更新，请重新检查。");
				}
			})()
		: Promise.resolve();

	async function check() {
		await init;
		if (!installation || stopping || restart) return state();
		if (checking) return checking;
		checking = (async () => {
			try {
				publish("checking");
				const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(10000)]);
				const manifest = await readManifest(config, signal, fetcher);
				const candidate = manifest === undefined ? undefined : candidateOf(config, manifest);
				if (!candidate || !after(candidate.version, version)) {
					current = prepared = received = undefined;
					scheduled = false;
					await rm(receipt, { force: true });
					await pruneCache(folder);
					publish(candidate ? "current" : "unpublished");
					return state();
				}
				if (prepared?.digest === candidate.digest && prepared.version === candidate.version) {
					current = candidate;
					publish("ready", installFailure);
					return state();
				}
				current = candidate;
				received = 0;
				publish("downloading");
				const downloadSignal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(12 * 60_000)]);
				const archive = await downloadArchive(config, candidate, folder, downloadSignal, fetcher, (bytes) => {
					received = bytes;
					notify();
				});
				await stage(installation, archive, candidate, downloadSignal);
				prepared = candidate;
				installFailure = undefined;
				received = candidate.size;
				scheduled = false;
				await saveReceipt();
				await pruneCache(folder, archiveName(candidate));
				publish("ready");
			} catch (problem) {
				if (!cancellation.signal.aborted) {
					if (prepared) {
						current = prepared;
						received = current.size;
					}
					publish(prepared ? "ready" : "error", problem.message || networkError);
				}
			}
			return state();
		})().finally(() => {
			checking = undefined;
		});
		return checking;
	}

	return {
		state,
		check,
		async schedule(value) {
			if (typeof value !== "boolean" || phase !== "ready" || !prepared) throw new Error("新版尚未准备好。");
			const previous = scheduled;
			scheduled = value;
			try {
				await saveReceipt();
			} catch (problem) {
				scheduled = previous;
				throw problem;
			}
			notify();
			return state();
		},
		restart() {
			if (phase !== "ready" || !prepared) throw new Error("新版尚未准备好。");
			if (busy()) throw new Error("有任务正在处理，请等待任务结束后重启。");
			restart = true;
			publish("installing");
			return state();
		},
		cancelRestart() {
			if (!restart) return;
			restart = false;
			publish("ready");
		},
		wantsInstall() {
			return Boolean(installation && prepared && (restart || scheduled));
		},
		async onQuit() {
			if (!installation || !prepared || (!restart && !scheduled)) return;
			stopping = true;
			cancellation.abort();
			try {
				await startInstall(installation, prepared, { restart, userData });
			} catch (problem) {
				scheduled = false;
				await saveReceipt().catch(() => {});
				await writeJson(join(folder, "failed.json"), { failed: true }).catch(() => {});
				throw problem;
			}
		},
		stop() {
			stopping = true;
			cancellation.abort();
		},
	};
}
