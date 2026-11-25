import { readFileSync } from "node:fs";

const macBundleId = "com.silentflower.flower-desktop";
const stableRoot = "https://github.com/SilentFlower/flower/releases/download/flower-desktop-stable/";
const architectures = new Set(["arm64", "x64"]);
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;

/** 为原生更新和缓存指定正式或隔离应用身份。@param {string} channel 包内频道 @returns {string} Bundle ID */
export function macApplicationId(channel) {
	return channel === "stable" ? macBundleId : `${macBundleId}.${channel}`;
}

/** 解析用于组包和验证的三段式版本。@param {string} version 产品版本 @returns {number[] | undefined} 版本段 */
export function macVersion(version) {
	return typeof version === "string" && version === version.trim()
		? versionPattern.exec(version)?.slice(1).map(Number)
		: undefined;
}

/** 统一组包和更新端使用的 macOS 资产名。@param {string} version 产品版本 @param {string} arch 目标架构 @returns {object} 文件名 */
export function macReleaseNames(version, arch) {
	if (!macVersion(version) || !architectures.has(arch)) throw new Error("macOS 版本或架构无效。");
	const stem = `Flower-Desktop-${version}-darwin-${arch}`;
	return { dmg: `${stem}.dmg`, zip: `${stem}.zip`, feed: `flower-desktop-mac-${arch}.json` };
}

/** 复核组包内的 Mac 频道和当前执行架构。@param {object} raw 包内配置 @param {string} arch Electron 执行架构 @returns {object} 可信频道 */
export function macUpdateChannel(raw, arch) {
	if (!architectures.has(arch) || raw?.arch !== arch) throw new Error("macOS 更新配置与应用架构不符。");
	const { feed } = macReleaseNames("0.0.0", arch);
	if (raw.id === "preview") return { id: "qa", arch };
	if (raw.id === "stable") return { id: "stable", arch, url: new URL(feed, stableRoot) };
	const url = typeof raw.manifestUrl === "string" ? URL.parse(raw.manifestUrl) : null;
	if (
		raw.id === "qa" &&
		url?.origin === `http://127.0.0.1:${url?.port}` &&
		url.port &&
		url.pathname === `/${feed}` &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash
	) {
		return { id: "qa", arch, url };
	}
	throw new Error("macOS 更新频道配置无效。");
}

/** 从当前应用的固定资源读取 Mac 频道。@param {string} arch Electron 执行架构 @returns {object | undefined} 已核验配置 */
export function bundledMacUpdateChannel(arch) {
	try {
		return macUpdateChannel(JSON.parse(readFileSync(new URL("./update-channel.json", import.meta.url), "utf8")), arch);
	} catch {
		return undefined;
	}
}

/** 生成静态 Squirrel.JSON 清单。@param {object} options 版本、架构、频道与可选说明 @returns {object} 原生发现清单 */
export function macReleaseFeed({ version, arch, config, notes = "", date = new Date() }) {
	const { zip } = macReleaseNames(version, arch);
	const channel = macUpdateChannel(config, arch);
	const updateTo = {
		version,
		name: version,
		pub_date: date.toISOString(),
		notes: notes.slice(0, 4000),
		url: new URL(zip, channel.url ?? stableRoot).href,
	};
	return { currentRelease: version, releases: [{ version, updateTo }] };
}

function isNewer(candidate, current) {
	const left = macVersion(candidate);
	const right = macVersion(current);
	if (!left || !right) return false;
	const first = left.findIndex((part, index) => part !== right[index]);
	return first >= 0 && left[first] > right[first];
}

/** 将 Electron 的 Squirrel.Mac 状态与退出交接接入工作台。@param {object} options 原生更新器、构建配置与任务门禁 @returns {object} 工作台更新接口 */
export function createMacDesktopUpdater({ native, config, version, notify, busy, beforeRestart, restartFailed }) {
	let phase = config.url ? "idle" : "unavailable";
	let prepared;
	let error;
	let requested = false;
	let installing = false;
	let stopped = false;
	const state = () => ({
		phase,
		currentVersion: version,
		channel: config.id,
		installPolicy: "on-exit",
		scheduled: Boolean(prepared),
		canRestart: phase === "ready" && !busy(),
		...(prepared && { version: prepared.version, notes: prepared.notes }),
		...(error && { error }),
	});
	function publish(next, problem) {
		phase = next;
		error = problem;
		notify();
	}
	function failure() {
		if (stopped) return;
		const restarting = requested;
		requested = installing = false;
		publish(
			prepared ? "ready" : "error",
			restarting ? "无法重启安装更新。可以正常退出应用后再打开。" : "暂时无法从 macOS 更新频道读取或下载更新。",
		);
		if (restarting) restartFailed();
	}
	const listeners = {
		"checking-for-update"() {
			if (!stopped && phase === "checking") notify();
		},
		"update-available"() {
			if (!stopped && phase === "checking") publish("downloading");
		},
		"update-not-available"() {
			if (!stopped && ["checking", "downloading"].includes(phase)) publish("current");
		},
		"update-downloaded"(...args) {
			if (stopped || !["checking", "downloading"].includes(phase)) return;
			// Electron 的 JS 事件包含 event，底层桥接也存在直接传递说明字符串的形态。
			const [notes, candidateVersion, , url] = typeof args[0] === "string" ? args : args.slice(1);
			if (
				!isNewer(candidateVersion, version) ||
				url !== new URL(macReleaseNames(candidateVersion, config.arch).zip, config.url).href
			) {
				publish("error", "macOS 更新版本或制品地址无效。");
				return;
			}
			prepared = { version: candidateVersion, notes: typeof notes === "string" ? notes.slice(0, 4000) : "" };
			publish("ready");
		},
		"before-quit-for-update"() {
			if (!stopped && installing) beforeRestart();
		},
		error: failure,
	};
	if (config.url) {
		for (const [name, handler] of Object.entries(listeners)) native.on(name, handler);
		try {
			native.setFeedURL({ url: config.url.href, serverType: "json" });
		} catch {
			failure();
		}
	}
	return {
		state,
		check() {
			if (!stopped && config.url && ["idle", "current", "error"].includes(phase)) {
				publish("checking");
				try {
					native.checkForUpdates();
				} catch {
					failure();
				}
			}
			return state();
		},
		schedule() {
			if (!prepared) throw new Error("新版尚未准备好。");
			return state();
		},
		restart() {
			if (phase !== "ready" || !prepared) throw new Error("新版尚未准备好。");
			if (busy()) throw new Error("有任务正在处理，请等待任务结束后重启。");
			requested = true;
			publish("installing");
			return state();
		},
		cancelRestart() {
			if (!requested) return;
			failure();
		},
		wantsInstall: () => false,
		onQuit() {
			if (!requested || installing || stopped) return;
			installing = true;
			try {
				native.quitAndInstall();
			} catch {
				failure();
			}
		},
		stop() {
			// 进程退出前 Squirrel 可能仍发出 error，保留空处理避免 EventEmitter 抛出。
			stopped = true;
		},
	};
}
