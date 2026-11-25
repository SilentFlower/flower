import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [binary, evidence, tooling, gitExecutable] = process.argv.slice(2);
assert(process.platform === "win32" && tooling, "用法：<EXE> <全新证据目录> <Playwright 目录> [Git EXE]");
const output = resolve(evidence);
await mkdir(output);
const executable = gitExecutable ? resolve(gitExecutable) : "git";
const env = { ...process.env };
if (gitExecutable) {
	const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "Path";
	env[key] = [dirname(executable), env[key]].filter(Boolean).join(";");
}
const git = (root, ...args) =>
	execFileSync(executable, ["-C", root, ...args], { env, encoding: "utf8", windowsHide: true });

async function project(name, content) {
	const root = join(output, name);
	const workspace = join(root, "资料");
	await mkdir(workspace, { recursive: true });
	git(root, "init", "-qb", "qa");
	git(root, "config", "user.name", "Flower QA");
	git(root, "config", "user.email", "flower-qa@example.invalid");
	git(root, "config", "core.hooksPath", "/dev/null");
	git(root, "config", "commit.gpgSign", "false");
	git(root, "config", "core.autocrlf", "false");
	await writeFile(join(root, "outside.txt"), "原始范围外资料");
	await writeFile(join(workspace, "seed.txt"), "起始文件");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "fixture");
	await writeFile(join(workspace, "report.md"), content);
	return { root, workspace };
}

async function until(condition, reason) {
	const deadline = Date.now() + 30_000;
	do {
		const result = await condition();
		if (result) return result;
		await delay(100);
	} while (Date.now() < deadline);
	throw new Error(`等待超时：${reason}`);
}

const { _electron: electron } = createRequire(join(resolve(tooling), "package.json"))("playwright");
const apps = [];

async function open(settings, width, profileName) {
	const profile = join(output, profileName);
	const application = await electron.launch({
		executablePath: resolve(binary),
		args: [`--user-data-dir=${profile}`, "--force-device-scale-factor=1"],
		env,
		chromiumSandbox: true,
	});
	apps.push(application);
	const win = await application.firstWindow();
	win.setDefaultTimeout(30_000);
	await application.evaluate(
		async ({ app, BrowserWindow, dialog }, { workspace, width, profile }) => {
			if (app.getPath("userData").toLowerCase() !== profile.toLowerCase()) throw new Error("试验程序未绑定独立资料目录。");
			BrowserWindow.getAllWindows()[0].setContentSize(width, 801);
			globalThis.gitQa = { answer: 1, prompts: [] };
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
			dialog.showMessageBox = async (_window, options) => {
				globalThis.gitQa.prompts.push(options);
				return { response: globalThis.gitQa.answer };
			};
		},
		{ workspace: settings.workspace, width, profile },
	);
	await win.locator("#workspace:not(:disabled)").click();
	const session = await until(() => win.evaluate(() => window.flower.state().then(({ draft }) => draft)), "目录归属");
	assert.equal(session.path.toLowerCase(), settings.workspace.toLowerCase());
	await win.locator("#workspace-panel-toggle").click();
	await win.locator("#panel-git").click();
	return { application, win, session, profile };
}

const first = await project("git-a", "# 甲的报告\n");
const second = await project("git-b", "# 乙的报告\n");
const report = "资料/report.md";
const snapshot = (root) => git(root, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean);

try {
	const a = await open(first, 1282, "profile-a");
	const stage = a.win.getByRole("button", { name: "暂存：report.md", exact: true });
	const unstage = a.win.getByRole("button", { name: "取消暂存：report.md", exact: true });
	await stage.waitFor();
	await a.win.screenshot({ path: join(output, "Git未暂存.png"), scale: "css" });
	await stage.click();
	await unstage.waitFor();
	assert.deepEqual(snapshot(first.root), [report]);
	await unstage.click();
	await stage.waitFor();
	assert.deepEqual(snapshot(first.root), []);
	await stage.click();
	await unstage.waitFor();
	await a.win.screenshot({ path: join(output, "Git已暂存.png"), scale: "css" });

	await writeFile(join(first.root, "outside.txt"), "新范围外资料");
	git(first.root, "add", "--", "outside.txt");
	const description = "核对甲工作区的报告";
	await a.win.locator(".git-commit-open").click();
	await a.win.locator("#git-commit-message").fill(description);
	const submit = a.win.getByRole("button", { name: "核对并提交", exact: true });
	await submit.click();
	await a.win.getByText("暂存区含工作区之外", { exact: false }).waitFor();
	assert.equal(await a.application.evaluate(() => globalThis.gitQa.prompts.length), 0);
	assert.equal(git(first.root, "rev-list", "--count", "HEAD").trim(), "1");
	git(first.root, "restore", "--staged", "--", "outside.txt");

	await submit.click();
	await until(() => a.application.evaluate(() => globalThis.gitQa.prompts.length === 1), "原生确认请求");
	assert.equal(git(first.root, "rev-list", "--count", "HEAD").trim(), "1");
	assert.deepEqual(snapshot(first.root), [report]);
	await a.win.screenshot({ path: join(output, "Git提交说明.png"), scale: "css" });
	await a.application.evaluate(() => {
		globalThis.gitQa.answer = 0;
	});
	await submit.click();
	await a.win.locator("#git-commit-dialog").waitFor({ state: "hidden" });
	const confirmation = await a.application.evaluate(() => globalThis.gitQa.prompts.at(-1));
	assert.match(confirmation.message, /将 1 项暂存变更提交到 qa/);
	assert.match(confirmation.detail, /report\.md\n\n核对甲工作区的报告/);
	assert.equal(git(first.root, "show", `HEAD:${report}`), "# 甲的报告\n");
	assert.equal(git(first.root, "show", "HEAD:outside.txt"), "原始范围外资料");
	assert.equal(await readFile(join(first.root, "outside.txt"), "utf8"), "新范围外资料");
	assert.deepEqual(snapshot(first.root), []);

	const b = await open(second, 660, "profile-b");
	assert.notEqual(a.application.process().pid, b.application.process().pid);
	assert.notEqual(a.profile, b.profile);
	assert((await b.win.evaluate(() => innerWidth)) <= 700);
	const blocked = await b.win.evaluate(
		(id) =>
			window.flower.gitStage(id, "report.md", "stage").then(
				() => "",
				(error) => error.message,
			),
		a.session.id,
	);
	assert.match(blocked, /当前会话/);
	await b.win.getByRole("button", { name: "暂存：report.md", exact: true }).click();
	await b.win.getByRole("button", { name: "取消暂存：report.md", exact: true }).waitFor();
	assert.deepEqual(snapshot(first.root), []);
	assert.deepEqual(snapshot(second.root), [report]);
	assert.equal(git(second.root, "rev-list", "--count", "HEAD").trim(), "1");
	assert.equal(git(second.root, "show", `:${report}`), "# 乙的报告\n");
	await b.win.screenshot({ path: join(output, "Git窄窗.png"), scale: "css" });

	await writeFile(
		join(output, "result.json"),
		JSON.stringify(
			{
				staged: true,
				unstaged: true,
				refusedOutsideScope: true,
				confirmation,
				cancelledThenCommitted: true,
				commit: git(first.root, "rev-parse", "HEAD").trim(),
				profiles: [a.profile, b.profile],
				processes: [a.application.process().pid, b.application.process().pid],
				separateProfiles: true,
				narrowWidth: await b.win.evaluate(() => innerWidth),
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	await Promise.allSettled(
		apps.map(async (application) => {
			const child = application.process();
			await Promise.race([application.close().catch(() => {}), delay(8000, undefined, { ref: false })]);
			// 只回收本脚本从隔离资料目录启动的进程。
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}),
	);
}
