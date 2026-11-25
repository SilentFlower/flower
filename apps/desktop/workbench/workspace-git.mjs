import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { checkRoot, previewWorkspaceFile } from "./workspace.mjs";

const execute = promisify(execFile);
const limit = 400;
const labels = { M: "修改", A: "新增", D: "删除", T: "类型变化", U: "冲突", "?": "未跟踪" };
const gitStateLocks = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];

async function repository(workspace, signal) {
	const root = await checkRoot(workspace);
	const share = process.platform === "win32" && /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(.*)$/i.exec(root);
	const path = share ? share[2].replaceAll("\\", "/") || "/" : root;
	const executable = share ? join(process.env.SystemRoot, "System32", "wsl.exe") : "git";
	const prefix = share
		? [
				"--distribution",
				share[1],
				"--exec",
				"/usr/bin/env",
				"LC_ALL=C",
				"GIT_TERMINAL_PROMPT=0",
				"GIT_ALLOW_PROTOCOL=",
				"/usr/bin/git",
			]
		: [];
	const args = [
		"--no-pager",
		"--no-optional-locks",
		"--no-replace-objects",
		"--literal-pathspecs",
		"-C",
		path,
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"color.ui=false",
		"-c",
		"core.quotepath=false",
	];
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	const filterOverrides = [];
	async function run(command, { optional = false, write = false } = {}) {
		signal?.throwIfAborted();
		try {
			const overrides = command[0] === "config" ? [] : filterOverrides;
			const result = await execute(executable, [...prefix, ...args, ...overrides, ...command], {
				env: { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "" },
				signal,
				windowsHide: true,
				timeout: 12000,
				maxBuffer: 3 * 1024 * 1024,
			});
			return result.stdout;
		} catch (error) {
			signal?.throwIfAborted();
			if (error.code === "ENOENT") throw new Error("找不到 Git，请安装 Git 后刷新。");
			if (error.stderr?.includes("not a git repository")) {
				if (write) throw new Error("当前工作区的 Git 仓库已变化，请刷新后重试。");
				return null;
			}
			if (error.code === 1 && (optional || command[0] === "config") && !error.stderr) return "";
			if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("变更内容过大，请在 Git 客户端查看。");
			if (write) {
				if (/Author identity unknown|unable to auto-detect email address/.test(error.stderr ?? ""))
					throw new Error("请先为这个仓库配置 Git 提交姓名和邮箱。");
				if (command[0] === "update-ref") throw new Error("Git 分支已变化或暂时被锁定，请刷新后重试。");
				throw new Error("Git 操作失败，请刷新并检查仓库状态和写入权限。");
			}
			throw new Error("Git 读取失败，请检查该目录的 Git 安装、仓库状态和访问权限。");
		}
	}
	// 暂存也会读取仓库配置的外部过滤器。工作台操作只处理本机文件，避免隐式运行仓库脚本。
	const filters = await run([
		"config",
		"--null",
		"--name-only",
		"--get-regexp",
		"^filter\\..*\\.(clean|smudge|process|required)$",
	]);
	for (const key of new Set((filters || "").split("\0").filter(Boolean)))
		filterOverrides.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
	return {
		run,
		localPath: (output) => (share ? `\\\\wsl.localhost\\${share[1]}${output.replaceAll("/", "\\")}` : output),
	};
}

/** 列出工作区内已跟踪与未被忽略的文件，供回复中的文件名查找使用。
 * @param workspace 工作区身份 @param signal 取消读取信号 @returns 以 / 分隔的相对路径，不在 Git 仓库中时为 null
 */
export async function trackedFiles(workspace, signal) {
	const { run } = await repository(workspace, signal);
	const output = await run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
	return output === null ? null : output.split("\0").filter(Boolean);
}

/** 查看当前已授权目录中的工作区和暂存区变更。
 * @param workspace 工作区身份 @param signal 取消读取信号 @returns 分支名及按来源分开的文件
 */
export async function gitChanges(workspace, signal) {
	const repo = await repository(workspace, signal);
	const prefix = await gitScope(repo, workspace, false);
	if (prefix === undefined) return { repository: false };
	const result = await changes(repo.run, prefix);
	await checkRoot(workspace);
	return result;
}

async function changes(run, prefix) {
	const output = await run([
		"status",
		"--porcelain=v1",
		"--branch",
		"-z",
		"--no-renames",
		"--ignore-submodules=all",
		"--untracked-files=all",
		"--",
		".",
	]);
	const [header, ...records] = (output ?? "").split("\0");
	const entries = [];
	let total = 0;
	for (const line of records) {
		if (line.length < 4 || !line.slice(3).startsWith(prefix)) continue;
		const path = line.slice(3 + prefix.length);
		const conflict = /^(DD|AU|UD|UA|DU|AA|UU)/.test(line);
		for (const [code, group] of conflict
			? [["U", "working"]]
			: [
					[line[0], "staged"],
					[line[1], "working"],
				]) {
			if (code === " " || (code === "?" && group === "staged")) continue;
			if (++total <= limit) entries.push({ path, group, code, label: labels[code] ?? "变更" });
		}
	}
	return {
		repository: true,
		branch: header.replace(/^## (?:No commits yet on |Initial commit on )?/, "").split("...")[0],
		entries,
		total,
	};
}

async function gitScope(repository, workspace, required = true) {
	const { run, localPath } = repository;
	const scope = await run(["rev-parse", "--show-prefix"]);
	if (scope === null && !required) return undefined;
	const top = await run(["rev-parse", "--show-toplevel"]);
	if (scope === null || top === null) throw new Error("当前工作区没有 Git 仓库。");
	const prefix = scope.replace(/\r?\n$/, "");
	// Git 配置或 .git 指针能指定另一个工作树。Git 找到的范围必须与用户所选目录身份一致。
	const root = resolve(localPath(top.replace(/\r?\n$/, "")), prefix);
	await checkRoot(workspace);
	await checkRoot({ ...workspace, root }).catch(() => {
		throw new Error("Git 工作树与已授权的工作区不一致。");
	});
	return prefix;
}

/** 读取当前变更列表中某一文件在指定区域的差异。
 * @param workspace 工作区身份 @param path 相对文件名 @param group 暂存区或工作区 @param signal 取消信号 @returns 有界的差异文本或新文件预览
 */
export async function gitDifference(workspace, path, group, signal) {
	const state = await gitChanges(workspace, signal);
	const entry = state.entries?.find((item) => item.path === path && item.group === group);
	if (!entry) throw new Error("这项变更已更新，请返回列表刷新。");
	if (entry.code === "?") return { preview: await previewWorkspaceFile(workspace, path, signal) };
	const { run } = await repository(workspace, signal);
	const text = await run([
		"diff",
		"--relative",
		"--no-ext-diff",
		"--no-textconv",
		"--no-renames",
		"--ignore-submodules=all",
		...(group === "staged" ? ["--cached"] : []),
		"--",
		path,
	]);
	await checkRoot(workspace);
	return { text: (text || "").slice(0, 128 * 1024), truncated: text?.length > 128 * 1024 };
}

/** 暂存或取消暂存当前授权工作区中明确选中的单个文件。
 * @param workspace 工作区身份 @param path 相对文件名 @param action stage 或 unstage @param signal 会话变更取消信号
 * @returns 操作后的工作区变更
 */
export async function updateGitStage(workspace, path, action, signal) {
	if (typeof path !== "string" || !path || path.endsWith("/") || !["stage", "unstage"].includes(action))
		throw new Error("无效的 Git 文件操作。");
	const repo = await repository(workspace, signal);
	const { run } = repo;
	const prefix = await gitScope(repo, workspace);
	const status = await changes(run, prefix);
	const group = action === "stage" ? "working" : "staged";
	const entry = status.entries?.find((item) => item.path === path && item.group === group);
	if (!entry) throw new Error("这项变更已更新，请返回列表刷新。");
	if (action === "stage") {
		if (entry.code !== "D") {
			const [, , filter] = ((await run(["check-attr", "-z", "filter", "--", path])) ?? "").split("\0");
			if (filter && !["unspecified", "unset", "set"].includes(filter)) {
				const required = await run(["config", "--type=bool", "--get", `filter.${filter}.required`], { optional: true });
				// LFS 等必要过滤器负责生成仓库格式。跳过会把原始文件误写入 Git 对象。
				if (required?.trim() === "true") throw new Error("此文件需要仓库的 Git 过滤器，请在 Git 客户端暂存。");
			}
		}
		await checkRoot(workspace);
		// update-index 按文件更新。旧文件路径刚被换成目录时，不能把整个目录一起暂存。
		await run(["update-index", "--add", "--remove", "--", path], { write: true });
	} else {
		const head = await run(["rev-parse", "--verify", "--quiet", "HEAD"], { optional: true });
		const command = head
			? ["restore", "--staged", "--no-recurse-submodules", "--", path]
			: ["update-index", "--force-remove", "--", path];
		await checkRoot(workspace);
		await run(command, { write: true });
	}
	const result = await changes(run, prefix);
	await checkRoot(workspace);
	return result;
}

async function commitSnapshot(repository, workspace, signal) {
	const { run, localPath } = repository;
	const prefix = await gitScope(repository, workspace);
	const gitDirectory = (await run(["rev-parse", "--absolute-git-dir"])).replace(/\r?\n$/, "");
	const interrupted = await Promise.all(
		gitStateLocks.map((name) =>
			lstat(join(localPath(gitDirectory), name)).catch((error) => {
				if (error.code !== "ENOENT") throw new Error("无法核对当前仓库的 Git 操作状态。");
			}),
		),
	);
	signal?.throwIfAborted();
	if (interrupted.some(Boolean)) throw new Error("仓库正在合并、变基或应用提交，请先完成当前 Git 操作。");
	const ref = (await run(["symbolic-ref", "--quiet", "HEAD"], { optional: true })).trim();
	if (!ref.startsWith("refs/heads/")) throw new Error("请切换到一个本地分支后再提交。");
	const head = (await run(["rev-parse", "--verify", "--quiet", ref], { optional: true })).trim();
	const tree = (await run(["write-tree"], { write: true })).trim();
	// 比较整棵暂存树，避免当前目录的 Git 状态隐藏仓库内其他目录的暂存文件。
	const diff = head
		? [
				"diff-tree",
				"--no-commit-id",
				"--name-only",
				"--no-renames",
				"--no-relative",
				"--ignore-submodules=none",
				"-r",
				"-z",
				head,
				tree,
			]
		: ["ls-tree", "--full-tree", "--name-only", "-r", "-z", tree];
	const paths = (await run(diff)).split("\0").filter(Boolean);
	if (!paths.length) throw new Error("暂存区没有可以提交的变更。");
	if (paths.some((path) => !path.startsWith(prefix)))
		throw new Error("暂存区含工作区之外的文件。请在仓库根目录检查后提交。");
	return {
		branch: ref.slice("refs/heads/".length),
		paths: paths.slice(0, limit).map((path) => path.slice(prefix.length)),
		total: paths.length,
		head,
		tree,
		ref,
	};
}

/** 取得确认框所使用的分支与完整暂存树快照。
 * @param workspace 工作区身份 @param signal 会话变更取消信号 @returns 已校验的提交计划
 */
export async function gitCommitPreview(workspace, signal) {
	const preview = await commitSnapshot(await repository(workspace, signal), workspace, signal);
	await checkRoot(workspace);
	return preview;
}

/** 仅提交用户已确认的暂存树，用引用的旧值检测其他 Git 操作造成的并发变更。
 * @param workspace 工作区身份 @param message 用户填写的提交说明 @param expected Host 持有的已确认计划
 * @param signal 会话变更取消信号 @returns 新提交哈希和对应分支
 */
export async function commitGitChanges(workspace, message, expected, signal) {
	if (typeof message !== "string" || !message.trim() || message.length > 4000 || message.includes("\0"))
		throw new Error("请输入 1 至 4000 字的提交说明。");
	const repo = await repository(workspace, signal);
	const { run } = repo;
	const { branch, ref, head, tree } = await commitSnapshot(repo, workspace, signal);
	if (ref !== expected?.ref || head !== expected.head || tree !== expected.tree)
		throw new Error("暂存区或分支在确认期间发生变化，请刷新后重试。");
	await checkRoot(workspace);
	// 直接使用已校验的树创建对象，提交严格对应确认的内容，即使其他 Git 程序随后更新了暂存区。
	const text = message.trim();
	const commit = (
		await run(["commit-tree", tree, ...(head ? ["-p", head] : []), "--no-gpg-sign", "-m", text], { write: true })
	).trim();
	if ((await run(["symbolic-ref", "--quiet", "HEAD"], { optional: true })).trim() !== ref)
		throw new Error("当前 Git 分支已变化，请刷新后重试。");
	await checkRoot(workspace);
	await run(
		["update-ref", "-m", `commit (Flower Desktop): ${text.split("\n", 1)[0].slice(0, 160)}`, ref, commit, head],
		{
			write: true,
		},
	);
	return { commit, branch };
}
