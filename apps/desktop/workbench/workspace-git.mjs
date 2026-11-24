import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkRoot, previewWorkspaceFile } from "./workspace.mjs";

const execute = promisify(execFile);
const limit = 400;
const labels = { M: "修改", A: "新增", D: "删除", T: "类型变化", U: "冲突", "?": "未跟踪" };

async function repository(workspace, signal) {
	const root = await checkRoot(workspace);
	const share = process.platform === "win32" && /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(.*)$/i.exec(root);
	const path = share ? share[2].replaceAll("\\", "/") || "/" : root;
	const executable = share ? join(process.env.SystemRoot, "System32", "wsl.exe") : "git";
	const prefix = share ? ["--distribution", share[1], "--exec", "/usr/bin/env", "LC_ALL=C", "/usr/bin/git"] : [];
	const args = [
		"--no-pager",
		"--no-optional-locks",
		"--literal-pathspecs",
		"-C",
		path,
		"-c",
		"core.fsmonitor=false",
		"-c",
		"color.ui=false",
		"-c",
		"core.quotepath=false",
	];
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	async function run(command) {
		try {
			const result = await execute(executable, [...prefix, ...args, ...command], {
				env: { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
				signal,
				windowsHide: true,
				timeout: 12000,
				maxBuffer: 3 * 1024 * 1024,
			});
			return result.stdout;
		} catch (error) {
			signal?.throwIfAborted();
			if (error.code === "ENOENT") throw new Error("找不到 Git，请安装 Git 后刷新。");
			if (error.stderr?.includes("not a git repository")) return null;
			if (error.code === 1 && command[0] === "config" && !error.stderr) return "";
			if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("变更内容过大，请在 Git 客户端查看。");
			throw new Error("Git 读取失败，请检查该目录的 Git 安装、仓库状态和访问权限。");
		}
	}
	// 状态与差异也可能调用仓库配置的外部过滤器。预览仅比较本机文件内容。
	const filters = await run([
		"config",
		"--name-only",
		"--get-regexp",
		"^filter\\..*\\.(clean|smudge|process|required)$",
	]);
	for (const key of new Set((filters || "").trim().split("\n").filter(Boolean)))
		args.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
	return run;
}

/** 列出工作区内已跟踪与未被忽略的文件，供回复中的文件名查找使用。
 * @param workspace 工作区身份 @param signal 取消读取信号 @returns 以 / 分隔的相对路径，不在 Git 仓库中时为 null
 */
export async function trackedFiles(workspace, signal) {
	const run = await repository(workspace, signal);
	const output = await run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
	return output === null ? null : output.split("\0").filter(Boolean);
}

/** 查看当前已授权目录中的工作区和暂存区变更。
 * @param workspace 工作区身份 @param signal 取消读取信号 @returns 分支名及按来源分开的文件
 */
export async function gitChanges(workspace, signal) {
	const run = await repository(workspace, signal);
	const prefix = await run(["rev-parse", "--show-prefix"]);
	if (prefix === null) return { repository: false };
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
	const base = prefix.replace(/\r?\n$/, "");
	let total = 0;
	for (const line of records) {
		if (line.length < 4 || !line.slice(3).startsWith(base)) continue;
		const path = line.slice(3 + base.length);
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
	await checkRoot(workspace);
	return {
		repository: true,
		branch: header.replace(/^## (?:No commits yet on |Initial commit on )?/, "").split("...")[0],
		entries,
		total,
	};
}

/** 读取当前变更列表中某一文件在指定区域的差异。
 * @param workspace 工作区身份 @param path 相对文件名 @param group 暂存区或工作区 @param signal 取消信号 @returns 有界的差异文本或新文件预览
 */
export async function gitDifference(workspace, path, group, signal) {
	const state = await gitChanges(workspace, signal);
	const entry = state.entries?.find((item) => item.path === path && item.group === group);
	if (!entry) throw new Error("这项变更已更新，请返回列表刷新。");
	if (entry.code === "?") return { preview: await previewWorkspaceFile(workspace, path, signal) };
	const run = await repository(workspace, signal);
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
