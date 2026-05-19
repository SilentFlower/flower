/**
 * 工具结果脱敏
 *
 * 在工具结果返回 LLM 之前调用,防止 LLM 把敏感数据复述到对外回复里。
 * 注意:这是"防御纵深"的一层,不能替代权限边界本身。
 */

/**
 * 默认脱敏规则:手机号、身份证号、邮箱、IPv4、可能的密钥
 */
const RULES: ReadonlyArray<{ pattern: RegExp; replace: string }> = [
	{ pattern: /\b1[3-9]\d{9}\b/g, replace: "***PHONE***" },
	{ pattern: /\b\d{17}[\dXx]\b/g, replace: "***IDCARD***" },
	{ pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replace: "***EMAIL***" },
	{ pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replace: "***IP***" },
	// 形如 sk-xxx / pk-xxx / token-xxx 的字符串
	{ pattern: /\b(?:sk|pk|token|bearer)[-_][a-zA-Z0-9]{16,}\b/gi, replace: "***SECRET***" },
];

/**
 * 对文本做脱敏
 *
 * @param text - 待脱敏文本
 * @returns 脱敏后的文本
 */
export function maskSensitive(text: string): string {
	let masked = text;
	for (const rule of RULES) {
		masked = masked.replace(rule.pattern, rule.replace);
	}
	return masked;
}
