/**
 * `redact.ts` 单元测试:secret 正则集 + 截断
 *
 * 关键约束(PRD Q2 决议):
 * - 每条规则覆盖正例(被替换)+ 反例(普通文本 / 代码成员访问不误杀)
 * - 截断边界:未超长原样返回、超长标注省略字符数
 * - 顺序契约(先 redact 后 truncate)由 pipeline 测试覆盖,此处只测纯函数
 */

import { describe, expect, it } from "vitest";
import { redactText, serializeValue, truncateText } from "../redact.js";

describe("redactText · secret 正则正例", () => {
	it("GitLab PAT(glpat-)→ 脱敏", () => {
		const text = "header PRIVATE-TOKEN: glpat-AbCd1234_-xyz98765";
		expect(redactText(text)).toBe("header PRIVATE-TOKEN: [REDACTED:gitlab-pat]");
	});

	it("Bearer 头 → 保留 Bearer 字样,token 脱敏", () => {
		const text = "Authorization: Bearer sk-abc123456789XYZ";
		const result = redactText(text);
		expect(result).toContain("Bearer [REDACTED:bearer]");
		expect(result).not.toContain("sk-abc123456789XYZ");
	});

	it("PEM 私钥块(闭合)→ 整段脱敏", () => {
		const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow…base64…\n-----END RSA PRIVATE KEY-----";
		expect(redactText(text)).toBe("[REDACTED:private-key]");
	});

	it("PEM 私钥块(未闭合,被上游截断)→ 余下整段脱敏", () => {
		const text = "prefix -----BEGIN PRIVATE KEY-----\nMIIEow truncated";
		expect(redactText(text)).toBe("prefix [REDACTED:private-key]");
	});

	it("阿里云 AK(LTAI)→ 脱敏", () => {
		expect(redactText("ak=LTAI5tAbCdEfGh123456")).toContain("[REDACTED:aliyun-ak]");
	});

	it("AWS AK(AKIA)→ 脱敏", () => {
		expect(redactText("key AKIAIOSFODNN7EXAMPLE end")).toBe("key [REDACTED:aws-ak] end");
	});

	it("JWT(eyJ 三段)→ 脱敏", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM";
		expect(redactText(`token: ${jwt}`)).toBe("token: [REDACTED:jwt]");
	});

	it("URL 内嵌凭证 → 保留 scheme,user:pass 脱敏", () => {
		const text = "git clone https://oauth2:glp_secret123@gitlab.example.com/a/b.git";
		const result = redactText(text);
		expect(result).toContain("https://[REDACTED:url-credential]@gitlab.example.com");
		expect(result).not.toContain("glp_secret123");
	});

	it("赋值形态 api_key= → 保留键名,值脱敏", () => {
		const text = 'config: API_KEY="abcd1234efgh5678"';
		const result = redactText(text);
		expect(result).toContain("API_KEY=");
		expect(result).toContain("[REDACTED:credential-assign]");
		expect(result).not.toContain("abcd1234efgh5678");
	});

	it("赋值形态 token: (yaml 风格)→ 值脱敏", () => {
		const result = redactText("gitlab_token: hunter2hunter2");
		expect(result).toContain("[REDACTED:credential-assign]");
		expect(result).not.toContain("hunter2hunter2");
	});
});

describe("redactText · 反例(不误杀)", () => {
	it("普通中文/英文文本原样返回", () => {
		const text = "评审发现 3 个问题:函数 parseConfig 缺少空值校验。";
		expect(redactText(text)).toBe(text);
	});

	it("代码成员访问(req.headers.authorization)不误杀", () => {
		// 值字符集不含 `.`:`req` 段不足 8 字符,不会命中 credential-assign
		const text = "const token = req.headers.authorization;";
		expect(redactText(text)).toBe(text);
	});

	it("普通 URL(无凭证)不误杀", () => {
		const text = "见 https://gitlab.example.com/group/repo/-/merge_requests/47";
		expect(redactText(text)).toBe(text);
	});

	it("普通赋值(短值 / 含点变量)不误杀", () => {
		const text = "const apiKeyName = cfg.key;";
		expect(redactText(text)).toBe(text);
	});
});

describe("truncateText", () => {
	it("未超长 → 原样返回", () => {
		expect(truncateText("hello", 10)).toBe("hello");
	});

	it("恰好等长 → 原样返回", () => {
		expect(truncateText("12345", 5)).toBe("12345");
	});

	it("超长 → 截断并标注省略字符数(格式与 console 输出一致)", () => {
		expect(truncateText("1234567890", 4)).toBe("1234 …<+6 chars>");
	});
});

describe("serializeValue", () => {
	it("字符串原样返回", () => {
		expect(serializeValue("abc")).toBe("abc");
	});

	it("对象 → JSON 字符串", () => {
		expect(serializeValue({ a: 1 })).toBe('{"a":1}');
	});

	it("不可 JSON 序列化(循环引用)→ 退化 String()", () => {
		const cyc: Record<string, unknown> = {};
		cyc.self = cyc;
		expect(serializeValue(cyc)).toBe("[object Object]");
	});

	it("undefined → 字符串化(JSON.stringify 返回 undefined 时退化)", () => {
		expect(serializeValue(undefined)).toBe("undefined");
	});
});
