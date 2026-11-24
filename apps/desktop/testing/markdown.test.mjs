import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as marked from "marked";

const source = readFileSync(new URL("../workbench/ui/markdown.js", import.meta.url), "utf8");

function render(markdown) {
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
	window.flowerMarkdown.view(root, () => assert.fail("渲染不得打开链接")).update(markdown);
	return html;
}

test("渲染中文强调、嵌套列表、引用、代码和 GFM 表格", () => {
	const text =
		"# 你好\n\n- **查看工作区**：列出目录\n  - *只读*\n\n> 使用 `notes.txt`\n\n```text\n<代码>&\n```\n\n| 列 | 值 |\n| - | - |\n| 资产 | 1 |";
	const html = render(text);
	assert.match(html, /<h1>你好<\/h1>/);
	assert.match(html, /<ul>\s*<li><strong>查看工作区<\/strong>：列出目录\s*<ul>\s*<li><em>只读<\/em>/);
	assert.match(html, /<blockquote>\s*<p>使用 <code>notes\.txt<\/code>/);
	assert.match(html, /<pre[^>]*><code>&lt;代码&gt;&amp;<\/code><\/pre>/);
	assert.match(html, /<div class="markdown-table-scroll"[^>]*><table>/);
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
