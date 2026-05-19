/**
 * 钉钉签名校验
 *
 * 算法见钉钉文档:
 * sign = base64( HMAC-SHA256(secret, `${timestamp}\n${secret}`) )
 */

import { createHmac } from "node:crypto";

/**
 * 校验钉钉签名
 *
 * @param timestamp - HTTP header `timestamp` 的值(钉钉服务端时间,毫秒)
 * @param sign - HTTP header `sign` 的值
 * @param secret - 钉钉机器人加签密钥(`DINGTALK_BOT_SECRET`)
 * @returns 是否合法
 */
export function verifySignature(timestamp: string, sign: string, secret: string): boolean {
	// 防重放:超过 1 小时的请求一律拒绝
	const ts = Number.parseInt(timestamp, 10);
	if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > 60 * 60 * 1000) {
		return false;
	}

	const stringToSign = `${timestamp}\n${secret}`;
	const expected = createHmac("sha256", secret).update(stringToSign).digest("base64");

	// 使用恒定时间比较避免计时攻击
	return constantTimeEqual(expected, sign);
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
