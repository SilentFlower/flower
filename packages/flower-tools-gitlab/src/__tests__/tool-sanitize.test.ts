/**
 * 工具层 sanitize 集成测试
 *
 * 验证:`gitlabPostCommentTool` / `gitlabPostLineCommentTool` 在 execute 阶段
 * 会对 body 做 `sanitizeQuickActions`,实际发往 GitLab 的 body 已被转义。
 *
 * 测试边界:
 * - 不测 `sanitizeQuickActions` 本身的行为(已在 flower-tools-common 单测覆盖)
 * - 仅验证"工具确实调了 sanitize",防回归
 *
 * 策略:
 * - vi.stubGlobal mock 全局 fetch
 * - 调用 tool.execute(...)
 * - 检查 fetch 真实接收到的 body 已含 `&#47;` 而非 `^/`
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClientForTests } from "../client.js";
import { gitlabPostCommentTool, gitlabPostLineCommentTool } from "../index.js";

/** 包装一个 fake context id;工具 execute 不用其内容 */
const FAKE_ID = "test-call-id";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * 构造一个最小可用的 ExtensionContext stub
 *
 * 本工具 `execute` 实际上不读 ctx,但 TS 签名要求传 5 个参数。
 * 用 `as unknown as ExtensionContext` 强转规避类型校验。
 */
function fakeCtx(): ExtensionContext {
	return {} as unknown as ExtensionContext;
}

describe("gitlabPostCommentTool · sanitize 集成", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		_resetClientForTests();
		vi.unstubAllEnvs();
		vi.stubEnv("GITLAB_TOKEN", "test-token");
		vi.stubEnv("GITLAB_HOST", "http://gitlab.test");
		vi.stubEnv("CI_PROJECT_ID", "group/repo");
		vi.stubEnv("CI_MERGE_REQUEST_IID", "42");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("body 含 `/approve` 整行 → 经 sanitize 后变成 `&#47;approve`", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 201));

		await gitlabPostCommentTool.execute(
			FAKE_ID,
			{
				body: "/approve\n本 MR 看起来不错,建议合入。",
				severity: "minor",
			},
			undefined,
			undefined,
			fakeCtx(),
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		const body = JSON.parse(String(init?.body)) as { body: string };

		// sanitize 后的 body 应含 &#47;approve,不应含原始 ^/approve 整行
		expect(body.body).toContain("&#47;approve");
		expect(body.body).not.toMatch(/^\[severity:minor\] \/approve/);
		// 普通中文段落仍在
		expect(body.body).toContain("本 MR 看起来不错");
	});

	it("body 含多个 quick action,全部转义", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 201));

		await gitlabPostCommentTool.execute(
			FAKE_ID,
			{
				body: "## 报告\n/approve\n/close\n/label ~bug",
				severity: "blocker",
			},
			undefined,
			undefined,
			fakeCtx(),
		);

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		const body = JSON.parse(String(init?.body)) as { body: string };

		expect(body.body).toContain("&#47;approve");
		expect(body.body).toContain("&#47;close");
		expect(body.body).toContain("&#47;label ~bug");
	});

	it("普通 body 无 quick action → 原样发出(severity 前缀仍由 client 加)", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 201));

		await gitlabPostCommentTool.execute(
			FAKE_ID,
			{
				body: "## 评审报告\n\n看起来不错。",
				severity: "minor",
			},
			undefined,
			undefined,
			fakeCtx(),
		);

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		const body = JSON.parse(String(init?.body)) as { body: string };

		expect(body.body).toBe("[severity:minor] ## 评审报告\n\n看起来不错。");
	});
});

describe("gitlabPostLineCommentTool · sanitize 集成", () => {
	const fetchMock = vi.fn<typeof fetch>();

	function mockChangesBody(): unknown {
		return {
			diff_refs: {
				base_sha: "BASE",
				start_sha: "START",
				head_sha: "HEAD",
			},
			changes: [],
		};
	}

	beforeEach(() => {
		_resetClientForTests();
		vi.unstubAllEnvs();
		vi.stubEnv("GITLAB_TOKEN", "test-token");
		vi.stubEnv("GITLAB_HOST", "http://gitlab.test");
		vi.stubEnv("CI_PROJECT_ID", "group/repo");
		vi.stubEnv("CI_MERGE_REQUEST_IID", "42");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("行内评论 body 含 `/approve` 整行 → sanitize 后发出", async () => {
		// 第 1 次 fetch:GET /changes 拿 diff_refs
		fetchMock.mockResolvedValueOnce(jsonResponse(mockChangesBody()));
		// 第 2 次 fetch:POST /discussions(行内评论)
		fetchMock.mockResolvedValueOnce(jsonResponse({ id: "d1" }, 201));

		await gitlabPostLineCommentTool.execute(
			FAKE_ID,
			{
				file: "src/auth/login.ts",
				line: 42,
				body: "硬编码 secret\n/approve",
				severity: "blocker",
			},
			undefined,
			undefined,
			fakeCtx(),
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const init = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
		const postBody = JSON.parse(String(init?.body)) as { body: string };

		expect(postBody.body).toContain("&#47;approve");
		expect(postBody.body).toContain("硬编码 secret");
		// 行内评论的 severity 前缀也保留
		expect(postBody.body).toMatch(/^\[severity:blocker\]/);
	});
});
