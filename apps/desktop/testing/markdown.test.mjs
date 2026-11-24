import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as marked from "marked";

const source = readFileSync(new URL("../workbench/ui/markdown.js", import.meta.url), "utf8");

function render(markdown, workspace, check) {
	const window = { marked };
	let html;
	const document = {
		createElement() {
			return {
				set innerHTML(value) {
					html = value;
				},
				content: { childNodes: [] },
			};
		},
	};
	runInNewContext(source, { window, document, URL });
	const root = { addEventListener() {} };
	const paths = workspace && {
		resolve: (text) => window.flowerMarkdown.workspacePath(workspace, text),
		check,
		hydrate(_root, refresh) {
			assert.equal(typeof refresh, "function");
		},
	};
	window.flowerMarkdown.view(root, () => assert.fail("渲染不得打开链接"), paths).update(markdown);
	return html;
}

function workspacePath(root, text) {
	const window = { marked };
	runInNewContext(source, { window, document: { createElement() {} }, URL });
	return window.flowerMarkdown.workspacePath(root, text);
}

test("渲染中文强调、嵌套列表、引用、代码和 GFM 表格", () => {
	const text =
		"# 你好\n\n- **查看工作区**：列出目录\n  - *只读*\n\n> 使用 `notes.txt`\n\n```text\n<代码>&\n```\n\n| 列 | 值 |\n| - | - |\n| 资产 | 1 |";
	const html = render(text);
	assert.match(html, /<h1>你好<\/h1>/);
	assert.match(html, /<ul>\s*<li><strong>查看工作区<\/strong>：列出目录\s*<ul>\s*<li><em>只读<\/em>/);
	assert.match(html, /<blockquote>\s*<p>使用 <code>notes\.txt<\/code>/);
	assert.match(html, /<pre class="soft-scroll"[^>]*><code>&lt;代码&gt;&amp;<\/code><\/pre>/);
	assert.match(html, /<div class="markdown-table-scroll soft-scroll"[^>]*><table>/);
	assert.match(render("首段\n\n等待 **半个"), /<p>等待 \*\*半个<\/p>/);
	assert.match(render("首段\n\n等待 **半个**"), /<strong>半个<\/strong>/);
});

test("HTML、图片和非网页地址以字面显示，网页地址只能通过应用交互", () => {
	const html = render(
		[
			'<img src="https://example.test/raw.png">',
			'行内 <b class="标记">文本</b> ![封面](https://example.test/cover.png)',
			"[本机](file:///notes.txt) [账号](https://user@example.test/path)",
			"[文档](https://example.test/docs?x=1&y=2)",
		].join("\n\n"),
	);
	assert.doesNotMatch(html, /<(?:img|b)\b|href="(?:file|https?):/);
	assert.match(html, /&lt;img src=&quot;https:\/\/example\.test\/raw\.png&quot;&gt;/);
	assert.match(html, /!\[封面\]\(https:\/\/example\.test\/cover\.png\)/);
	assert.match(html, /\[本机\]\(file:\/\/\/notes.txt\)/);
	assert.match(html, /href="#" data-markdown-url="https:\/\/example\.test\/docs\?x=1&amp;y=2"/);
});

test("回复中的路径只解析为当前工作区内常见文件", () => {
	const windows = "C:\\Users\\demo\\财务资料";
	assert.equal(workspacePath(windows, "资料\\报价.pdf"), "资料/报价.pdf");
	assert.equal(workspacePath(windows, "./报表/汇总.xlsx"), "报表/汇总.xlsx");
	assert.equal(workspacePath(windows, "C:\\Users\\demo\\财务资料\\报表\\汇总.xlsx"), "报表/汇总.xlsx");
	assert.equal(workspacePath(windows, "c:/users/demo/财务资料/核对报告.md"), "核对报告.md");
	assert.equal(workspacePath(windows, "`预算.xlsx`"), "预算.xlsx");
	for (const outside of [
		"C:\\Users\\demo\\其他\\a.md",
		"C:\\Users\\demo\\财务资料2\\a.md",
		"../a.md",
		"资料/../a.md",
		"https://example.test/a.md",
		"file:///C:/a.md",
		"example.com",
		"v1.2",
		"npm test",
		"资料/",
	])
		assert.equal(workspacePath(windows, outside), undefined, outside);
	assert.equal(workspacePath("/home/demo/ws", "/home/demo/ws/x/y.csv"), "x/y.csv");
	assert.equal(workspacePath("/home/demo/ws", "/home/demo/WS/y.csv"), undefined);
	assert.equal(workspacePath(undefined, "a.md"), undefined);
});

test("工作区路径渲染为可激活的链接、行内代码与图片，越界路径保持原文", () => {
	const html = render(
		[
			"[分析报告](Flower-分析-1/分析报告.md) 与 `预算.xlsx`、`npm test`",
			"![趋势](图表/趋势.png) ![外部](../趋势.png) [越界](../a.md)",
			"[文档](https://example.test/docs)",
		].join("\n\n"),
		"/home/demo/ws",
	);
	assert.match(
		html,
		/<a href="#" data-workspace-path="Flower-分析-1\/分析报告.md" title="Flower-分析-1\/分析报告.md">分析报告<\/a>/,
	);
	assert.match(
		html,
		/<code class="path-ref" data-workspace-path="预算.xlsx"[^>]*role="link" tabindex="0">预算\.xlsx<\/code>/,
	);
	assert.match(html, /<code>npm test<\/code>/);
	assert.match(html, /<img class="markdown-image" data-workspace-image="图表\/趋势.png"[^>]*alt="趋势"/);
	assert.match(html, /!\[外部\]\(\.\.\/趋势\.png\)/);
	assert.match(html, /\[越界\]\(\.\.\/a\.md\)/);
	assert.match(html, /data-markdown-url="https:\/\/example\.test\/docs"/);
	// 未提供路径交互时（工作区面板预览）保持原有行为。
	assert.doesNotMatch(render("`预算.xlsx` [a](a.md)"), /data-workspace-path/);
});

test("宿主核对前路径与普通代码一致，核对后按存在、同名候选与缺失渲染", () => {
	const states = {
		"甲.md": { state: "pending", path: "甲.md" },
		"乙.md": { state: "file", path: "文档/乙.md" },
		"丙.md": { state: "choices", path: "丙.md", candidates: ["a/丙.md", "b/丙.md"] },
		"丁.md": { state: "missing" },
	};
	const html = render(
		"`甲.md` `乙.md` `丙.md` `丁.md`\n\n[甲](甲.md) [丙](丙.md) [丁](丁.md)",
		"/home/demo/ws",
		(path) => states[path],
	);
	assert.match(html, /<code data-path-pending="甲.md">甲\.md<\/code>/);
	assert.match(
		html,
		/<code class="path-ref" data-workspace-path="文档\/乙.md" title="文档\/乙.md" role="link" tabindex="0">乙\.md<\/code>/,
	);
	assert.match(html, /<code class="path-ref" data-workspace-path="丙.md" title="工作区中有 2 个同名文件"/);
	assert.match(html, /<code>丁\.md<\/code>/);
	assert.match(html, /<span data-path-pending="甲.md">甲<\/span>/);
	assert.match(html, /<a href="#" data-workspace-path="丙.md" title="工作区中有 2 个同名文件">丙<\/a>/);
	// 缺失的文件只保留链接文字，不显示 Markdown 原文。
	assert.match(html, /<\/a> 丁<\/p>/);
	assert.doesNotMatch(html, /\(丁\.md\)/);
});
