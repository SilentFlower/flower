/**
 * `run.ts` 单元测试:scanForBlockers / buildUnsupportedCommentNotice / E1 isLlmFailure /
 * E2 applyDiffCap & resolveMaxFiles / buildLlmFailureNotice
 *
 * runReview 整函数依赖 piMain + gitlabClient + 文件系统,涉及多个 mock 边界,
 * 单测成本不划算,**整体行为靠 e2e 阶段(Step 7-8)真实跑 MR 验**。
 *
 * 这里覆盖可抽出的纯函数 + edge case 防御函数,确保:
 * - scanForBlockers 真实 blocker / 无依据评论 双路径
 * - applyDiffCap 按 churn 降序 + cap 截断
 * - isLlmFailure 各类错误的判定边界(LLM vs GitLab 区分)
 * - resolveMaxFiles env override + 退回默认
 */

import type { BotComment } from "@flower-ai/flower-tools-gitlab";
import { AuthError, FileNotFoundError, type MrFileChange } from "@flower-ai/flower-tools-gitlab";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findUnsupportedComments, type PostedLineComment } from "../review-trace.js";
import {
	applyDiffCap,
	buildLlmFailureNotice,
	buildUnsupportedCommentNotice,
	isLlmFailure,
	ReviewSoftTimeoutError,
	resolveMaxFiles,
	runPiMainWithSoftTimeout,
	scanForBlockers,
} from "../run.js";

function makeComment(id: number, body: string): BotComment {
	return { id, body, file: undefined, line: undefined };
}

describe("scanForBlockers · 真实 blocker(向后兼容旧签名)", () => {
	it("跑前 0 条,跑后新增 1 条 [severity:blocker] → true(应 exitCode=1)", () => {
		const beforeIds = new Set<number>();
		const after = [makeComment(101, "[severity:blocker] SQL 拼接")];
		expect(scanForBlockers(beforeIds, after)).toBe(true);
	});

	it("跑前已有 1 条 blocker,跑后还是同一条 → false(snapshot 生效,不重复 fail)", () => {
		const beforeIds = new Set<number>([42]);
		const after = [makeComment(42, "[severity:blocker] 上一轮就有的问题")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});

	it("跑前 1 条 blocker + 跑后新增 1 条 blocker → true(只看新增)", () => {
		const beforeIds = new Set<number>([42]);
		const after = [makeComment(42, "[severity:blocker] 旧问题"), makeComment(99, "[severity:blocker] 新问题")];
		expect(scanForBlockers(beforeIds, after)).toBe(true);
	});

	it("跑后只有 major / minor,无 blocker → false(应 exitCode=0)", () => {
		const beforeIds = new Set<number>();
		const after = [makeComment(1, "[severity:major] 建议"), makeComment(2, "[severity:minor] 注意")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});

	it("跑后无任何新评论 → false", () => {
		const beforeIds = new Set<number>([1, 2, 3]);
		const after = [makeComment(1, "x"), makeComment(2, "y")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});

	it("severity 前缀大小写敏感:'[Severity:Blocker]' 不命中(必须严格匹配 lowercase)", () => {
		const beforeIds = new Set<number>();
		const after = [makeComment(1, "[Severity:Blocker] 大写")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});

	it("blocker 前缀必须在开头,不能在中间", () => {
		const beforeIds = new Set<number>();
		const after = [makeComment(1, "上下文 [severity:blocker] 在中间")];
		expect(scanForBlockers(beforeIds, after)).toBe(false);
	});
});

describe("scanForBlockers · 对象签名 + 无依据评论检查", () => {
	it("对象签名:仅真实 blocker → true", () => {
		expect(
			scanForBlockers({
				beforeIds: new Set(),
				after: [makeComment(1, "[severity:blocker] x")],
			}),
		).toBe(true);
	});

	it("无新 blocker + 有无依据评论 → true(由无依据评论触发 blocker)", () => {
		expect(
			scanForBlockers({
				beforeIds: new Set(),
				after: [makeComment(1, "[severity:minor] just minor")],
				unsupportedCommentFiles: ["src/a.go"],
			}),
		).toBe(true);
	});

	it("无新 blocker + 无 unsupported → false", () => {
		expect(
			scanForBlockers({
				beforeIds: new Set(),
				after: [makeComment(1, "[severity:minor] just minor")],
				unsupportedCommentFiles: [],
			}),
		).toBe(false);
	});

	it("有新 blocker + 有 unsupported → true(任一命中即 fail)", () => {
		expect(
			scanForBlockers({
				beforeIds: new Set(),
				after: [makeComment(1, "[severity:blocker] real")],
				unsupportedCommentFiles: ["src/a.go"],
			}),
		).toBe(true);
	});
});

describe("findUnsupportedComments · 无依据评论检测纯函数", () => {
	it("评论文件没在 readFiles 中 → 返回该文件", () => {
		const readFiles = new Set<string>([]); // 没读任何文件
		const lineComments: PostedLineComment[] = [{ file: "src/a.go", line: 10, severity: "blocker", title: "" }];
		expect(findUnsupportedComments(readFiles, lineComments)).toEqual(["src/a.go"]);
	});

	it("所有评论文件都已读 → 返回空数组", () => {
		const readFiles = new Set<string>(["src/a.go", "src/b.go"]);
		const lineComments: PostedLineComment[] = [
			{ file: "src/a.go", line: 1, severity: "blocker", title: "" },
			{ file: "src/b.go", line: 5, severity: "minor", title: "" },
		];
		expect(findUnsupportedComments(readFiles, lineComments)).toEqual([]);
	});

	it("部分评论文件未读 → 仅返回未读的(去重 + 排序)", () => {
		const readFiles = new Set<string>(["src/a.go"]);
		const lineComments: PostedLineComment[] = [
			{ file: "src/a.go", line: 1, severity: "blocker", title: "" },
			{ file: "src/c.go", line: 2, severity: "blocker", title: "" },
			{ file: "src/b.go", line: 3, severity: "major", title: "" },
			{ file: "src/c.go", line: 4, severity: "minor", title: "" },
		];
		expect(findUnsupportedComments(readFiles, lineComments)).toEqual(["src/b.go", "src/c.go"]);
	});

	it("空 lineComments → 返回空数组(即使 readFiles 也是空)", () => {
		expect(findUnsupportedComments(new Set(), [])).toEqual([]);
	});
});

describe("buildUnsupportedCommentNotice", () => {
	it("生成清单格式的整体评论 body(单文件)", () => {
		const body = buildUnsupportedCommentNotice(["src/a.go"]);
		expect(body).toContain("无依据评论");
		expect(body).toContain("`src/a.go`");
		expect(body).toContain("gitlab_get_file_content");
	});

	it("多文件 → 列出全部", () => {
		const body = buildUnsupportedCommentNotice(["src/a.go", "src/b.go", "src/c.go"]);
		expect(body).toContain("`src/a.go`");
		expect(body).toContain("`src/b.go`");
		expect(body).toContain("`src/c.go`");
	});
});

/**
 * 构造 MrFileChange 的测试 helper
 */
function makeChange(path: string, churn: { additions: number; deletions: number }): MrFileChange {
	return { path, additions: churn.additions, deletions: churn.deletions };
}

describe("resolveMaxFiles · E2 env 解析", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("env 未设 → 默认 50", () => {
		// 显式取消任何全局污染
		vi.stubEnv("FLOWER_MAX_FILES", "");
		// stubEnv("") 在 vitest 视为 undefined
		expect(resolveMaxFiles()).toBe(50);
	});

	it("env 设有效数字 → 解析为该数字", () => {
		vi.stubEnv("FLOWER_MAX_FILES", "10");
		expect(resolveMaxFiles()).toBe(10);
	});

	it("env 设无效值(非数字)→ 退回默认 50", () => {
		vi.stubEnv("FLOWER_MAX_FILES", "not-a-number");
		expect(resolveMaxFiles()).toBe(50);
	});

	it("env 设 0 / 负数 → 退回默认 50", () => {
		vi.stubEnv("FLOWER_MAX_FILES", "0");
		expect(resolveMaxFiles()).toBe(50);
		vi.stubEnv("FLOWER_MAX_FILES", "-5");
		expect(resolveMaxFiles()).toBe(50);
	});
});

describe("applyDiffCap · E2 按 churn 降序 + cap 截断", () => {
	it("51 个文件,cap 50 → 截断,shown=50/total=51,按 churn 降序", () => {
		// 第 0 个 churn=100,其他 churn 从 50 递减到 0(每个不同)
		const files: MrFileChange[] = [];
		files.push(makeChange("biggest.ts", { additions: 50, deletions: 50 })); // churn 100
		for (let i = 0; i < 50; i++) {
			files.push(makeChange(`file${i}.ts`, { additions: 50 - i, deletions: 0 })); // churn 50-i
		}

		const result = applyDiffCap(files, 50);
		expect(result.truncated).toBe(true);
		expect(result.shown).toBe(50);
		expect(result.total).toBe(51);
		// biggest.ts 一定在 top
		expect(result.files[0]).toBe("biggest.ts");
		// 最小的 file49.ts(churn=1)被砍掉(>= 50 个中只能留 50 - 1 = 49 个,排除最小)
		expect(result.files).not.toContain("file49.ts");
	});

	it("50 个文件,cap 50 → 不截断,truncated=false", () => {
		const files = Array.from({ length: 50 }, (_, i) => makeChange(`f${i}.ts`, { additions: i, deletions: 0 }));
		const result = applyDiffCap(files, 50);
		expect(result.truncated).toBe(false);
		expect(result.shown).toBe(50);
		expect(result.total).toBe(50);
	});

	it("3 个文件,churn 顺序 [10, 100, 50] → 排序后 [100, 50, 10]", () => {
		const files: MrFileChange[] = [
			makeChange("small.ts", { additions: 5, deletions: 5 }), // 10
			makeChange("big.ts", { additions: 60, deletions: 40 }), // 100
			makeChange("medium.ts", { additions: 30, deletions: 20 }), // 50
		];
		const result = applyDiffCap(files, 10);
		expect(result.files).toEqual(["big.ts", "medium.ts", "small.ts"]);
		expect(result.truncated).toBe(false);
	});

	it("churn 相同时,保持原顺序(稳定排序)", () => {
		const files: MrFileChange[] = [
			makeChange("a.ts", { additions: 10, deletions: 0 }),
			makeChange("b.ts", { additions: 10, deletions: 0 }),
			makeChange("c.ts", { additions: 10, deletions: 0 }),
		];
		const result = applyDiffCap(files, 10);
		// 都是 churn=10,按原顺序
		expect(result.files).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("空列表 → 空结果,truncated=false", () => {
		const result = applyDiffCap([], 50);
		expect(result.shown).toBe(0);
		expect(result.total).toBe(0);
		expect(result.files).toEqual([]);
		expect(result.truncated).toBe(false);
	});
});

describe("isLlmFailure · E1 LLM vs GitLab 错误区分", () => {
	it("AuthError(GitLab)→ 非 LLM 失败", () => {
		expect(isLlmFailure(new AuthError("401 Unauthorized"))).toBe(false);
	});

	it("FileNotFoundError(GitLab)→ 非 LLM 失败", () => {
		expect(isLlmFailure(new FileNotFoundError("404 Not Found"))).toBe(false);
	});

	it("非 Error 值 → 非 LLM 失败(保守 fail close)", () => {
		expect(isLlmFailure("string error")).toBe(false);
		expect(isLlmFailure(null)).toBe(false);
		expect(isLlmFailure(undefined)).toBe(false);
		expect(isLlmFailure(42)).toBe(false);
	});

	it("错误信息含 'LLM' 关键字 → LLM 失败", () => {
		expect(isLlmFailure(new Error("LLM provider returned 502"))).toBe(true);
	});

	it("错误信息含 'anthropic' 关键字 → LLM 失败", () => {
		expect(isLlmFailure(new Error("Anthropic API failed"))).toBe(true);
	});

	it("错误信息含 'openai' 关键字 → LLM 失败", () => {
		expect(isLlmFailure(new Error("OpenAI streaming response incomplete"))).toBe(true);
	});

	it("错误信息含 'gemini' 关键字 → LLM 失败", () => {
		expect(isLlmFailure(new Error("gemini provider unreachable"))).toBe(true);
	});

	it("错误信息含 'stream' 关键字 → LLM 失败", () => {
		expect(isLlmFailure(new Error("Stream ended without finish_reason"))).toBe(true);
	});

	it("空 SSE / 无 finish / message_stop / terminated 关键字 → LLM 失败", () => {
		expect(isLlmFailure(new Error("SSE empty response: no data"))).toBe(true);
		expect(isLlmFailure(new Error("stream ended before message_stop"))).toBe(true);
		expect(isLlmFailure(new Error("response terminated before finish_reason"))).toBe(true);
	});

	it("ECONNREFUSED → LLM 失败(网络层失败保守归类 LLM)", () => {
		expect(isLlmFailure(new Error("ECONNREFUSED connect to llm-gateway"))).toBe(true);
	});

	it("timeout → LLM 失败", () => {
		expect(isLlmFailure(new Error("Request timeout"))).toBe(true);
	});

	it("AbortError → LLM 失败", () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		expect(isLlmFailure(err)).toBe(true);
	});

	it("HTTP 5xx → LLM 失败", () => {
		expect(isLlmFailure(new Error("HTTP 502 Bad Gateway"))).toBe(true);
		expect(isLlmFailure(new Error("HTTP 503 Service Unavailable"))).toBe(true);
		expect(isLlmFailure(new Error("500 Internal Server Error"))).toBe(true);
	});

	it("HTTP 429 → LLM 失败(限流)", () => {
		expect(isLlmFailure(new Error("HTTP 429 Too Many Requests"))).toBe(true);
	});

	it("无关键字的普通错误 → 非 LLM 失败(默认 fail close)", () => {
		expect(isLlmFailure(new Error("Some unexpected internal error"))).toBe(false);
		expect(isLlmFailure(new Error("配置错"))).toBe(false);
	});

	it("HTTP 400 等 4xx(非 429)→ 非 LLM 失败", () => {
		expect(isLlmFailure(new Error("HTTP 400 Bad Request"))).toBe(false);
		expect(isLlmFailure(new Error("HTTP 422 Unprocessable Entity"))).toBe(false);
	});
});

describe("buildLlmFailureNotice · E1 warning 文案", () => {
	it("含 warning emoji + 中文提示 + SIEM 标识", () => {
		const body = buildLlmFailureNotice();
		expect(body).toContain("⚠️");
		expect(body).toContain("flower-code-reviewer");
		expect(body).toContain("LLM 网关异常");
		expect(body).toContain("请手工 review");
		expect(body).toContain("SIEM");
	});

	it("文案稳定(snapshot 字面量,改文案需有意识地更新单测)", () => {
		expect(buildLlmFailureNotice()).toBe(
			"⚠️ flower-code-reviewer 因 LLM 网关异常未能完成自动评审,请手工 review 本 MR。\n\n错误详情已上报 SIEM。",
		);
	});

	it("ReviewSoftTimeoutError → 自动评审超时文案", () => {
		const body = buildLlmFailureNotice(new ReviewSoftTimeoutError(1080000));
		expect(body).toContain("自动评审超时");
		expect(body).toContain("请手工 review");
		expect(body).not.toContain("LLM 网关异常");
	});
});

describe("runPiMainWithSoftTimeout", () => {
	it("run 在 timeout 前 resolve → 返回原值", async () => {
		await expect(runPiMainWithSoftTimeout(async () => "ok", 100)).resolves.toBe("ok");
	});

	it("run 超过 timeout → 抛 ReviewSoftTimeoutError", async () => {
		await expect(runPiMainWithSoftTimeout(() => new Promise(() => {}), 1)).rejects.toBeInstanceOf(ReviewSoftTimeoutError);
	});

	it("timeoutMs=0 → 关闭软超时", async () => {
		await expect(runPiMainWithSoftTimeout(async () => "ok", 0)).resolves.toBe("ok");
	});
});
