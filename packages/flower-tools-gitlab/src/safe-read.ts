/**
 * `safeReadFile`:`gitlab_get_file_content` 工具的内部 wrapper
 *
 * 为什么放在 flower-tools-gitlab(而非 flower-code-reviewer):
 * - 工具层兜底 size cap + 二进制跳过更稳:LLM 永远拿不到超 50KB 的原始文件,token 不会爆
 * - 任何下游使用 `gitlab_get_file_content` 工具的产品(code-reviewer / auto-fix bot 等)
 *   自动享受相同的截断 / 跳过策略,不用各自重复实现
 * - 与 `client.ts` 解耦:client.ts 只负责 REST 通讯,保持"原始 raw"语义;
 *   `safeReadFile` 这层加业务策略(评审场景的合理读取规模)
 *
 * 行为:
 * - **二进制后缀跳过**:`.png` / `.zip` / `.lock` 等返回 HTML 注释 placeholder,不发请求
 * - **size cap**:`FLOWER_MAX_FILE_SIZE`(默认 51200 bytes = 50KB)以上截断,末尾追加 ⚠️ 注释提示
 * - **失败透传**:client 抛错(FileNotFoundError / AuthError 等)不吞,让 caller 决定怎么处理
 *
 * 注:env 变量名 `FLOWER_MAX_FILE_SIZE` 保持用户视角的命名(`FLOWER_*` 前缀),即使本文件
 * 已搬到 flower-tools-gitlab 也不改 env 名(避免业务方 CI 配置破坏)。
 */

import { extname } from "node:path";
import { gitlabClient } from "./client.js";

/**
 * 二进制 / 大体积非文本文件后缀,**直接跳过**不读
 *
 * 选择标准:LLM 看了也看不懂(图片 / 字体 / 压缩包 / 可执行文件) +
 * 大概率超 50KB 的非源码文件(`pnpm-lock.yaml` / `yarn.lock` 之类)。
 *
 * 注:`.lock` 包含 `package-lock.json` / `pnpm-lock.yaml` / `Cargo.lock` 这类
 * 体积大且对评审无价值的 lockfile;实际命中只看后缀是否以 `.lock` 结尾,
 * 这里命中规则用 `extname` 严格匹配 `.lock`(不模糊匹配 `*.lock.json` 等罕见命名)。
 */
const BINARY_EXT: ReadonlySet<string> = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".pdf",
	".zip",
	".tar",
	".gz",
	".7z",
	".ico",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".so",
	".dll",
	".exe",
	".bin",
	".lock",
]);

/**
 * 默认 size cap:50KB
 *
 * 取自 design.md §2.4。超出时只截断前 N bytes 喂给 LLM,
 * 避免单文件吃掉评审上下文窗口。
 */
const DEFAULT_MAX_FILE_SIZE = 51200;

/**
 * 读取大小上限(byte)。优先级:env `FLOWER_MAX_FILE_SIZE` > 默认 50KB。
 *
 * 解析失败(NaN / 负数)→ 退回默认值。
 */
function resolveMaxFileSize(): number {
	const raw = process.env.FLOWER_MAX_FILE_SIZE;
	if (raw === undefined) return DEFAULT_MAX_FILE_SIZE;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_FILE_SIZE;
	return parsed;
}

/**
 * `safeReadFile` 输入参数
 */
export interface SafeReadFileInput {
	/** 项目 ID(数字或 namespace/path 形式) */
	projectId: string;
	/** 仓库内相对路径 */
	path: string;
	/** ref(branch / tag / commit sha);默认 caller 传 MR source HEAD */
	ref: string;
}

/**
 * 拉取文件原始内容,带二进制跳过 + size cap
 *
 * 行为:
 * - 后缀命中 `BINARY_EXT` → 返回 `<!-- 二进制文件已跳过: ${path} -->`(不发请求,节省 token)
 * - 否则调 `gitlabClient().getFileContent(...)`,体积超 cap → 截断 + 加 ⚠️ 注释
 *
 * @param input 见 `SafeReadFileInput`
 * @returns 文件内容(可能含 HTML 注释提示)
 * @throws 透传 `FileNotFoundError` / `AuthError` / `RetryableError`(caller 决定怎么处理)
 */
export async function safeReadFile(input: SafeReadFileInput): Promise<string> {
	const ext = extname(input.path).toLowerCase();
	if (BINARY_EXT.has(ext)) {
		return `<!-- 二进制文件已跳过: ${input.path} -->`;
	}

	const content = await gitlabClient().getFileContent(input.projectId, input.path, input.ref);
	const maxSize = resolveMaxFileSize();

	if (content.length > maxSize) {
		// HTML 注释形式的截断提示:既不污染 markdown,LLM 又能看见
		return `${content.slice(0, maxSize)}\n<!-- ⚠️ 文件过大 (${content.length} bytes),仅展示前 ${maxSize} bytes -->`;
	}
	return content;
}
