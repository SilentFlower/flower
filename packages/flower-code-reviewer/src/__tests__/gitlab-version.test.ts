/**
 * `comments/gitlab-version.ts` 单元测试
 *
 * 覆盖:
 * - `parseVersionString` 各种格式(纯数字 / -ee 后缀 / -pre 后缀 / 无效格式)
 * - `detectGitlabVersion` happy path + 失败兜底(无 token / 401 / 网络错 / 字段缺失)
 * - module-level 缓存生效(同进程内只发一次请求)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetVersionCacheForTests, detectGitlabVersion, parseVersionString } from "../comments/gitlab-version.js";

describe("parseVersionString", () => {
	it("正常格式 `17.10.0-ee` → {17, 10}", () => {
		expect(parseVersionString("17.10.0-ee")).toEqual({ major: 17, minor: 10 });
	});

	it("纯数字 `16.11.5` → {16, 11}", () => {
		expect(parseVersionString("16.11.5")).toEqual({ major: 16, minor: 11 });
	});

	it("`-pre` 后缀 `18.2.0-pre` → {18, 2}", () => {
		expect(parseVersionString("18.2.0-pre")).toEqual({ major: 18, minor: 2 });
	});

	it("仅 major.minor `17.10` → {17, 10}", () => {
		expect(parseVersionString("17.10")).toEqual({ major: 17, minor: 10 });
	});

	it("无效格式 `not-a-version` → null", () => {
		expect(parseVersionString("not-a-version")).toBeNull();
	});

	it("空字符串 → null", () => {
		expect(parseVersionString("")).toBeNull();
	});
});

describe("detectGitlabVersion", () => {
	beforeEach(() => {
		_resetVersionCacheForTests();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		_resetVersionCacheForTests();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("happy path:200 + version 字段 → 解析成功", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ version: "17.10.0-ee", revision: "abc" }), { status: 200 })),
		);
		const v = await detectGitlabVersion({ gitlabHost: "https://gitlab.example.com", gitlabToken: "tok" });
		expect(v).toEqual({ major: 17, minor: 10 });
	});

	it("无 token → 直接返回 null,不发请求", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const v = await detectGitlabVersion({ gitlabHost: "https://gitlab.example.com", gitlabToken: undefined });
		expect(v).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("HTTP 401 → 返回 null(降级)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Unauthorized", { status: 401 })),
		);
		const v = await detectGitlabVersion({ gitlabHost: "https://gitlab.example.com", gitlabToken: "bad-tok" });
		expect(v).toBeNull();
	});

	it("网络错误 → 返回 null,不抛", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
		const v = await detectGitlabVersion({ gitlabHost: "https://gitlab.example.com", gitlabToken: "tok" });
		expect(v).toBeNull();
	});

	it("response 缺 version 字段 → 返回 null", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ revision: "abc" }), { status: 200 })),
		);
		const v = await detectGitlabVersion({ gitlabHost: "https://gitlab.example.com", gitlabToken: "tok" });
		expect(v).toBeNull();
	});

	it("module-level 缓存:第二次调用不再发请求", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: "17.10.0-ee" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const v1 = await detectGitlabVersion({ gitlabHost: "https://gitlab.example.com", gitlabToken: "tok" });
		const v2 = await detectGitlabVersion({ gitlabHost: "https://gitlab.example.com", gitlabToken: "tok" });
		expect(v1).toEqual({ major: 17, minor: 10 });
		expect(v2).toEqual({ major: 17, minor: 10 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("缓存 null 失败结果:第二次调用不重试", async () => {
		const fetchMock = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		await detectGitlabVersion({ gitlabHost: "https://gitlab.example.com", gitlabToken: "bad-tok" });
		await detectGitlabVersion({ gitlabHost: "https://gitlab.example.com", gitlabToken: "bad-tok" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
