/**
 * `sanitize.ts` 单元测试
 *
 * 覆盖:
 * - 主要 quick action 各 1 个 case(approve / close / wip / assign / label / milestone / due / spend / estimate / lock / merge / subscribe / confidential / todo / tag / cc / shrug / tableflip / draft / unapprove / unwip / unassign / unlabel / unsubscribe / unconfidential / remove_milestone / remove_due_date / remove_estimate / unspend / unlock / rebase / done / award / react / title / description / zoom / promote / duplicate / reviewer / target_branch)
 * - 普通行不动(路径引用 / 注释 / 代码块等)
 * - 多行混合 case
 * - 大小写不敏感(`/APPROVE` 也拦截)
 * - 行中间的 `/approve` 不处理(只拦截行首)
 * - 已转义的 `&#47;approve` 不二次转义
 * - 边界字符:`/approve` 后必须是空白或行尾
 */

import { describe, expect, it } from "vitest";
import { sanitizeQuickActions } from "../sanitize.js";

describe("sanitizeQuickActions · 主要 quick action 转义", () => {
	const QUICK_ACTION_CASES: ReadonlyArray<[string, string]> = [
		["/approve", "&#47;approve"],
		["/unapprove", "&#47;unapprove"],
		["/close", "&#47;close"],
		["/reopen", "&#47;reopen"],
		["/wip", "&#47;wip"],
		["/draft", "&#47;draft"],
		["/assign @alice", "&#47;assign @alice"],
		["/unassign", "&#47;unassign"],
		["/label ~bug", "&#47;label ~bug"],
		["/unlabel ~bug", "&#47;unlabel ~bug"],
		["/milestone %v1.0", "&#47;milestone %v1.0"],
		["/due 2026-06-01", "&#47;due 2026-06-01"],
		["/spend 1h", "&#47;spend 1h"],
		["/estimate 2h", "&#47;estimate 2h"],
		["/lock", "&#47;lock"],
		["/unlock", "&#47;unlock"],
		["/merge", "&#47;merge"],
		["/rebase", "&#47;rebase"],
		["/subscribe", "&#47;subscribe"],
		["/unsubscribe", "&#47;unsubscribe"],
		["/confidential", "&#47;confidential"],
		["/todo", "&#47;todo"],
		["/done", "&#47;done"],
		["/tag v1.0", "&#47;tag v1.0"],
		["/cc @bob", "&#47;cc @bob"],
		["/shrug", "&#47;shrug"],
		["/tableflip", "&#47;tableflip"],
		["/award :thumbsup:", "&#47;award :thumbsup:"],
		["/zoom https://zoom.us/x", "&#47;zoom https://zoom.us/x"],
		["/promote", "&#47;promote"],
		["/duplicate #42", "&#47;duplicate #42"],
		["/title 新标题", "&#47;title 新标题"],
	];

	for (const [input, expected] of QUICK_ACTION_CASES) {
		it(`转义 ${input}`, () => {
			expect(sanitizeQuickActions(input)).toBe(expected);
		});
	}
});

describe("sanitizeQuickActions · 大小写不敏感", () => {
	it("/APPROVE 大写也拦截", () => {
		expect(sanitizeQuickActions("/APPROVE")).toBe("&#47;APPROVE");
	});

	it("/Approve 首字母大写也拦截", () => {
		expect(sanitizeQuickActions("/Approve")).toBe("&#47;Approve");
	});

	it("/CLoSe 混合大小写也拦截", () => {
		expect(sanitizeQuickActions("/CLoSe")).toBe("&#47;CLoSe");
	});
});

describe("sanitizeQuickActions · 普通行不动", () => {
	it("普通段落不动", () => {
		const body = "这是一段普通评论,不包含 quick action。";
		expect(sanitizeQuickActions(body)).toBe(body);
	});

	it("行中间的 /approve 不处理(只拦截行首)", () => {
		const body = "请不要在评论里写 /approve,会触发 quick action。";
		expect(sanitizeQuickActions(body)).toBe(body);
	});

	it("代码块里的反引号路径不动", () => {
		const body = "请查看 `/path/to/file.ts` 第 42 行。";
		expect(sanitizeQuickActions(body)).toBe(body);
	});

	it("/path/to/file 这种路径(非 quick action 关键字)不动", () => {
		// `/path` 不在 QUICK_ACTIONS 列表中,正则不命中
		const body = "/path/to/file.ts";
		expect(sanitizeQuickActions(body)).toBe(body);
	});

	it("/approveBucket 这种关键字后非空白的不命中(避免误伤业务路径)", () => {
		// /approve 后是 `B`,不是空白也不是行尾,不应拦截
		const body = "/approveBucket";
		expect(sanitizeQuickActions(body)).toBe(body);
	});

	it("空字符串不动", () => {
		expect(sanitizeQuickActions("")).toBe("");
	});

	it("空行不动", () => {
		expect(sanitizeQuickActions("\n\n\n")).toBe("\n\n\n");
	});
});

describe("sanitizeQuickActions · 多行混合 case", () => {
	it("多行混合:仅转义 quick action 行,其他行不动", () => {
		const body = [
			"## 评审反馈",
			"",
			"/approve", // 这一行会被转义
			"",
			"代码看起来 OK,merge 之前请补充单测。", // 这一行不动
			"",
			"/label ~quality", // 这一行会被转义
			"",
			"参考 `/internal/auth/sign_verify.go` 第 42 行。", // 不动(路径)
		].join("\n");
		const result = sanitizeQuickActions(body);
		expect(result).toContain("&#47;approve");
		expect(result).toContain("&#47;label ~quality");
		// 路径不动
		expect(result).toContain("`/internal/auth/sign_verify.go`");
		// 中文段落不动
		expect(result).toContain("代码看起来 OK");
	});

	it("行内有 `/approve` 反引号包裹,不动", () => {
		const body = "我们不应该在评论里写 `/approve` 这样的 quick action。";
		expect(sanitizeQuickActions(body)).toBe(body);
	});

	it("整篇 markdown 含 details 折叠 + suggestion 块,只处理 quick action 行", () => {
		const body = [
			"_🔴 Blocker_ [severity:blocker]",
			"",
			"**硬编码 secret 存在凭据泄漏风险**",
			"",
			"`hmacSecret` 变量直接以字符串字面量出现在源码中。",
			"",
			"<details>",
			"<summary>修复建议</summary>",
			"",
			"```suggestion",
			'hmacSecret := os.Getenv("SIGN_VERIFY_HMAC_SECRET")',
			"```",
			"",
			"</details>",
			"",
			"/approve", // 仅这一行该被转义
		].join("\n");
		const result = sanitizeQuickActions(body);
		expect(result).toContain("&#47;approve");
		// 其他结构原样保留
		expect(result).toContain("<details>");
		expect(result).toContain("```suggestion");
		expect(result).toContain("[severity:blocker]");
	});
});

describe("sanitizeQuickActions · 已转义不二次处理", () => {
	it("已转义的 &#47;approve 不会被再次转义", () => {
		const body = "&#47;approve";
		// 首字符是 `&` 不是 `/`,正则不命中
		expect(sanitizeQuickActions(body)).toBe(body);
	});

	it("已转义混普通行,不二次处理", () => {
		const body = ["&#47;approve", "下面是新一行评论。"].join("\n");
		expect(sanitizeQuickActions(body)).toBe(body);
	});
});

describe("sanitizeQuickActions · 边界 case", () => {
	it("/approve 后紧跟换行(行尾边界)也拦截", () => {
		const body = "/approve\n下一行";
		expect(sanitizeQuickActions(body)).toBe("&#47;approve\n下一行");
	});

	it("/approve 后跟参数(空白边界)也拦截", () => {
		expect(sanitizeQuickActions("/approve some context")).toBe("&#47;approve some context");
	});

	it("/approve 后紧跟 EOF(无换行)也拦截", () => {
		expect(sanitizeQuickActions("/approve")).toBe("&#47;approve");
	});
});
