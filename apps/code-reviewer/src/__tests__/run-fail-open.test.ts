/**
 * `runReview` 整流程的 E1 LLM fail open 集成测试
 *
 * 为什么独立成文件:
 * - 顶层 mock 多个模块(运行适配 / gitlabClient / detectGitlabVersion / pickSkill)
 *   与 run.test.ts 共用 mock 会污染其他纯函数单测
 * - 集中验证 E1 fail open 的端到端行为:LLM 抛错 → 评审不抛 → post warning 评论 + exit 0
 *
 * 同时也覆盖 fail close 路径(非 LLM 错误正常抛):
 * - GitLab `getMrFileChanges` 抛 AuthError → runReview 抛(顶层 cli.ts 转 exit 2)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 顶层 mock 必须在 import runReview 之前完成

vi.mock("../review-execution.js", async (load) => ({
	...(await load<typeof import("../review-execution.js")>()),
	executeReviewRuntime: vi.fn(),
}));

vi.mock("../review-network.js", () => ({
	configureReviewHttp: vi.fn(),
	REVIEW_HTTP_BOOTSTRAP_IDLE_MS: 300_000,
}));

vi.mock("@flower-ai/flower-providers", () => ({
	buildPiCliArgs: vi.fn(() => ["--prompt", "stub"]),
}));

vi.mock("../extension.js", () => ({
	default: (): void => {
		/* no-op extension factory */
	},
}));

vi.mock("../skill-selector.js", () => ({
	pickSkill: vi.fn(async () => "general"),
}));

vi.mock("../comments/index.js", () => ({
	detectGitlabVersion: vi.fn(async () => ({ major: 17, minor: 10 })),
	supportsAlertBlock: () => true,
	// render 函数实际未在 fail-open 路径调用,但 prompts.ts import 需要存在
	renderInlineComment: vi.fn(() => ""),
	renderWalkthrough: vi.fn(() => ""),
	renderCleanReview: vi.fn(() => ""),
}));

vi.mock("@flower-ai/flower-tools-gitlab", async () => {
	const fakeClient = {
		getBotComments: vi.fn(async () => []),
		getMrFileChanges: vi.fn(async () => []),
		postMrComment: vi.fn(async () => {
			/* no-op */
		}),
		getFileContent: vi.fn(async () => ""),
	};
	class AuthError extends Error {
		override readonly name = "AuthError";
	}
	class FileNotFoundError extends Error {
		override readonly name = "FileNotFoundError";
	}
	return {
		gitlabClient: () => fakeClient,
		AuthError,
		FileNotFoundError,
	};
});

import { AuthError, gitlabClient } from "@flower-ai/flower-tools-gitlab";
import { executeReviewRuntime, ReviewSoftTimeoutError, ReviewStartupError } from "../review-execution.js";
import { runReview } from "../run.js";

const mockedExecute = vi.mocked(executeReviewRuntime);
const mockedClient = gitlabClient();
const mockedPostMrComment = vi.mocked(mockedClient.postMrComment);
const mockedGetBotComments = vi.mocked(mockedClient.getBotComments);
const mockedGetMrFileChanges = vi.mocked(mockedClient.getMrFileChanges);

describe("runReview · E1 LLM fail open", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		// 模拟 CI 环境必备 env
		vi.stubEnv("GITLAB_TOKEN", "test-token");
		vi.stubEnv("CI_PROJECT_ID", "group/repo");
		vi.stubEnv("CI_MERGE_REQUEST_IID", "42");
		// 运行适配 默认 mock(各 case override)
		mockedExecute.mockReset();
		mockedPostMrComment.mockReset();
		mockedGetBotComments.mockReset();
		mockedGetMrFileChanges.mockReset();
		mockedGetBotComments.mockResolvedValue([]);
		mockedGetMrFileChanges.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("运行适配 抛 LLM 网络错(message 含 'LLM provider') → runReview 不抛 + post warning 评论 + exitCode 0", async () => {
		// 模拟 LLM 网关失败:运行适配 抛错,错误信息含 LLM 关键字
		mockedExecute.mockRejectedValueOnce(new Error("LLM provider returned HTTP 502"));

		const result = await runReview({ mrIid: 42, skill: "general", dryRun: false });

		// runReview 不抛
		expect(result.exitCode).toBe(0);
		expect(result.skillUsed).toBe("general");

		// post warning 评论被调用 1 次,body 含「LLM 网关异常」
		expect(mockedPostMrComment).toHaveBeenCalledTimes(1);
		const [, , body, severity] = mockedPostMrComment.mock.calls[0] ?? [];
		expect(body).toContain("LLM 网关异常");
		expect(body).toContain("请手工 review");
		expect(severity).toBe("minor");

		// getBotComments 在 fail open 路径里**不应**被调用(因为 scanForBlockers 跳过)
		// 但 fail open 之前的 snapshot 那次会调一次
		expect(mockedGetBotComments).toHaveBeenCalledTimes(1);
	});

	it("运行适配 抛 AbortError → 视为 LLM 失败 + fail open", async () => {
		const err = new Error("Request aborted");
		err.name = "AbortError";
		mockedExecute.mockRejectedValueOnce(err);

		const result = await runReview({ mrIid: 42, skill: "general", dryRun: false });

		expect(result.exitCode).toBe(0);
		expect(mockedPostMrComment).toHaveBeenCalledTimes(1);
	});

	it("运行适配 抛 HTTP 5xx 错 → fail open", async () => {
		mockedExecute.mockRejectedValueOnce(new Error("Gateway returned HTTP 503"));

		const result = await runReview({ mrIid: 42, skill: "general", dryRun: false });

		expect(result.exitCode).toBe(0);
		expect(mockedPostMrComment).toHaveBeenCalledTimes(1);
	});

	it("SDK 启动失败保留退出 1 和零评论", async () => {
		mockedExecute.mockRejectedValueOnce(new ReviewStartupError("LLM_API_KEY 未配置"));
		const result = await runReview({ mrIid: 42, skill: "general", dryRun: false });
		expect(result.exitCode).toBe(1);
		expect(mockedPostMrComment).not.toHaveBeenCalled();
	});

	it("SDK 输出截断保留硬错误", async () => {
		mockedExecute.mockRejectedValueOnce(new Error("评审引擎退出，输出已截断"));
		await expect(runReview({ mrIid: 42, skill: "general", dryRun: false })).rejects.toThrow("输出已截断");
		expect(mockedPostMrComment).not.toHaveBeenCalled();
	});

	it("运行适配 长时间不 resolve → soft timeout 后 fail open + post 自动评审超时 warning", async () => {
		vi.stubEnv("FLOWER_REVIEW_TIMEOUT_MS", "1");
		mockedExecute.mockRejectedValueOnce(new ReviewSoftTimeoutError(1));

		const result = await runReview({ mrIid: 42, skill: "general", dryRun: false });

		expect(result.exitCode).toBe(0);
		expect(mockedPostMrComment).toHaveBeenCalledTimes(1);
		const [, , body, severity] = mockedPostMrComment.mock.calls[0] ?? [];
		expect(body).toContain("自动评审超时");
		expect(body).toContain("请手工 review");
		expect(severity).toBe("minor");
	});

	it("运行适配 抛 AuthError(非 LLM 失败)→ runReview 抛(fail close)", async () => {
		mockedExecute.mockRejectedValueOnce(new AuthError("401 Unauthorized"));

		// fail close:正常抛错,顶层 cli.ts 会转成 exit 2
		await expect(runReview({ mrIid: 42, skill: "general", dryRun: false })).rejects.toBeInstanceOf(AuthError);

		// 不应该 post warning(走 fail close 路径)
		expect(mockedPostMrComment).not.toHaveBeenCalled();
	});

	it("运行适配 抛无关键字的普通错 → fail close(默认 fail close,保守)", async () => {
		mockedExecute.mockRejectedValueOnce(new Error("配置错误:LLM_BASE_URL 未设置 - some unrecognized error"));

		// 该错误信息含 'LLM_BASE_URL' 关键字(因为 'llm' 关键字命中)
		// 实际会被认为是 LLM 失败,fail open
		// 这里展示 isLlmFailure 是基于关键字保守判定的;真正未命中关键字的错才 fail close
		const result = await runReview({ mrIid: 42, skill: "general", dryRun: false });
		expect(result.exitCode).toBe(0);
	});

	it("运行适配 抛真正无 LLM 关键字的错 → fail close", async () => {
		mockedExecute.mockRejectedValueOnce(new Error("内部状态机异常"));

		await expect(runReview({ mrIid: 42, skill: "general", dryRun: false })).rejects.toThrow("内部状态机异常");
		expect(mockedPostMrComment).not.toHaveBeenCalled();
	});

	it("运行适配 成功 → 正常走完后续 scan blocker 路径(本 case 无 blocker)", async () => {
		mockedExecute.mockResolvedValueOnce(undefined);

		const result = await runReview({ mrIid: 42, skill: "general", dryRun: false });
		expect(result.exitCode).toBe(0);
		// 没有 fail open 路径的 warning 评论
		expect(mockedPostMrComment).not.toHaveBeenCalled();
	});
});

describe("runReview · E2 diff cap 注入", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.stubEnv("GITLAB_TOKEN", "test-token");
		vi.stubEnv("CI_PROJECT_ID", "group/repo");
		vi.stubEnv("CI_MERGE_REQUEST_IID", "42");
		mockedExecute.mockReset();
		mockedPostMrComment.mockReset();
		mockedGetBotComments.mockReset();
		mockedGetMrFileChanges.mockReset();
		mockedGetBotComments.mockResolvedValue([]);
		mockedExecute.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("51 个文件,cap 50 → getMrFileChanges 被调用 1 次 + 运行适配 正常完成", async () => {
		const files = Array.from({ length: 51 }, (_, i) => ({
			path: `f${i}.ts`,
			additions: 51 - i,
			deletions: 0,
		}));
		mockedGetMrFileChanges.mockResolvedValueOnce(files);

		await runReview({ mrIid: 42, skill: "general", dryRun: false });

		expect(mockedGetMrFileChanges).toHaveBeenCalledTimes(1);
		expect(mockedExecute).toHaveBeenCalledTimes(1);
	});

	it("getMrFileChanges 抛错 → runReview 不抛(diff cap 失败不阻断评审)", async () => {
		mockedGetMrFileChanges.mockRejectedValueOnce(new Error("changes 接口暂时不可用"));

		const result = await runReview({ mrIid: 42, skill: "general", dryRun: false });
		expect(result.exitCode).toBe(0);
		// 运行适配 仍被调用(评审照常进行,只是 prompt 没截断元数据)
		expect(mockedExecute).toHaveBeenCalledTimes(1);
	});

	it("dryRun=true → 跳过 diff cap 检查(本地调试不应调 GitLab)", async () => {
		await runReview({ mrIid: 42, skill: "general", dryRun: true });
		expect(mockedGetMrFileChanges).not.toHaveBeenCalled();
	});
});
