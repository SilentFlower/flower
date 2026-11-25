import assert from "node:assert/strict";

export const product = "Flower Desktop";
export const platform = "win32-x64";
export const buildMarker = "flower-desktop-build.json";
export const managedMarker = ".flower-desktop-managed";
export const managedIdentity = "flower-desktop-portable-1";
export const feedName = "flower-desktop-update.json";
export const releaseVersion = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;

/**
 * 校验由打包人明确指定的隔离更新源。
 * @param {string | undefined} source 完整清单地址
 * @returns {{id: string, manifestUrl?: string}} 要写入 ASAR 的渠道配置
 */
export function packChannel(source) {
	if (source === undefined) return { id: "stable" };
	const url = URL.parse(source);
	assert(
		url?.origin === `http://127.0.0.1:${url?.port}` &&
			url.port &&
			url.pathname === `/${feedName}` &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash,
		`QA 清单须使用 http://127.0.0.1:<端口>/${feedName}`,
	);
	return { id: "qa", manifestUrl: url.href };
}
