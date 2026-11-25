import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchDesktop } from "./desktop-harness.mjs";

const git = (path, ...args) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", windowsHide: true });

test("工作台 Git 入口只操作选中会话，原生确认展示准确的暂存内容并可取消", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-git-host-"));
	const first = join(root, "first");
	const second = join(root, "second");
	await mkdir(first);
	await mkdir(second);
	for (const folder of [first, second]) {
		git(folder, "init", "-qb", "qa");
		git(folder, "config", "user.name", "Flower QA");
		git(folder, "config", "user.email", "flower-qa@example.invalid");
		await writeFile(join(folder, "report.txt"), folder === first ? "甲资料" : "乙资料");
	}
	const desktop = await launchDesktop(root);
	t.after(async () => {
		await desktop.close();
		await rm(root, { force: true, recursive: true });
	});
	const { api } = desktop;
	await desktop.state(({ ready }) => ready);
	desktop.choose(first);
	const firstId = await api.chooseWorkspace();
	assert.ok((await api.gitStage(firstId, "report.txt", "stage")).entries.some(({ group }) => group === "staged"));
	desktop.choose(second);
	const secondId = await api.chooseWorkspace();
	assert.notEqual(firstId, secondId);
	await assert.rejects(api.gitStage(firstId, "report.txt", "unstage"), /当前会话/);
	await assert.rejects(api.gitCommit(firstId, "跨会话提交"), /当前会话/);
	assert.equal(git(second, "ls-files", "--cached"), "");

	await api.selectSession(firstId);
	const message = "核对并提交甲资料";
	desktop.confirm(1);
	assert.equal(await api.gitCommit(firstId, message), undefined);
	assert.equal(git(first, "ls-files", "--cached").trim(), "report.txt");
	assert.equal(git(first, "rev-list", "--all").trim(), "");
	assert.match(desktop.prompts.at(-1).message, /1 项暂存变更提交到 qa/);
	assert.match(desktop.prompts.at(-1).detail, /report\.txt\n\n核对并提交甲资料/);

	desktop.confirm(0);
	const committed = await api.gitCommit(firstId, message);
	assert.equal(committed.branch, "qa");
	assert.equal(committed.commit, git(first, "rev-parse", "HEAD").trim());
	assert.equal(git(first, "show", "HEAD:report.txt"), "甲资料");
	assert.equal(await readFile(join(second, "report.txt"), "utf8"), "乙资料");
	assert.equal(git(second, "rev-list", "--all").trim(), "");
});
