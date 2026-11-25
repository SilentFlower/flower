import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approveWorkspace } from "../workbench/workspace.mjs";
import { commitGitChanges, gitChanges, gitCommitPreview, updateGitStage } from "../workbench/workspace-git.mjs";

const runGit = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "flower-git-write-"));
	t.after(() => rm(root, { force: true, recursive: true }));
	runGit(root, "init", "-qb", "flower-qa");
	runGit(root, "config", "user.name", "Flower QA");
	runGit(root, "config", "user.email", "flower-qa@example.invalid");
	runGit(root, "config", "core.hooksPath", "/dev/null");
	runGit(root, "config", "commit.gpgSign", "false");
	const sub = join(root, "data");
	await mkdir(sub);
	return { root, sub, workspace: await approveWorkspace(sub), git: (...args) => runGit(root, ...args) };
}

test("仅暂存所选工作区内的文件，初始提交和取消暂存保留工作区内容", async (t) => {
	const { root, sub, workspace, git } = await fixture(t);
	const report = "-报表[版本].md";
	await writeFile(join(sub, report), "第一行\n");
	await writeFile(join(root, "outside.md"), "未授权路径\n");
	await assert.rejects(updateGitStage(workspace, "../outside.md", "stage"), /变更已更新/);
	assert.equal(git("diff", "--cached", "--name-only"), "");

	const staged = await updateGitStage(workspace, report, "stage");
	assert.equal(staged.entries.find(({ path }) => path === report)?.group, "staged");
	assert.deepEqual(git("ls-files", "-z").split("\0").filter(Boolean), [`data/${report}`]);
	await updateGitStage(workspace, report, "unstage");
	assert.equal(git("diff", "--cached", "--name-only"), "");
	assert.equal(await readFile(join(sub, report), "utf8"), "第一行\n");

	await updateGitStage(workspace, report, "stage");
	git("add", "--", "outside.md");
	await assert.rejects(gitCommitPreview(workspace), /工作区之外/);
	git("update-index", "--force-remove", "--", "outside.md");
	const preview = await gitCommitPreview(workspace);
	assert.equal(preview.head, "");
	assert.equal(preview.branch, "flower-qa");
	assert.deepEqual(preview.paths, [report]);
	const result = await commitGitChanges(workspace, "更新报表\n\n第一次提交", preview);
	assert.equal(result.commit, git("rev-parse", "HEAD").trim());
	assert.equal(result.branch, "flower-qa");
	assert.equal(git("show", "-s", "--format=%B", "HEAD").trim(), "更新报表\n\n第一次提交");
	assert.equal(git("show", `HEAD:data/${report}`), "第一行\n");
	assert.equal(await readFile(join(root, "outside.md"), "utf8"), "未授权路径\n");
	assert.equal(git("ls-tree", "--name-only", "HEAD").trim(), "data");
});

test("只提交用户已确认的暂存内容，改授、分支和外部暂存变化使旧确认失效", async (t) => {
	const { root, sub, workspace, git } = await fixture(t);
	await writeFile(join(sub, "report.txt"), "初始");
	await writeFile(join(root, "outside.txt"), "初始外部");
	git("add", "-A");
	git("commit", "-qm", "initial");
	const head = git("rev-parse", "HEAD").trim();

	await writeFile(join(sub, "report.txt"), "暂存甲");
	await updateGitStage(workspace, "report.txt", "stage");
	const first = await gitCommitPreview(workspace);
	await writeFile(join(sub, "report.txt"), "暂存乙");
	await updateGitStage(workspace, "report.txt", "stage");
	await assert.rejects(commitGitChanges(workspace, "使用旧内容", first), /确认期间发生变化/);
	assert.equal(git("rev-parse", "HEAD").trim(), head);

	await writeFile(join(root, "outside.txt"), "外部变动");
	git("add", "--", "outside.txt");
	await assert.rejects(gitCommitPreview(workspace), /工作区之外/);
	git("restore", "--staged", "--", "outside.txt");
	const confirmation = await gitCommitPreview(workspace);
	assert.deepEqual(confirmation.paths, ["report.txt"]);
	await writeFile(join(sub, "report.txt"), "未暂存丙");
	git("checkout", "-qb", "another");
	await assert.rejects(commitGitChanges(workspace, "错分支", confirmation), /确认期间发生变化/);
	await assert.rejects(commitGitChanges(workspace, "取消", confirmation, AbortSignal.abort()), { name: "AbortError" });
	git("checkout", "-q", "flower-qa");
	const committed = await commitGitChanges(workspace, "提交已核对的版本", confirmation);
	assert.equal(git("rev-parse", "HEAD").trim(), committed.commit);
	assert.equal(git("show", "HEAD:data/report.txt"), "暂存乙");
	assert.equal(git("show", "HEAD:outside.txt"), "初始外部");
	assert.equal(await readFile(join(sub, "report.txt"), "utf8"), "未暂存丙");
	assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "外部变动");
});

test("暂存删除与取消暂存按原文件执行，本地钩子、过滤器与签名配置不会运行", async (t) => {
	const { root, sub, workspace, git } = await fixture(t);
	await writeFile(join(sub, "removed.txt"), "待删除");
	await writeFile(join(sub, "data.txt"), "初始\n");
	await writeFile(join(root, ".gitattributes"), "data/data.txt filter=sentinel\n");
	git("add", "-A");
	git("commit", "-qm", "initial");
	await unlink(join(sub, "removed.txt"));
	await updateGitStage(workspace, "removed.txt", "stage");
	assert.ok(
		(await gitChanges(workspace)).entries.some(
			({ group, path, code }) => group === "staged" && path === "removed.txt" && code === "D",
		),
	);
	await updateGitStage(workspace, "removed.txt", "unstage");
	assert.ok(
		(await gitChanges(workspace)).entries.some(
			({ group, path, code }) => group === "working" && path === "removed.txt" && code === "D",
		),
	);
	await updateGitStage(workspace, "removed.txt", "stage");

	const hooks = join(root, ".git", "hooks");
	git("config", "core.hooksPath", hooks);
	for (const name of ["reference-transaction", "pre-commit", "post-index-change"])
		await writeFile(join(hooks, name), "#!/bin/sh\necho invoked > hook-invoked\nexit 68\n", { mode: 0o755 });
	git("config", "filter.sentinel.clean", "echo invoked > filter-invoked; cat");
	git("config", "filter.sentinel.required", "true");
	git("config", "commit.gpgSign", "true");
	git("config", "gpg.program", "invalid-flower-command");
	await writeFile(join(sub, "data.txt"), "新内容\n");
	await assert.rejects(updateGitStage(workspace, "data.txt", "stage"), /需要仓库的 Git 过滤器/);
	git("config", "filter.sentinel.required", "false");
	await updateGitStage(workspace, "data.txt", "stage");
	const preview = await gitCommitPreview(workspace);
	assert.equal(preview.total, 2);
	await commitGitChanges(workspace, "保留原始文字和删除", preview);
	assert.equal(git("show", "HEAD:data/data.txt"), "新内容\n");
	assert.equal(git("ls-tree", "--name-only", "HEAD:data").trim(), "data.txt");
	for (const name of ["hook-invoked", "filter-invoked"])
		await assert.rejects(stat(join(root, name)), { code: "ENOENT" });
});

test("无暂存内容、正在变基、游离 HEAD 与替换工作区给出回退路径", async (t) => {
	const { root, sub, workspace, git } = await fixture(t);
	await assert.rejects(gitCommitPreview(workspace), /暂存区没有/);
	await writeFile(join(sub, "report.txt"), "初始");
	git("add", "-A");
	git("commit", "-qm", "initial");
	await writeFile(join(sub, "report.txt"), "修改");
	await updateGitStage(workspace, "report.txt", "stage");
	const happened = join(root, ".git", "rebase-merge");
	await mkdir(happened);
	await assert.rejects(gitCommitPreview(workspace), /正在合并、变基/);
	await rmdir(happened);
	git("checkout", "--detach", "-q");
	await assert.rejects(gitCommitPreview(workspace), /本地分支/);
	await rename(sub, join(root, "before"));
	await mkdir(sub);
	await assert.rejects(gitCommitPreview(workspace), /工作区位置已变化/);
});

test("拒绝为另一个 Git 工作树提供访问的 .git 指针", async (t) => {
	const { root, sub, git } = await fixture(t);
	await writeFile(join(sub, "outside.txt"), "外部 Git 内容");
	git("add", "--", "data/outside.txt");
	git("config", "core.worktree", root);
	const decoy = await mkdtemp(join(tmpdir(), "flower-git-decoy-"));
	t.after(() => rm(decoy, { force: true, recursive: true }));
	await writeFile(join(decoy, ".git"), `gitdir: ${join(root, ".git")}\n`);
	const workspace = await approveWorkspace(decoy);
	await assert.rejects(gitChanges(workspace), /工作树与已授权的工作区不一致/);
	await assert.rejects(gitCommitPreview(workspace), /工作树与已授权的工作区不一致/);
	await assert.rejects(updateGitStage(workspace, "data/outside.txt", "unstage"), /工作树与已授权的工作区不一致/);
	assert.equal(git("diff", "--cached", "--name-only").trim(), "data/outside.txt");
});
