/**
 * 跨项目 GitLab 工具层测试。
 *
 * 覆盖工具注册、白名单校验和 execute 返回格式。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClientForTests } from "../client.js";
import {
	gitlabListGroupProjectsTool,
	gitlabListProjectBranchesTool,
	gitlabPrepareProjectWorkspaceTool,
	registerGitlabTools,
} from "../index.js";

const FAKE_ID = "test-call-id";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeCtx(): ExtensionContext {
	return {} as unknown as ExtensionContext;
}

describe("registerGitlabTools · 跨项目工具注册", () => {
	it("注册 3 个跨项目上下文工具", () => {
		const registeredTools: Array<{ name: string }> = [];
		registerGitlabTools({
			registerTool: (def: { name: string }) => {
				registeredTools.push(def);
			},
		});

		expect(registeredTools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				"gitlab_list_group_projects",
				"gitlab_list_project_branches",
				"gitlab_prepare_project_workspace",
			]),
		);
	});
});

describe("跨项目工具 execute", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		_resetClientForTests();
		vi.unstubAllEnvs();
		vi.stubEnv("GITLAB_TOKEN", "test-token");
		vi.stubEnv("GITLAB_HOST", "http://gitlab.test");
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/iqs");
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("gitlab_list_group_projects 返回 TSV 摘要", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse([
				{
					id: 63,
					path_with_namespace: "digital-biz-projects/iqs/iqs-harness",
					default_branch: "master",
					web_url: "http://gitlab.test/digital-biz-projects/iqs/iqs-harness",
				},
			]),
		);

		const result = await gitlabListGroupProjectsTool.execute(
			FAKE_ID,
			{ group: "digital-biz-projects/iqs", includeSubgroups: true, search: "harness" },
			undefined,
			undefined,
			fakeCtx(),
		);

		const text = result.content[0];
		expect(text?.type).toBe("text");
		expect(text && "text" in text ? text.text : "").toContain("digital-biz-projects/iqs/iqs-harness");
		expect(text && "text" in text ? text.text : "").toContain("master");
	});

	it("gitlab_list_project_branches 返回分支摘要", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse([
				{
					name: "v1.4",
					default: false,
					protected: false,
					commit: { short_id: "79507fe7", committed_date: "2026-05-24T13:21:51.000+08:00", title: "chore" },
				},
			]),
		);

		const result = await gitlabListProjectBranchesTool.execute(
			FAKE_ID,
			{ project: "digital-biz-projects/iqs/iqs-harness", search: "v1.4" },
			undefined,
			undefined,
			fakeCtx(),
		);

		const text = result.content[0];
		expect(text && "text" in text ? text.text : "").toContain("v1.4");
		expect(text && "text" in text ? text.text : "").toContain("79507fe7");
	});

	it("非白名单项目在工具层被拒绝", async () => {
		await expect(
			gitlabListProjectBranchesTool.execute(
				FAKE_ID,
				{ project: "other/group/repo", search: "main" },
				undefined,
				undefined,
				fakeCtx(),
			),
		).rejects.toThrow(/白名单/);
	});

	it("gitlab_prepare_project_workspace 返回路径、commit 且不包含 token", async () => {
		const mockedWorkspace = {
			path: "/tmp/review-context/repos/iqs-harness",
			project: "digital-biz-projects/iqs/iqs-harness",
			ref: "v1.4",
			commit: "79507fe7abc",
			reused: true,
		};
		const clientModule = await import("../client.js");
		const client = clientModule.gitlabClient();
		vi.spyOn(client, "prepareProjectWorkspace").mockResolvedValueOnce(mockedWorkspace);

		const result = await gitlabPrepareProjectWorkspaceTool.execute(
			FAKE_ID,
			{ project: "digital-biz-projects/iqs/iqs-harness", ref: "v1.4", alias: "iqs-harness", depth: 1 },
			undefined,
			undefined,
			fakeCtx(),
		);

		const text = result.content[0];
		expect(text && "text" in text ? text.text : "").toContain("/tmp/review-context/repos/iqs-harness");
		expect(text && "text" in text ? text.text : "").toContain("79507fe7abc");
		expect(text && "text" in text ? text.text : "").not.toContain("test-token");
	});
});
