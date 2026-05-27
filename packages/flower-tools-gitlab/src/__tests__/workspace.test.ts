/**
 * 跨项目 workspace helper 单测。
 *
 * 覆盖白名单、路径归一化和安全别名校验,避免 agent 工具退化成任意 clone。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertAllowedGroup,
	assertAllowedProject,
	buildRepositoryUrl,
	normalizeGroupPath,
	normalizeProjectPath,
	normalizeWorkspaceAlias,
	normalizeWorkspaceRef,
	resolveAllowedProjectPrefixes,
} from "../workspace.js";

describe("workspace · 白名单解析", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("优先读取 FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES", () => {
		vi.stubEnv("FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES", " digital-biz-projects/iqs , xhgj003027 ");
		vi.stubEnv("CI_PROJECT_NAMESPACE", "ignored");
		expect(resolveAllowedProjectPrefixes()).toEqual(["digital-biz-projects/iqs", "xhgj003027"]);
	});

	it("未显式配置时使用 CI_PROJECT_NAMESPACE", () => {
		vi.stubEnv("CI_PROJECT_NAMESPACE", "digital-biz-projects/iqs");
		expect(resolveAllowedProjectPrefixes()).toEqual(["digital-biz-projects/iqs"]);
	});

	it("没有 CI_PROJECT_NAMESPACE 时从 CI_PROJECT_PATH 推导 namespace", () => {
		vi.stubEnv("CI_PROJECT_PATH", "digital-biz-projects/iqs/xhgj-iqs-boot");
		expect(resolveAllowedProjectPrefixes()).toEqual(["digital-biz-projects/iqs"]);
	});
});

describe("workspace · project/group 校验", () => {
	it("允许同 namespace 下项目", () => {
		expect(() =>
			assertAllowedProject("digital-biz-projects/iqs/iqs-harness", ["digital-biz-projects/iqs"]),
		).not.toThrow();
	});

	it("拒绝不在白名单内的项目", () => {
		expect(() => assertAllowedProject("other/group/repo", ["digital-biz-projects/iqs"])).toThrow(/白名单/);
	});

	it("允许白名单 group 本身和子 group", () => {
		expect(() => assertAllowedGroup("digital-biz-projects/iqs", ["digital-biz-projects/iqs"])).not.toThrow();
		expect(() => assertAllowedGroup("digital-biz-projects/iqs/sub", ["digital-biz-projects/iqs"])).not.toThrow();
	});

	it("拒绝 URL 和路径穿越", () => {
		expect(() => normalizeProjectPath("http://gitlab/repo.git")).toThrow(/不能是 URL/);
		expect(() => normalizeProjectPath("group/../repo")).toThrow(/路径穿越/);
		expect(() => normalizeGroupPath("group/../repo")).toThrow(/路径穿越/);
	});
});

describe("workspace · 本地路径和仓库 URL", () => {
	it("normalizeProjectPath 去掉首尾斜杠和 .git 后缀", () => {
		expect(normalizeProjectPath("/digital-biz-projects/iqs/iqs-harness.git/")).toBe(
			"digital-biz-projects/iqs/iqs-harness",
		);
	});

	it("normalizeWorkspaceAlias 只允许安全字符", () => {
		expect(normalizeWorkspaceAlias("iqs-harness_v1.4")).toBe("iqs-harness_v1.4");
		expect(() => normalizeWorkspaceAlias("../bad")).toThrow(/alias/);
		expect(() => normalizeWorkspaceAlias("bad/path")).toThrow(/alias/);
	});

	it("normalizeWorkspaceRef 拒绝空值、命令参数和路径穿越", () => {
		expect(normalizeWorkspaceRef(" v1.4 ")).toBe("v1.4");
		expect(normalizeWorkspaceRef("feature/harness-docs")).toBe("feature/harness-docs");
		expect(() => normalizeWorkspaceRef("")).toThrow(/ref/);
		expect(() => normalizeWorkspaceRef("--upload-pack=sh")).toThrow(/ref/);
		expect(() => normalizeWorkspaceRef("feature/../main")).toThrow(/ref/);
		expect(() => normalizeWorkspaceRef("bad ref")).toThrow(/ref/);
	});

	it("buildRepositoryUrl 不包含 token", () => {
		const url = buildRepositoryUrl("http://gitlab.xhgjdev.com/", "digital-biz-projects/iqs/iqs-harness");
		expect(url).toBe("http://gitlab.xhgjdev.com/digital-biz-projects/iqs/iqs-harness.git");
		expect(url).not.toContain("token");
	});
});
