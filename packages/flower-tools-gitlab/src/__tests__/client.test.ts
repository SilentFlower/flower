/**
 * `client.ts` 单元测试:GitLab REST 客户端真实实装
 *
 * 策略:vi.stubGlobal mock 全局 fetch,vi.stubEnv 注入 GITLAB_TOKEN/HOST
 * 每个 test 通过 `_resetClientForTests()` 清模块级缓存
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClientForTests, gitlabClient } from "../client.js";

/** 构造 GitLab `/changes` 接口的 mock 响应体 */
function mockChangesBody(): unknown {
	return {
		diff_refs: {
			base_sha: "BASE_SHA_AAA",
			start_sha: "START_SHA_BBB",
			head_sha: "HEAD_SHA_CCC",
		},
		changes: [
			{
				new_path: "src/auth/login.ts",
				old_path: "src/auth/login.ts",
				new_file: false,
				deleted_file: false,
				diff: "@@ -1 +1 @@\n-old\n+new\n",
			},
			{
				new_path: "src/removed.ts",
				old_path: "src/removed.ts",
				new_file: false,
				deleted_file: true,
				diff: "@@ -1 +0,0 @@\n-removed\n",
			},
		],
	};
}

/** 把一个 plain object 包成 fetch Response(状态码可指定) */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 把一段文本包成 fetch Response(用于错误响应) */
function textResponse(text: string, status: number): Response {
	return new Response(text, { status });
}

describe("gitlabClient · 凭证 fail-fast", () => {
	beforeEach(() => {
		_resetClientForTests();
		vi.unstubAllEnvs();
	});

	it("GITLAB_TOKEN 未设置时首次调用 throw", () => {
		vi.stubEnv("GITLAB_TOKEN", "");
		expect(() => gitlabClient()).toThrow("GITLAB_TOKEN 环境变量未设置");
	});
});

describe("GitlabClient · happy path", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		_resetClientForTests();
		vi.unstubAllEnvs();
		vi.stubEnv("GITLAB_TOKEN", "test-token-xxx");
		vi.stubEnv("GITLAB_HOST", "http://gitlab.test");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("getMrDiff 拼接 diff 含 `--- a/ / +++ b/` 头", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(mockChangesBody()));
		const diff = await gitlabClient().getMrDiff("group/repo", 42);
		expect(diff).toContain("--- a/src/auth/login.ts");
		expect(diff).toContain("+++ b/src/auth/login.ts");
		expect(diff).toContain("--- a/src/removed.ts");
		expect(diff).toContain("@@ -1 +1 @@");
	});

	it("getMrFiles 返回 new_path,deleted_file 取 old_path", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(mockChangesBody()));
		const files = await gitlabClient().getMrFiles("group/repo", 42);
		expect(files).toEqual(["src/auth/login.ts", "src/removed.ts"]);
	});

	it("projectId 含 `/` 时 URL 必须 encodeURIComponent", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(mockChangesBody()));
		await gitlabClient().getMrFiles("group/sub/repo", 7);
		const [calledUrl] = fetchMock.mock.calls[0] ?? [];
		expect(String(calledUrl)).toContain("/projects/group%2Fsub%2Frepo/merge_requests/7/changes");
	});

	it("postMrComment 写入 `[severity:warning] ` body 前缀", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 201));
		await gitlabClient().postMrComment("g/r", 1, "评审建议: x", "warning");
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({ body: "[severity:warning] 评审建议: x" });
	});

	it("postMrLineComment 自动拉 diff_refs 并构造 position 5 字段", async () => {
		// 第 1 次 fetch:GET changes 拿 diff_refs
		fetchMock.mockResolvedValueOnce(jsonResponse(mockChangesBody()));
		// 第 2 次 fetch:POST discussions
		fetchMock.mockResolvedValueOnce(jsonResponse({ id: "d1" }, 201));

		await gitlabClient().postMrLineComment("g/r", 1, {
			file: "src/auth/login.ts",
			line: 5,
			body: "硬编码 secret",
			severity: "blocker",
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const postInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
		const postBody = JSON.parse(String(postInit?.body)) as Record<string, unknown>;
		expect(postBody.body).toBe("[severity:blocker] 硬编码 secret");
		expect(postBody.position).toEqual({
			position_type: "text",
			base_sha: "BASE_SHA_AAA",
			start_sha: "START_SHA_BBB",
			head_sha: "HEAD_SHA_CCC",
			new_path: "src/auth/login.ts",
			new_line: 5,
		});
	});

	it("postMrLineComment 第二次调用复用 diff_refs 缓存(不重复拉 changes)", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(mockChangesBody())) // 第 1 次 GET changes
			.mockResolvedValueOnce(jsonResponse({}, 201)) // 第 1 次 POST
			.mockResolvedValueOnce(jsonResponse({}, 201)); // 第 2 次 POST(无 GET)

		const client = gitlabClient();
		await client.postMrLineComment("g/r", 9, { file: "a.ts", line: 1, body: "x", severity: "info" });
		await client.postMrLineComment("g/r", 9, { file: "a.ts", line: 2, body: "y", severity: "info" });

		expect(fetchMock).toHaveBeenCalledTimes(3);
		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls.filter((u) => u.includes("/changes")).length).toBe(1);
		expect(urls.filter((u) => u.includes("/discussions")).length).toBe(2);
	});

	it("getBotComments 用 /api/v4/user 自查 username 并过滤", async () => {
		// 第 1 次:GET /api/v4/user → 返回 bot username
		fetchMock.mockResolvedValueOnce(jsonResponse({ username: "review-bot" }));
		// 第 2 次:GET notes
		fetchMock.mockResolvedValueOnce(
			jsonResponse([
				{ id: 1, body: "human comment", author: { username: "alice" } },
				{
					id: 2,
					body: "[severity:warning] from bot",
					author: { username: "review-bot" },
					position: { new_path: "src/a.ts", new_line: 10 },
				},
				{
					id: 3,
					body: "[severity:blocker] from bot 2",
					author: { username: "review-bot" },
				},
			]),
		);

		const comments = await gitlabClient().getBotComments("g/r", 1);
		expect(comments).toEqual([
			{ id: 2, body: "[severity:warning] from bot", file: "src/a.ts", line: 10 },
			{ id: 3, body: "[severity:blocker] from bot 2", file: undefined, line: undefined },
		]);
	});

	it("PRIVATE-TOKEN header 与 10s 超时被写入 fetch init", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse(mockChangesBody()));
		await gitlabClient().getMrFiles("g/r", 1);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		const headers = init?.headers as Record<string, string> | undefined;
		expect(headers?.["PRIVATE-TOKEN"]).toBe("test-token-xxx");
		expect(headers?.["Content-Type"]).toBe("application/json");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("GitlabClient · 错误路径", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		_resetClientForTests();
		vi.unstubAllEnvs();
		vi.stubEnv("GITLAB_TOKEN", "t");
		vi.stubEnv("GITLAB_HOST", "http://gitlab.test");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("401 → throw 含 HTTP 401 + endpoint 路径(顺序:path 在前 HTTP 在后)", async () => {
		fetchMock.mockResolvedValueOnce(textResponse('{"message":"401 Unauthorized"}', 401));
		await expect(gitlabClient().getMrFiles("g/r", 1)).rejects.toThrow(
			/\/api\/v4\/projects\/g%2Fr\/merge_requests\/1\/changes.*HTTP 401/,
		);
	});

	it("404 → throw 含 HTTP 404", async () => {
		fetchMock.mockResolvedValueOnce(textResponse("404 Not Found", 404));
		await expect(gitlabClient().getMrFiles("g/r", 999)).rejects.toThrow(/HTTP 404/);
	});

	it("5xx 重试 1 次,第二次成功则不抛", async () => {
		fetchMock
			.mockResolvedValueOnce(textResponse("server boom", 503))
			.mockResolvedValueOnce(jsonResponse(mockChangesBody()));
		const files = await gitlabClient().getMrFiles("g/r", 1);
		expect(files.length).toBeGreaterThan(0);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("5xx 重试 1 次仍失败 → 抛 HTTP 500 错误", async () => {
		fetchMock.mockResolvedValueOnce(textResponse("boom1", 500)).mockResolvedValueOnce(textResponse("boom2", 500));
		await expect(gitlabClient().getMrFiles("g/r", 1)).rejects.toThrow(/HTTP 500/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("错误响应体被截断到 200 字符,防止泄漏长 token / 内部信息", async () => {
		const longBody = "x".repeat(500);
		fetchMock.mockResolvedValueOnce(textResponse(longBody, 403));
		try {
			await gitlabClient().getMrFiles("g/r", 1);
			throw new Error("expected throw");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// 错误信息含 200 个 x,但不含 500 个 x
			expect(msg).toContain("x".repeat(200));
			expect(msg).not.toContain("x".repeat(201));
		}
	});
});
