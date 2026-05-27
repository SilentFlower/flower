/**
 * `safe-read.ts` 单元测试
 *
 * 覆盖:
 * - 二进制后缀跳过(.png / .lock / .pdf 等),不发请求
 * - 正常文本按行窗返回,默认 500 行
 * - 超 size cap → 截断 + 末尾追加 ⚠️ 注释
 * - 中文 UTF-8 内容不乱码
 * - env `FLOWER_MAX_FILE_SIZE` override 生效
 * - 透传 `FileNotFoundError` 等错误(不吞)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 顶层 mock:把同包 client 的 gitlabClient 替换为可控的 fake
vi.mock("../client.js", () => {
	const fakeClient = {
		getFileContent: vi.fn(),
	};
	class FileNotFoundError extends Error {
		override readonly name = "FileNotFoundError";
	}
	return {
		gitlabClient: () => fakeClient,
		FileNotFoundError,
	};
});

import { FileNotFoundError, gitlabClient } from "../client.js";
import { resolveContextReadDefaultLines, resolveContextReadMaxLines, safeReadFile } from "../safe-read.js";

// vi.mocked 拿到 vi.fn 的 mock 实例,供 mockResolvedValueOnce / mockRejectedValueOnce 使用
const mockedGetFileContent = vi.mocked(gitlabClient().getFileContent);

describe("safeReadFile · 二进制后缀跳过", () => {
	beforeEach(() => {
		mockedGetFileContent.mockReset();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it(".png 文件直接返回 placeholder,不发请求", async () => {
		const result = await safeReadFile({ projectId: "g/r", path: "assets/logo.png", ref: "main" });
		expect(result).toBe("<!-- 二进制文件已跳过: assets/logo.png -->");
		expect(mockedGetFileContent).not.toHaveBeenCalled();
	});

	it(".lock 文件直接返回 placeholder(pnpm-lock.yaml 之类大文件)", async () => {
		const result = await safeReadFile({ projectId: "g/r", path: "package-lock.json.lock", ref: "main" });
		expect(result).toBe("<!-- 二进制文件已跳过: package-lock.json.lock -->");
		expect(mockedGetFileContent).not.toHaveBeenCalled();
	});

	it(".pdf / .zip / .woff2 各跳过一遍", async () => {
		for (const path of ["docs/spec.pdf", "build/dist.zip", "fonts/main.woff2"]) {
			const result = await safeReadFile({ projectId: "g/r", path, ref: "main" });
			expect(result).toContain("二进制文件已跳过");
			expect(result).toContain(path);
		}
		expect(mockedGetFileContent).not.toHaveBeenCalled();
	});

	it("后缀大小写不敏感:`.PNG` 与 `.png` 同等处理", async () => {
		const result = await safeReadFile({ projectId: "g/r", path: "assets/LOGO.PNG", ref: "main" });
		expect(result).toBe("<!-- 二进制文件已跳过: assets/LOGO.PNG -->");
		expect(mockedGetFileContent).not.toHaveBeenCalled();
	});
});

describe("safeReadFile · 文本文件行窗", () => {
	beforeEach(() => {
		mockedGetFileContent.mockReset();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("< 500 行文本返回行窗元信息 + 全部内容", async () => {
		const code = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
		mockedGetFileContent.mockResolvedValueOnce(code);

		const result = await safeReadFile({ projectId: "g/r", path: "src/math.ts", ref: "main" });
		expect(result).toContain("<!-- 文件: src/math.ts @ main -->");
		expect(result).toContain("<!-- 行窗: 1-3 / 共 3 行 -->");
		expect(result).toContain("<!-- 续读提示:已到文件末尾 -->");
		expect(result).toContain(code.trimEnd());
		expect(mockedGetFileContent).toHaveBeenCalledWith("g/r", "src/math.ts", "main");
	});

	it("中文 UTF-8 内容透传不乱码", async () => {
		const code = "// 加法运算\nexport function 加法(甲: number, 乙: number): number {\n\treturn 甲 + 乙;\n}\n";
		mockedGetFileContent.mockResolvedValueOnce(code);

		const result = await safeReadFile({ projectId: "g/r", path: "src/中文.ts", ref: "main" });
		expect(result).toContain("加法运算");
		expect(result).toContain("加法(甲: number, 乙: number)");
	});

	it("未传行号时默认只返回前 500 行,并提示下一段续读", async () => {
		const content = Array.from({ length: 600 }, (_, i) => `line-${i + 1}`).join("\n");
		mockedGetFileContent.mockResolvedValueOnce(content);

		const result = await safeReadFile({ projectId: "g/r", path: "src/long.ts", ref: "main" });

		expect(result).toContain("<!-- 行窗: 1-500 / 共 600 行 -->");
		expect(result).toContain("line-1");
		expect(result).toContain("line-500");
		expect(result).not.toContain("line-501");
		expect(result).toContain("startLine=501, endLine=1500");
	});

	it("显式 startLine/endLine 时只返回该闭区间", async () => {
		const content = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n");
		mockedGetFileContent.mockResolvedValueOnce(content);

		const result = await safeReadFile({ projectId: "g/r", path: "src/range.ts", ref: "main", startLine: 5, endLine: 8 });

		expect(result).toContain("<!-- 行窗: 5-8 / 共 20 行 -->");
		expect(result).toContain("line-5");
		expect(result).toContain("line-8");
		expect(result).not.toContain("line-4");
		expect(result).not.toContain("line-9");
	});

	it("显式区间超过 1000 行时截断到单次最大行数并提示续读", async () => {
		const content = Array.from({ length: 1200 }, (_, i) => `line-${i + 1}`).join("\n");
		mockedGetFileContent.mockResolvedValueOnce(content);

		const result = await safeReadFile({ projectId: "g/r", path: "src/max.ts", ref: "main", startLine: 1, endLine: 1200 });

		expect(result).toContain("<!-- 行窗: 1-1000 / 共 1200 行 -->");
		expect(result).toContain("单次最多读取 1000 行");
		expect(result).toContain("line-1000");
		expect(result).not.toContain("line-1001");
		expect(result).toContain("startLine=1001");
	});

	it("env 可覆盖默认读取行数和单次最大行数", async () => {
		vi.stubEnv("FLOWER_CONTEXT_READ_DEFAULT_LINES", "3");
		vi.stubEnv("FLOWER_CONTEXT_READ_MAX_LINES", "4");
		const content = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
		mockedGetFileContent.mockResolvedValueOnce(content);

		const result = await safeReadFile({ projectId: "g/r", path: "src/env.ts", ref: "main" });

		expect(resolveContextReadDefaultLines()).toBe(3);
		expect(resolveContextReadMaxLines()).toBe(4);
		expect(result).toContain("<!-- 行窗: 1-3 / 共 10 行 -->");
		expect(result).toContain("startLine=4, endLine=7");
	});
});

describe("safeReadFile · size cap 截断", () => {
	beforeEach(() => {
		mockedGetFileContent.mockReset();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("> 50KB 时截断到前 50KB + 追加 ⚠️ 注释", async () => {
		// 60KB 内容:前 50KB 是 'a',后 10KB 是 'z',用于验证截断点
		// (用 'z' 而不是 'b' 避免与注释里的 "bytes" 误命中)
		const content = "a".repeat(51200) + "z".repeat(10240);
		mockedGetFileContent.mockResolvedValueOnce(content);

		const result = await safeReadFile({ projectId: "g/r", path: "big.ts", ref: "main" });

		// 主体应是前 51200 个 a,后面跟着注释(不含任何 'z')
		expect(result).toContain("<!-- 文件: big.ts @ main -->");
		expect(result).toContain("a".repeat(100));
		expect(result).not.toContain("z");
		expect(result).toContain("⚠️ 文件窗口过大");
		expect(result).toContain("仅展示前 51200 bytes");
	});

	it("env `FLOWER_MAX_FILE_SIZE` override 生效(设 100 bytes)", async () => {
		vi.stubEnv("FLOWER_MAX_FILE_SIZE", "100");
		const content = "x".repeat(500);
		mockedGetFileContent.mockResolvedValueOnce(content);

		const result = await safeReadFile({ projectId: "g/r", path: "tiny.ts", ref: "main" });

		expect(result).toContain("<!-- 文件: tiny.ts @ main -->");
		expect(result).toContain("仅展示前 100 bytes");
		expect(result).toMatch(/文件窗口过大 \(\d+ bytes\)/);
	});

	it("env `FLOWER_MAX_FILE_SIZE` 无效值(非数字)→ 退回默认 50KB", async () => {
		vi.stubEnv("FLOWER_MAX_FILE_SIZE", "not-a-number");
		const content = "a".repeat(51200) + "b".repeat(100);
		mockedGetFileContent.mockResolvedValueOnce(content);

		const result = await safeReadFile({ projectId: "g/r", path: "x.ts", ref: "main" });

		// 仍按默认 50KB 截断
		expect(result).toContain("<!-- 文件: x.ts @ main -->");
		expect(result).toContain("a".repeat(100));
		expect(result).toContain("仅展示前 51200 bytes");
	});
});

describe("safeReadFile · 错误透传", () => {
	beforeEach(() => {
		mockedGetFileContent.mockReset();
		vi.unstubAllEnvs();
	});

	it("FileNotFoundError 透传(不吞)", async () => {
		mockedGetFileContent.mockRejectedValueOnce(new FileNotFoundError("404"));
		await expect(safeReadFile({ projectId: "g/r", path: "nope.ts", ref: "main" })).rejects.toBeInstanceOf(
			FileNotFoundError,
		);
	});

	it("普通 Error 也透传", async () => {
		mockedGetFileContent.mockRejectedValueOnce(new Error("network down"));
		await expect(safeReadFile({ projectId: "g/r", path: "x.ts", ref: "main" })).rejects.toThrow("network down");
	});
});
