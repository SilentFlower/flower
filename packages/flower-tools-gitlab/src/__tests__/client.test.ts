/**
 * `client.ts` 单元测试:GitLab REST 客户端真实实装
 *
 * 策略:vi.stubGlobal mock 全局 fetch,vi.stubEnv 注入 GITLAB_TOKEN/HOST
 * 每个 test 通过 `_resetClientForTests()` 清模块级缓存
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetClientForTests,
	AuthError,
	countDiffChurn,
	FileNotFoundError,
	gitlabClient,
	RetryableError,
} from "../client.js";

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

	it("postMrComment 写入 `[severity:major] ` body 前缀", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 201));
		await gitlabClient().postMrComment("g/r", 1, "评审建议: x", "major");
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({ body: "[severity:major] 评审建议: x" });
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
		await client.postMrLineComment("g/r", 9, { file: "a.ts", line: 1, body: "x", severity: "minor" });
		await client.postMrLineComment("g/r", 9, { file: "a.ts", line: 2, body: "y", severity: "minor" });

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
					body: "[severity:major] from bot",
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
			{ id: 2, body: "[severity:major] from bot", file: "src/a.ts", line: 10 },
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

describe("GitlabClient · getFileContent(N1)", () => {
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

	it("200 成功:返回 UTF-8 文本(中文)+ path/ref 完整 URL-encode", async () => {
		const fileBody = "// 中文注释\nexport function 加法(a: number, b: number): number {\n\treturn a + b;\n}\n";
		fetchMock.mockResolvedValueOnce(new Response(fileBody, { status: 200 }));

		const content = await gitlabClient().getFileContent("group/repo", "src/中文/加法.ts", "main");

		expect(content).toBe(fileBody);
		const [calledUrl] = fetchMock.mock.calls[0] ?? [];
		const url = String(calledUrl);
		// projectId 中的 `/` 必须 encode
		expect(url).toContain("/projects/group%2Frepo/");
		// path 整段 encode(`/` → `%2F`,中文按 UTF-8 编码;真实 URL 形如
		// /files/src%2F%E4%B8%AD%E6%96%87%2F%E5%8A%A0%E6%B3%95.ts/raw?ref=main)
		expect(url).toContain("/repository/files/src%2F");
		expect(url).toContain("%2F%E5%8A%A0%E6%B3%95.ts"); // 中文「加法.ts」UTF-8 编码
		expect(url).toContain("/raw?ref=main");
	});

	it("404 → 抛 FileNotFoundError,不重试", async () => {
		fetchMock.mockResolvedValueOnce(textResponse('{"message":"404 File Not Found"}', 404));

		await expect(gitlabClient().getFileContent("g/r", "nonexistent.ts", "main")).rejects.toBeInstanceOf(
			FileNotFoundError,
		);
		// 404 只调用一次 fetch(不重试,避免无意义请求)
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("401 / 403 → 抛 AuthError", async () => {
		fetchMock.mockResolvedValueOnce(textResponse("Unauthorized", 401));
		await expect(gitlabClient().getFileContent("g/r", "src/a.ts", "main")).rejects.toBeInstanceOf(AuthError);
	});

	it("5xx 重试一次后仍失败 → 抛 RetryableError", async () => {
		fetchMock.mockResolvedValueOnce(textResponse("boom1", 502)).mockResolvedValueOnce(textResponse("boom2", 502));

		await expect(gitlabClient().getFileContent("g/r", "src/a.ts", "main")).rejects.toBeInstanceOf(RetryableError);
		// 503 重试一次 → 总共 2 次
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("5xx 第一次失败但第二次成功 → 返回内容(重试 1 次生效)", async () => {
		fetchMock
			.mockResolvedValueOnce(textResponse("boom", 503))
			.mockResolvedValueOnce(new Response("recovered content", { status: 200 }));

		const content = await gitlabClient().getFileContent("g/r", "src/a.ts", "main");
		expect(content).toBe("recovered content");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("ref 含特殊字符(如 feature/x):正确 URL-encode 到 ?ref=", async () => {
		fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		await gitlabClient().getFileContent("g/r", "a.ts", "feature/x");
		const [calledUrl] = fetchMock.mock.calls[0] ?? [];
		// `/` 编码为 %2F
		expect(String(calledUrl)).toContain("?ref=feature%2Fx");
	});
});

describe("countDiffChurn · diff +/- 行数解析(E2 cap 用)", () => {
	it("单个 +/- 各 1 行", () => {
		const diff = "@@ -1 +1 @@\n-old\n+new\n";
		expect(countDiffChurn(diff)).toEqual({ additions: 1, deletions: 1 });
	});

	it("多个 + 行 + 多个 - 行", () => {
		const diff = "@@ -1,3 +1,2 @@\n-line1\n-line2\n-line3\n+new1\n+new2\n";
		expect(countDiffChurn(diff)).toEqual({ additions: 2, deletions: 3 });
	});

	it("过滤掉 `+++` 与 `---` 文件头", () => {
		const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
		expect(countDiffChurn(diff)).toEqual({ additions: 1, deletions: 1 });
	});

	it("context 行(以空格开头)与 @@ 头不计入", () => {
		const diff = "@@ -1,3 +1,3 @@\n line1\n-removed\n+added\n line3\n";
		expect(countDiffChurn(diff)).toEqual({ additions: 1, deletions: 1 });
	});

	it("空 diff → 0/0", () => {
		expect(countDiffChurn("")).toEqual({ additions: 0, deletions: 0 });
	});

	it("纯增量(新文件)→ deletions=0", () => {
		const diff = "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n";
		expect(countDiffChurn(diff)).toEqual({ additions: 3, deletions: 0 });
	});

	it("纯删除(整文件删除)→ additions=0", () => {
		const diff = "@@ -1,3 +0,0 @@\n-a\n-b\n-c\n";
		expect(countDiffChurn(diff)).toEqual({ additions: 0, deletions: 3 });
	});
});

describe("GitlabClient · getMrFileChanges(E2 churn 排序)", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		_resetClientForTests();
		vi.unstubAllEnvs();
		vi.stubEnv("GITLAB_TOKEN", "test-token");
		vi.stubEnv("GITLAB_HOST", "http://gitlab.test");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("返回 path + additions + deletions(每个文件的 churn)", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					diff_refs: { base_sha: "B", start_sha: "S", head_sha: "H" },
					changes: [
						{
							new_path: "src/a.ts",
							old_path: "src/a.ts",
							new_file: false,
							deleted_file: false,
							diff: "@@ -1 +1,3 @@\n-old\n+new1\n+new2\n+new3\n",
						},
						{
							new_path: "src/b.ts",
							old_path: "src/b.ts",
							new_file: false,
							deleted_file: false,
							diff: "@@ -1,2 +0,0 @@\n-x\n-y\n",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const result = await gitlabClient().getMrFileChanges("group/repo", 42);
		expect(result).toEqual([
			{ path: "src/a.ts", additions: 3, deletions: 1 },
			{ path: "src/b.ts", additions: 0, deletions: 2 },
		]);
	});

	it("deleted_file → path 取 old_path", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					diff_refs: { base_sha: "B", start_sha: "S", head_sha: "H" },
					changes: [
						{
							new_path: "src/gone.ts",
							old_path: "src/gone.ts",
							new_file: false,
							deleted_file: true,
							diff: "@@ -1,2 +0,0 @@\n-a\n-b\n",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const result = await gitlabClient().getMrFileChanges("g/r", 1);
		expect(result).toEqual([{ path: "src/gone.ts", additions: 0, deletions: 2 }]);
	});
});
