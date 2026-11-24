import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scopeKey = "@flower-ai:registry";
const publicRegistry = "https://registry.npmjs.org/";
const reviewerName = "@flower-ai/flower-code-reviewer";
const coreName = "@flower-ai/agent-runtime";
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const fixture = join(repo, "apps/code-reviewer/verification/local-review.mjs");

function npm(args, options) {
	const cli = process.env.npm_execpath;
	return exec(cli ? process.execPath : "npm", cli ? [cli, ...args] : args, { maxBuffer: 8 * 1024 * 1024, ...options });
}

function jsonOutput({ stdout }) {
	return JSON.parse(stdout);
}

async function isolatedNpm(cwd, registry) {
	await writeFile(
		join(cwd, ".npmrc"),
		[`registry=${publicRegistry}`, `${scopeKey}=${registry}`, "save-exact=true", "audit=false", "fund=false", ""].join(
			"\n",
		),
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !/^(npm_config_|npm_token$|node_auth_token$|node_options$)/i.test(name),
		),
	);
	const noProxy = [env.no_proxy ?? env.NO_PROXY, "127.0.0.1"].filter(Boolean).join(",");
	return {
		cwd,
		env: {
			...env,
			NO_PROXY: noProxy,
			no_proxy: noProxy,
			npm_config_userconfig: join(cwd, "user.npmrc"),
			npm_config_globalconfig: join(cwd, "global.npmrc"),
			npm_config_cache: join(cwd, "cache"),
		},
	};
}

async function loadWorkspaces() {
	const entries = jsonOutput(await npm(["query", ".workspace", "--json"], { cwd: repo }));
	return new Map(
		await Promise.all(
			entries.map(async ({ location }) => {
				const manifest = await readJson(join(repo, location, "package.json"));
				return [manifest.name, manifest];
			}),
		),
	);
}

function reviewerClosure(workspaces) {
	const manifests = new Map();
	const pending = [reviewerName];
	while (pending.length) {
		const name = pending.pop();
		if (manifests.has(name)) continue;
		const manifest = workspaces.get(name);
		if (!manifest) throw new Error(`缺少同批工作区包 ${name}`);
		manifests.set(name, manifest);
		const deps = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
		pending.push(...Object.keys(deps).filter((dep) => dep.startsWith("@flower-ai/")));
	}
	if (!manifests.has(coreName)) throw new Error(`Reviewer 清单缺少运行时依赖 ${coreName}`);
	return manifests;
}

async function packWorkspaces(cwd, manifests) {
	const args = ["pack", "--json", "--pack-destination", cwd];
	for (const name of manifests.keys()) args.push("--workspace", name);
	const packed = jsonOutput(await npm(args, { cwd: repo }));
	assert.equal(packed.length, manifests.size);
	return Promise.all(
		packed.map(async ({ name, version, filename, integrity, shasum }) => {
			const manifest = manifests.get(name);
			assert.equal(version, manifest?.version, name);
			return { manifest, integrity, shasum, bytes: await readFile(join(cwd, filename)) };
		}),
	);
}

function tarballPath({ name, version }) {
	return `/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
}

/**
 * 在回环地址提供给定制品的 npm 元数据和 tarball。
 * @param archives 制品清单和内容
 * @returns registry 地址、下载记录和停止方法
 */
export async function startRegistry(archives) {
	const byName = new Map(archives.map((item) => [`/${item.manifest.name}`, item]));
	const byPath = new Map(archives.map((item) => [tarballPath(item.manifest), item.bytes]));
	const downloads = new Set();
	let registry;
	const server = createServer((request, response) => {
		if (request.method !== "GET") return response.writeHead(405).end();
		const path = decodeURIComponent(new URL(request.url, registry).pathname);
		response.setHeader("Cache-Control", "no-store");
		const archive = byPath.get(path);
		if (archive) {
			downloads.add(path);
			return response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(archive);
		}
		const metadata = byName.get(path);
		if (!metadata) return response.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
		const { manifest, integrity, shasum } = metadata;
		const version = { ...manifest, dist: { tarball: new URL(tarballPath(manifest), registry).href, integrity, shasum } };
		return response.writeHead(200, { "Content-Type": "application/json" }).end(
			JSON.stringify({
				name: manifest.name,
				"dist-tags": { latest: manifest.version },
				versions: { [manifest.version]: version },
			}),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	registry = `http://127.0.0.1:${server.address().port}/`;
	return {
		registry,
		downloads,
		close() {
			return new Promise((done) => {
				server.close(done);
				server.closeAllConnections();
			});
		},
	};
}

/**
 * 用真实 npm 在仓外只安装 Reviewer，并校验核心和入口属于该消费目录。
 * @param consumer 新的仓外目录
 * @param reviewer 候选 Reviewer 清单
 * @param archives 本机 registry 提供的真实制品
 * @returns 消费目录的 bin、实际入口、核心路径和锁定制品信息
 */
export async function installReviewer(consumer, reviewer, archives) {
	await writeFile(
		join(consumer, "package.json"),
		JSON.stringify({ name: "flower-release-verification", version: "1.0.0", private: true }),
	);
	const registry = await startRegistry(archives);
	try {
		const config = await isolatedNpm(consumer, registry.registry);
		// 让 npm 根据封包声明解析依赖，缺包或版本不匹配由正常安装报错。
		await npm(["install", `${reviewer.name}@${reviewer.version}`], config);
		const lock = await readJson(join(consumer, "package-lock.json"));
		assert.deepEqual(lock.packages[""].dependencies, { [reviewer.name]: reviewer.version });
		for (const { manifest, integrity } of archives) {
			const path = tarballPath(manifest);
			const row = lock.packages[`node_modules/${manifest.name}`];
			assert.equal(row?.version, manifest.version, manifest.name);
			assert.equal(row.resolved, new URL(path, registry.registry).href);
			assert.equal(row.integrity, integrity);
			assert(registry.downloads.has(path), `未从本机 registry 下载 ${manifest.name}`);
			const installed = await readJson(join(consumer, "node_modules", manifest.name, "package.json"));
			assert.equal(installed.private, manifest.private, manifest.name);
			assert.deepEqual(installed.dependencies, manifest.dependencies, manifest.name);
		}
		const bin = join(
			consumer,
			"node_modules",
			".bin",
			process.platform === "win32" ? "flower-review.cmd" : "flower-review",
		);
		const modules = await realpath(join(consumer, "node_modules"));
		const reviewerDir = join(modules, reviewer.name);
		const cli = await realpath(join(reviewerDir, reviewer.bin["flower-review"]));
		assert(cli.startsWith(reviewerDir + sep));
		const binTarget = await realpath(bin);
		if (process.platform !== "win32") assert.equal(binTarget, cli);
		// 在实际 CLI 目录下使用 Node 的 ESM 解析，核心只有 import 导出。
		const source = `console.log(import.meta.resolve(${JSON.stringify(coreName)}))`;
		const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", source], {
			cwd: dirname(cli),
			env: { PATH: process.env.PATH },
		});
		const core = await realpath(fileURLToPath(stdout.trim()));
		assert(core.startsWith(join(modules, coreName) + sep), core);
		const { version, resolved, integrity } = lock.packages[`node_modules/${coreName}`];
		return { bin, cli, core, coreLock: { version, resolved, integrity } };
	} finally {
		await registry.close();
	}
}

function registryFlag(reviewer, env) {
	// 与当前 Changesets 的 npm info / publish registry 优先级保持一致。
	const scoped = reviewer.publishConfig?.[scopeKey] || env[`npm_config_${scopeKey}`];
	if (scoped) return `--${scopeKey}=${scoped}`;
	const registry = reviewer.publishConfig?.registry || env.npm_config_registry || publicRegistry;
	return `--registry=${/^https:\/\/registry\.yarnpkg\.com\/?$/.test(registry) ? publicRegistry : registry}`;
}

/**
 * 仅检测本次 Changesets 会发布的公开 Reviewer，并从实际 registry 匿名取得指定核心。
 * @param options 发布配置、工作区清单和临时目录
 * @returns 匿名下载的 tarball SRI。公开 Reviewer 当前版本无需发布时返回 undefined。
 */
export async function checkPublishTarget({ cwd, scratch, reviewer, core, access, env = process.env }) {
	if (reviewer.private || (reviewer.publishConfig?.access || access) !== "public") return;
	const releaseFlag = registryFlag(reviewer, env);
	const config = { cwd, env };
	const reviewerSpec = `${reviewer.name}@${reviewer.version}`;
	let result;
	try {
		result = await npm(["view", reviewerSpec, "version", "--json", "--prefer-online", releaseFlag], config);
	} catch (error) {
		let code;
		try {
			code = JSON.parse(error.stdout || error.stderr).error?.code;
		} catch {
			// 输出不是 npm 的包不存在响应。
		}
		if (code !== "E404") throw error;
	}
	if (result?.stdout.trim()) {
		assert.equal(jsonOutput(result), reviewer.version);
		return;
	}
	const scoped = (await npm(["config", "get", scopeKey, releaseFlag], config)).stdout.trim();
	const registry = scoped && scoped !== "undefined" ? scoped : releaseFlag.slice(releaseFlag.indexOf("=") + 1);
	const required = reviewer.dependencies?.[coreName];
	assert(required, `Reviewer 清单缺少 ${coreName}`);
	assert(core?.version, `缺少本地核心工作区 ${coreName}`);
	const anonymous = await isolatedNpm(scratch, registry);
	let packed;
	try {
		[packed] = jsonOutput(await npm(["pack", `${coreName}@${required}`, "--json"], anonymous));
	} catch (error) {
		const detail = core.private
			? "Changesets 会跳过私有核心，本机模拟安装不能满足分发条件。"
			: "请先确认核心已可匿名下载，再发布 Reviewer。";
		throw new Error(`公开 Reviewer 无法从目标 registry 匿名取得 ${coreName}@${required}。${detail}`, { cause: error });
	}
	assert.equal(packed?.name, coreName);
	assert.equal(packed.version, core.version, "目标 registry 核心版本与同批核心不同");
	// npm pack 以实际下载的 tarball 字节计算 SRI。
	assert(packed.integrity, "目标 registry 核心缺少 SRI");
	return packed.integrity;
}

async function main() {
	const args = process.argv.slice(2);
	const [mode, coreOutput] = args;
	assert(
		args.length === 0 ||
			(args.length === 1 && mode === "--publish-check") ||
			(args.length === 2 && mode === "--export-core" && coreOutput),
		"发布校验支持 --publish-check 或 --export-core <tarball 路径>",
	);
	const directory = await mkdtemp(join(tmpdir(), "flower-release-verify-"));
	try {
		const workspaces = await loadWorkspaces();
		const reviewer = workspaces.get(reviewerName);
		assert(reviewer, "未找到 Reviewer 工作区");
		let registryIntegrity;
		if (mode === "--publish-check") {
			const scratch = join(directory, "publish-check");
			await mkdir(scratch);
			const { access } = await readJson(join(repo, ".changeset/config.json"));
			registryIntegrity = await checkPublishTarget({
				cwd: repo,
				scratch,
				reviewer,
				core: workspaces.get(coreName),
				access,
			});
			if (registryIntegrity === undefined) {
				console.log("本轮没有待发布的公开 Reviewer，跳过其发布检查");
				return;
			}
		}
		const tarballs = join(directory, "tarballs");
		const consumer = join(directory, "consumer");
		await Promise.all([mkdir(tarballs), mkdir(consumer)]);
		const archives = await packWorkspaces(tarballs, reviewerClosure(workspaces));
		const coreArchive = archives.find(({ manifest }) => manifest.name === coreName);
		assert(coreArchive, `缺少 ${coreName} 的试装制品`);
		if (registryIntegrity !== undefined) {
			const localIntegrity = coreArchive.integrity;
			assert.equal(
				registryIntegrity,
				localIntegrity,
				`目标 registry 核心 SRI 与本次试装制品不同（目标 ${registryIntegrity}，本地 ${localIntegrity}）`,
			);
			console.log(`目标 registry 核心 SRI 与本次试装制品一致 ${registryIntegrity}`);
		}
		const installed = await installReviewer(consumer, reviewer, archives);
		const command = process.platform === "win32" ? [process.execPath, installed.cli] : [installed.bin];
		console.log(JSON.stringify({ directDependency: `${reviewer.name}@${reviewer.version}`, ...installed }));
		const { stdout } = await exec(process.execPath, [fixture, "normal"], {
			cwd: repo,
			env: { PATH: process.env.PATH, FLOWER_VERIFY_COMMAND: JSON.stringify(command) },
			maxBuffer: 8 * 1024 * 1024,
		});
		console.log(stdout.trim());
		if (coreOutput) {
			// 只保存通过仓外评审的原始 tarball，发布时无需重新打包。
			await writeFile(coreOutput, coreArchive.bytes, { flag: "wx" });
			console.log(`已保存通过试装的核心制品 ${resolve(coreOutput)}`);
		}
		console.log(`同批制品试装通过 ${reviewer.name}@${reviewer.version}`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error.message);
		if (error.stderr) console.error(error.stderr.trim());
		process.exitCode = 1;
	});
}
