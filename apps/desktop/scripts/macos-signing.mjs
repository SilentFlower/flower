import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

const certificateKeys = ["MAC_CERTIFICATE_P12", "MAC_CERTIFICATE_PASSWORD", "APPLE_TEAM_ID"];
export const macSigningEnvironment = [...certificateKeys, "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"];

/** 为正式、回环升级及无凭据预演选择签名策略。
 * @param {object} env 构建环境
 * @param {boolean} qa 是否配置了回环更新源
 * @returns {{id: string, signing: boolean, notarize: boolean}} 组包模式
 */
export function macSigningPolicy(env, qa) {
	const formal = env.FLOWER_MAC_REQUIRE_SIGNING === "1";
	assert(!qa || !formal, "回环升级演练须设置 FLOWER_MAC_REQUIRE_SIGNING=0。");
	if (!qa && !formal && !macSigningEnvironment.some((key) => env[key])) {
		return { id: "preview", signing: false, notarize: false };
	}
	const required = qa ? certificateKeys : macSigningEnvironment;
	const missing = required.filter((key) => !env[key]);
	assert(!missing.length, `macOS 签名缺少 ${missing.join("、")}。`);
	assert(/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID), "APPLE_TEAM_ID 格式有误。");
	return { id: qa ? "qa" : "stable", signing: true, notarize: !qa };
}

/** 校验应用和内部代码的 Developer ID 签名，并按需读取叶证书指纹。
 * @param {string} app 应用包的绝对路径
 * @param {object} options 可选预期 Team ID、安全时间戳要求及临时证书前缀
 * @returns {{team: string, fingerprint?: string}} 验证过的签名身份
 */
export function verifyMacApplicationSignature(app, { expectedTeam, timestamp, certificatePrefix } = {}) {
	const codesign = "/usr/bin/codesign";
	execFileSync(codesign, ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
	const signature = spawnSync(
		codesign,
		["--display", "--verbose=4", ...(certificatePrefix ? [`--extract-certificates=${certificatePrefix}`] : []), app],
		{ encoding: "utf8" },
	);
	assert.equal(signature.status, 0, `无法读取 ${app} 的代码签名。`);
	assert.match(signature.stderr, /^Authority=Developer ID Application: /m);
	assert.match(signature.stderr, /^CodeDirectory .*flags=.*\bruntime\b/m);
	const team = signature.stderr.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
	assert(team, "应用签名缺少有效 Team ID。");
	if (expectedTeam) assert.equal(team, expectedTeam, "Developer ID 签名的 Team ID 不符。");
	if (timestamp) assert.match(signature.stderr, /^Timestamp=/m, "正式制品需使用安全时间戳。");
	const fingerprint = certificatePrefix
		? new X509Certificate(readFileSync(`${certificatePrefix}0`)).fingerprint256
		: undefined;
	return { team, ...(fingerprint && { fingerprint }) };
}
