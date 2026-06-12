/**
 * 脱敏与截断
 *
 * 职责边界:telemetry 落盘 / 上报内容的最后一道防线(defense-in-depth)。
 * GitLab CI 自身会 mask 已配置的 secret、工具层 safeReadFile 有 size cap,
 * 但**代码里硬编码的凭证**不在上述两层覆盖范围 — JSONL 要进 CI artifact 持久化,必须在这里兜住。
 *
 * 顺序约定:**先 redact 后 truncate**(截断可能把 secret 切半逃过正则)。
 */

/**
 * 脱敏规则:`pattern` 命中部分替换为 `replacement`(支持 `$1` 反向引用保留上下文)
 */
interface RedactRule {
	/** 规则名(进入替换占位符,便于在 trace 中统计哪类凭证被脱敏) */
	name: string;
	/** 匹配模式(必须带 g flag) */
	pattern: RegExp;
	/** 替换串(可用 `$1` 保留键名等非敏感上下文) */
	replacement: string;
}

/**
 * 内置 secret 模式集
 *
 * 收录原则:高置信度的"字面凭证"模式;宁可对纯代码文本轻微过杀,不可漏真凭证。
 * 值字符集刻意**不含 `.`**(排除 `req.headers.authorization` 这类代码成员访问误杀),
 * JWT(含 `.`)由独立规则覆盖。
 */
const REDACT_RULES: RedactRule[] = [
	// GitLab Personal/Project Access Token(glpat- 前缀)
	{ name: "gitlab-pat", pattern: /glpat-[A-Za-z0-9_-]{10,}/g, replacement: "[REDACTED:gitlab-pat]" },
	// HTTP Authorization Bearer 头
	{ name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, replacement: "Bearer [REDACTED:bearer]" },
	// PEM 私钥块(含 RSA / EC / OPENSSH 等变体;未闭合块也整段脱掉)
	{
		name: "private-key",
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
		replacement: "[REDACTED:private-key]",
	},
	// 阿里云 AccessKey ID(LTAI 前缀)
	{ name: "aliyun-ak", pattern: /\bLTAI[A-Za-z0-9]{12,24}\b/g, replacement: "[REDACTED:aliyun-ak]" },
	// AWS AccessKey ID(AKIA 前缀)
	{ name: "aws-ak", pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: "[REDACTED:aws-ak]" },
	// JWT(三段 base64url,首段固定 eyJ)
	{
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
		replacement: "[REDACTED:jwt]",
	},
	// URL 内嵌凭证(scheme://user:pass@host)
	{
		name: "url-credential",
		pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+:[^/\s@]+@/gi,
		replacement: "$1[REDACTED:url-credential]@",
	},
	// 赋值形态的 token / secret / password / api_key(保留键名与分隔符,只脱值)
	{
		name: "credential-assign",
		pattern:
			/\b([A-Za-z0-9_-]*(?:token|secret|passwd|password|api_?key)[A-Za-z0-9_-]*\s*[=:]\s*["']?)[A-Za-z0-9_+/=-]{8,}/gi,
		replacement: "$1[REDACTED:credential-assign]",
	},
];

/**
 * 对文本执行全部脱敏规则
 *
 * @param text 原始文本
 * @returns 脱敏后的文本(无命中时原样返回)
 */
export function redactText(text: string): string {
	let result = text;
	for (const rule of REDACT_RULES) {
		result = result.replace(rule.pattern, rule.replacement);
	}
	return result;
}

/**
 * 截断文本到最大长度,超出部分标注省略字符数
 *
 * 标注格式与 code-reviewer 既有 console 输出一致(` …<+N chars>`),
 * 便于人读 trace 时直接判断截断量。
 *
 * @param text 待截断文本
 * @param max 最大保留字符数
 * @returns 截断后的文本(未超长时原样返回)
 */
export function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)} …<+${text.length - max} chars>`;
}

/**
 * 任意值 → 字符串序列化(对象 JSON.stringify,不可序列化时退化 String())
 *
 * adapter 把工具入参 / 结果对象转字符串用;脱敏与截断由 pipeline 统一执行
 * (保证"已脱敏"约束只有一个 enforcement 点)。
 *
 * @param value 任意值
 * @returns 序列化后的字符串(未脱敏、未截断)
 */
export function serializeValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
