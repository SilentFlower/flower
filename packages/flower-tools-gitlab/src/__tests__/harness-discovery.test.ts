/**
 * harness 自动发现单测。
 *
 * 覆盖平铺/嵌套分组就近命中、多命中消歧、排除自身、白名单过滤、
 * 单跳失败继续上钻、全链未命中与降级语义。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClientForTests } from "../client.js";
import { discoverHarnessProject } from "../harness-discovery.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 按 URL 关键字分发的 fetch mock:groups → 项目清单;branches → 分支清单 */
function dispatchFetch(
	groupProjects: Record<string, unknown[]>,
	branches: unknown[] = [],
): (input: Parameters<typeof fetch>[0]) => Promise<Response> {
	return async (input: Parameters<typeof fetch>[0]) => {
		const url = decodeURIComponent(String(input));
		if (url.includes("/repository/branches")) {
			return jsonResponse(branches);
		}
		for (const [group, projects] of Object.entries(groupProjects)) {
			if (url.includes(`/groups/${group}/projects`)) {
				return jsonResponse(projects);
			}
		}
		return jsonResponse({ message: "404 Group Not Found" }, 404);
	};
}

describe("discoverHarnessProject", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		_resetClientForTests();
		vi.unstubAllEnvs();
		vi.stubEnv("GITLAB_TOKEN", "test-token");
		vi.stubEnv("GITLAB_HOST", "http://gitlab.test");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("IQS 平铺结构:第一跳即命中同级 harness", async () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/iqs");
		vi.stubEnv("CI_PROJECT_PATH", "digital-biz-projects/iqs/xhgj-iqs-ui");
		fetchMock.mockImplementation(
			dispatchFetch(
				{
					"digital-biz-projects/iqs": [
						{ id: 1, path_with_namespace: "digital-biz-projects/iqs/iqs-harness", default_branch: "master" },
					],
				},
				[
					{ name: "v1.4", default: false },
					{ name: "master", default: true },
				],
			),
		);

		const result = await discoverHarnessProject();
		expect(result).not.toBeNull();
		expect(result?.project).toBe("digital-biz-projects/iqs/iqs-harness");
		expect(result?.defaultBranch).toBe("master");
		// default 分支置首
		expect(result?.branches).toEqual(["master", "v1.4"]);
		expect(result?.searchedGroups).toEqual(["digital-biz-projects/iqs"]);
		expect(result?.candidates).toEqual([]);
	});

	it("SRM 嵌套结构:第一跳未命中,上钻父分组命中", async () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/srm/fronts");
		vi.stubEnv("CI_PROJECT_PATH", "digital-biz-projects/srm/fronts/srm-admin-front");
		fetchMock.mockImplementation(
			dispatchFetch({
				"digital-biz-projects/srm/fronts": [],
				"digital-biz-projects/srm": [
					{ id: 2, path_with_namespace: "digital-biz-projects/srm/srm-harness", default_branch: "master" },
				],
			}),
		);

		const result = await discoverHarnessProject();
		expect(result?.project).toBe("digital-biz-projects/srm/srm-harness");
		expect(result?.searchedGroups).toEqual(["digital-biz-projects/srm/fronts", "digital-biz-projects/srm"]);
	});

	it("同跳多命中:优先 <group尾段>-harness 精确命名,其余进 candidates", async () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/srm");
		fetchMock.mockImplementation(
			dispatchFetch({
				"digital-biz-projects/srm": [
					{ id: 3, path_with_namespace: "digital-biz-projects/srm/docs-harness", default_branch: "main" },
					{ id: 4, path_with_namespace: "digital-biz-projects/srm/srm-harness", default_branch: "master" },
				],
			}),
		);

		const result = await discoverHarnessProject();
		expect(result?.project).toBe("digital-biz-projects/srm/srm-harness");
		expect(result?.candidates).toEqual(["digital-biz-projects/srm/docs-harness"]);
	});

	it("排除当前 MR 项目自身(项目名含 harness 不自指)", async () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/iqs");
		vi.stubEnv("CI_PROJECT_PATH", "digital-biz-projects/iqs/iqs-harness");
		fetchMock.mockImplementation(
			dispatchFetch({
				"digital-biz-projects/iqs": [
					{ id: 5, path_with_namespace: "digital-biz-projects/iqs/iqs-harness", default_branch: "master" },
				],
			}),
		);

		const result = await discoverHarnessProject();
		expect(result?.project).toBeNull();
		expect(result?.searchedGroups).toEqual(["digital-biz-projects/iqs"]);
	});

	it("单跳 API 失败 warn 后继续上钻", async () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/srm/fronts");
		fetchMock.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
			const url = decodeURIComponent(String(input));
			if (url.includes("/groups/digital-biz-projects/srm/fronts/projects")) {
				return jsonResponse({ message: "403 Forbidden" }, 403);
			}
			if (url.includes("/groups/digital-biz-projects/srm/projects")) {
				return jsonResponse([
					{ id: 6, path_with_namespace: "digital-biz-projects/srm/srm-harness", default_branch: "master" },
				]);
			}
			return jsonResponse([]);
		});

		const result = await discoverHarnessProject();
		expect(result?.project).toBe("digital-biz-projects/srm/srm-harness");
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("digital-biz-projects/srm/fronts"));
	});

	it("全链未命中:返回 project null 且保留探测链", async () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/srm/fronts");
		fetchMock.mockImplementation(
			dispatchFetch({ "digital-biz-projects/srm/fronts": [], "digital-biz-projects/srm": [] }),
		);

		const result = await discoverHarnessProject();
		expect(result?.project).toBeNull();
		expect(result?.searchedGroups).toEqual(["digital-biz-projects/srm/fronts", "digital-biz-projects/srm"]);
	});

	it("无 CI namespace(本地调试)返回 null 且不发请求", async () => {
		const result = await discoverHarnessProject();
		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("显式收紧白名单时探测链同步收紧", async () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/srm/fronts");
		// 显式只允许自身 namespace:父分组 …/srm 不再探测
		vi.stubEnv("FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES", "digital-biz-projects/srm/fronts");
		fetchMock.mockImplementation(dispatchFetch({ "digital-biz-projects/srm/fronts": [] }));

		const result = await discoverHarnessProject();
		expect(result?.project).toBeNull();
		expect(result?.searchedGroups).toEqual(["digital-biz-projects/srm/fronts"]);
	});

	it("分支清单超上限时截断并标记", async () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/iqs");
		const manyBranches = Array.from({ length: 60 }, (_, i) => ({ name: `b${i}`, default: i === 59 }));
		fetchMock.mockImplementation(
			dispatchFetch(
				{
					"digital-biz-projects/iqs": [
						{ id: 7, path_with_namespace: "digital-biz-projects/iqs/iqs-harness", default_branch: "b59" },
					],
				},
				manyBranches,
			),
		);

		const result = await discoverHarnessProject();
		expect(result?.branches.length).toBe(50);
		expect(result?.branches[0]).toBe("b59");
		expect(result?.branchesTruncated).toBe(true);
	});

	it("分支拉取失败不影响主结果", async () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/iqs");
		fetchMock.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
			const url = decodeURIComponent(String(input));
			if (url.includes("/repository/branches")) {
				return jsonResponse({ message: "500" }, 500);
			}
			return jsonResponse([
				{ id: 8, path_with_namespace: "digital-biz-projects/iqs/iqs-harness", default_branch: "master" },
			]);
		});

		const result = await discoverHarnessProject();
		expect(result?.project).toBe("digital-biz-projects/iqs/iqs-harness");
		expect(result?.branches).toEqual([]);
		expect(result?.branchesTruncated).toBe(false);
	});
});
