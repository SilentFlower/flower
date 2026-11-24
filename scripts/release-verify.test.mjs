import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkPublishTarget, installReviewer, startRegistry } from "./release-verify.mjs";

const exec = promisify(execFile);
const core = { name: "@flower-ai/agent-runtime", version: "3.2.1", private: true };
const reviewer = {
	name: "@flower-ai/flower-code-reviewer",
	version: "1.2.3",
	dependencies: { [core.name]: core.version },
};

async function packFixture(root, manifest, readme) {
	const dir = await mkdtemp(join(root, "source-"));
	await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
	if (readme) await writeFile(join(dir, "README.md"), readme);
	const { stdout } = await exec("npm", ["pack", "--json"], { cwd: dir });
	const [{ filename, integrity, shasum }] = JSON.parse(stdout);
	return { manifest, integrity, shasum, bytes: await readFile(join(dir, filename)) };
}

test("真实 npm 试装与公开发布检查", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-release-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const [reviewerArchive, coreArchive, wrongCoreArchive, changedCoreArchive] = await Promise.all([
		packFixture(root, reviewer),
		packFixture(root, core),
		packFixture(root, { ...core, version: "3.2.0" }),
		packFixture(root, core, "不同内容的同版本核心\n"),
	]);
	// 使用与实际发布进程相同的 scoped registry 配置。所有网络请求留在回环地址。
	async function publishCheck(scenario, archives, overrides = {}) {
		const { registry, downloads, close } = await startRegistry(archives);
		scenario.after(close);
		const cwd = await mkdtemp(join(root, "release-"));
		const scratch = join(cwd, "scratch");
		await mkdir(scratch);
		await writeFile(join(cwd, "package.json"), '{"name":"release-fixture","version":"1.0.0","private":true}');
		await writeFile(join(cwd, ".npmrc"), `@flower-ai:registry=${registry}\n`);
		const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)));
		return {
			cwd,
			env,
			downloads,
			check: () => checkPublishTarget({ cwd, scratch, reviewer, core, access: "public", env, ...overrides }),
		};
	}

	for (const [name, archives, code] of [
		["仅缺核心", [reviewerArchive], "E404"],
		["核心版本不符", [reviewerArchive, wrongCoreArchive], "ETARGET"],
	]) {
		await t.test(`单装 Reviewer ${name}时 npm 失败`, async () => {
			const consumer = await mkdtemp(join(root, "consumer-"));
			await assert.rejects(installReviewer(consumer, reviewer, archives), ({ stderr }) => {
				assert.match(stderr, new RegExp(code));
				assert(stderr.includes(`${core.name}@${core.version}`));
				return true;
			});
		});
	}

	await t.test("公开 Reviewer 在目标 registry 缺指定核心时阻止发布", async (scenario) => {
		const { check } = await publishCheck(scenario, []);
		await assert.rejects(check(), /公开 Reviewer 无法从目标 registry 匿名取得 @flower-ai\/agent-runtime@3\.2\.1/);
	});

	await t.test("目标 registry 只有错误核心版本时阻止发布", async (scenario) => {
		const { check } = await publishCheck(scenario, [wrongCoreArchive]);
		await assert.rejects(check(), /公开 Reviewer 无法从目标 registry 匿名取得 @flower-ai\/agent-runtime@3\.2\.1/);
	});

	await t.test("公开 Reviewer 可继续验证同批制品前须匿名下载核心 tarball", async (scenario) => {
		const { check, downloads } = await publishCheck(scenario, [coreArchive]);
		assert.equal(await check(), coreArchive.integrity);
		assert.deepEqual([...downloads], ["/@flower-ai/agent-runtime/-/agent-runtime-3.2.1.tgz"]);
	});

	await t.test("公开核心首次发布须先于 Reviewer 可匿名下载", async (scenario) => {
		const publicCore = { ...core, private: false };
		const { check } = await publishCheck(scenario, [], { core: publicCore });
		await assert.rejects(check(), /请先确认核心已可匿名下载，再发布 Reviewer/);
	});

	await t.test("Reviewer 当前版本已发布时不要求核心，独立包可继续", async (scenario) => {
		const { check, downloads } = await publishCheck(scenario, [reviewerArchive], { core: undefined });
		assert.equal(await check(), undefined);
		assert.equal(downloads.size, 0);
	});

	await t.test("私有或 restricted Reviewer 不触发公开发布检查", async () => {
		assert.equal(await checkPublishTarget({ reviewer: { ...reviewer, private: true }, access: "public" }), undefined);
		assert.equal(await checkPublishTarget({ reviewer, access: "restricted" }), undefined);
	});

	for (const [name, archives, errorMessage] of [
		["缺核心", [], /公开 Reviewer 无法从目标 registry 匿名取得/],
		["核心同版本且内容不同", [changedCoreArchive], /目标 registry 核心 SRI 与本次试装制品不同/],
	]) {
		await t.test(`根 release 遇到${name}时停止在发布前`, async (scenario) => {
			const { cwd, env, downloads } = await publishCheck(scenario, archives);
			const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
			assert.match(scripts.release, / && changeset publish$/);
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({
					name: "release-fixture",
					version: "1.0.0",
					private: true,
					workspaces: ["packages/*"],
					scripts: { build: "node --version", release: scripts.release.replace(/changeset publish$/, "node sentinel.cjs") },
				}),
			);
			await mkdir(join(cwd, "scripts"));
			await copyFile(new URL("./release-verify.mjs", import.meta.url), join(cwd, "scripts", "release-verify.mjs"));
			await mkdir(join(cwd, ".changeset"));
			await writeFile(join(cwd, ".changeset", "config.json"), '{"access":"public"}');
			await writeFile(join(cwd, "sentinel.cjs"), 'require("node:fs").writeFileSync("last-step", "reached");');
			for (const manifest of [reviewer, core]) {
				const dir = join(cwd, "packages", manifest.name.split("/")[1]);
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
			}
			await exec("npm", ["install", "--workspaces", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
				cwd,
				env,
			});
			await assert.rejects(exec("npm", ["run", "release"], { cwd, env }), ({ stderr }) => {
				assert.match(stderr, errorMessage);
				return true;
			});
			assert.equal(downloads.size, archives.length);
			await assert.rejects(readFile(join(cwd, "last-step")), { code: "ENOENT" });
		});
	}
});
