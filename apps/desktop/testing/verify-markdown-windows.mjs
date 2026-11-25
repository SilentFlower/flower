import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const [exeArg, evidenceArg, toolingArg] = process.argv.slice(2);
assert(process.platform === "win32" && toolingArg, "用法：verify-markdown-windows.mjs <EXE> <新证据目录> <Playwright>");
const executablePath = resolve(exeArg);
const evidence = resolve(evidenceArg);
const profile = join(evidence, "profile");
const workspace = join(evidence, "Markdown 验收");
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
const docsLink = "https://example.test/flower?lang=zh&format=md";
const helpLink = "http://example.test/flower-help";
const greeting = "你好！我是 Flower 桌面 Agent。";
const fragment = `${greeting}\n\n我可以帮你做这些事：\n\n- **查看`;
const greetingEnd = [
	"工作区**：列出目录、读取文本文件",
	"- **分析 Excel**：先核对工作表与列名，再按字段分组汇总（需要时生成汇总表）",
	"- **取数与核对**：基于文件内容做统计说明，结果以工具回执为准",
	"",
	"如果你想开始，可以告诉我具体任务，比如“分析某某.xlsx 里各区域的销售额”或“看看工作区里有哪些文件”。需要我先列出工作区内容吗？",
].join("\n");
const firstPrompt = "你好啊";
const errorPrompt = "验证错误 **用户原话**\n- 仍按文本";
const errorText = "模型拒绝 **保持标记** <b>普通错误</b>";
const wideCell = "季度统计分组".repeat(42);
const wideCode = `const summary = '${"工作区小计".repeat(76)}';`;
const additions = [
	"## 格式验收",
	"- *强调*与 `notes.txt`\n  1. 嵌套的第一项\n  2. 嵌套的第二项",
	"> 引用一段中文说明",
	["```javascript", wideCode, "```"].join("\n"),
	`| 指标 | 说明 |\n| --- | --- |\n| 阅读 | ${wideCell} |`,
	`[查看文档](${docsLink}) · [查看帮助](${helpLink})`,
	'<img src="https://example.test/raw.png" alt="原生 HTML">',
	"![图片](https://example.test/image.png)",
	"[本机文件](file:///test-notes.txt)",
	"行内 <b>原生标签内容</b>",
].join("\n\n");
const tail = "\n\n以上条目可逐项检查。";
const raw = `${fragment}${greetingEnd}\n\n${additions}${tail}`;
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const gates = Array.from({ length: 3 }, deferred);
const requests = [];
const server = createServer(async (req, res) => {
	try {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			requests.push({ path: req.url });
			res.writeHead(404).end();
			return;
		}
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const content = input.messages.findLast(({ role }) => role === "user").content;
		const prompt = typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
		requests.push({ path: req.url, model: input.model, prompt });
		if (prompt.startsWith("验证错误")) {
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: errorText } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const emit = (delta, finish_reason = null) =>
			res.write(
				`data: ${JSON.stringify({
					id: "flower-markdown-qa",
					object: "chat.completion.chunk",
					created: 1790000000,
					model: input.model,
					choices: [{ index: 0, delta, finish_reason }],
				})}\n\n`,
			);
		emit({ role: "assistant", content: fragment });
		await gates[0].promise;
		emit({ content: greetingEnd });
		await gates[1].promise;
		emit({ content: `\n\n${additions}` });
		await gates[2].promise;
		emit({ content: tail });
		emit({}, "stop");
		res.end("data: [DONE]\n\n");
	} catch {
		res.destroy();
	}
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
await mkdir(evidence);
await mkdir(workspace);
let app;
let page;
const outbound = [];
const by = (id) => page.locator(`#${id}`);
const assistant = () => page.locator(".markdown-reply").first();

async function boot() {
	app = await electron.launch({
		executablePath,
		chromiumSandbox: true,
		timeout: 30_000,
		args: [`--user-data-dir=${profile}`],
	});
	page = await app.firstWindow();
	page.on("request", (request) => {
		if (/^https?:/i.test(request.url())) outbound.push(request.url());
	});
	await app.evaluate(
		({ app, clipboard, dialog, shell }, ids) => {
			if (!app.isPackaged || app.getPath("userData").toLowerCase() !== ids.profile.toLowerCase()) {
				throw new Error("候选程序或隔离资料目录不匹配");
			}
			globalThis.markdownQA = { copied: [], dialogs: 0, opened: [] };
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ids.workspace] });
			dialog.showMessageBox = async () => {
				globalThis.markdownQA.dialogs++;
				return { response: 0 };
			};
			const writeText = (value) => globalThis.markdownQA.copied.push(value);
			const openExternal = async (value) => {
				globalThis.markdownQA.opened.push(value);
			};
			clipboard.writeText = writeText;
			shell.openExternal = openExternal;
			if (clipboard.writeText !== writeText || shell.openExternal !== openExternal) {
				throw new Error("验收无法隔离剪贴板或外部浏览器");
			}
		},
		{ profile, workspace },
	);
	await page.waitForFunction(() => !document.querySelector("#model-picker-open").disabled);
	assert.equal(await page.evaluate(() => typeof window.marked?.Marked), "function");
}

async function screenshot(name) {
	await page.screenshot({ path: join(evidence, `${name}.png`) });
}

const readEvidence = () => app.evaluate(() => globalThis.markdownQA);

async function expectOpened(urls) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const { dialogs, opened } = await readEvidence();
		assert.equal(dialogs, 0, "打开网页链接无需弹窗");
		if (opened.length >= urls.length) {
			assert.deepEqual(opened, urls);
			return;
		}
		await setTimeout(25);
	}
	assert.fail("Host 未调用隔离浏览器替身");
}

async function assertFormatted() {
	const reply = assistant();
	assert.equal(await reply.locator("h2").textContent(), "格式验收");
	assert.equal(
		await reply
			.locator("li > strong")
			.allTextContents()
			.then((items) => items.join("、")),
		"查看工作区、分析 Excel、取数与核对",
	);
	assert.equal(await reply.locator("blockquote").innerText(), "引用一段中文说明");
	assert.equal(await reply.locator("li em").innerText(), "强调");
	assert.equal(await reply.locator("li code").innerText(), "notes.txt");
	assert.equal(await reply.locator("li > ol > li").count(), 2);
	assert.equal(await reply.locator("pre > code").textContent(), wideCode);
	assert.equal(await reply.locator("table tr").count(), 2);
	assert.equal(await reply.locator("table tbody td").last().textContent(), wideCell);
	assert.equal(await reply.locator("img, iframe, b, script").count(), 0);
	const rendered = await reply.textContent();
	assert(rendered.includes('<img src="https://example.test/raw.png" alt="原生 HTML">'));
	assert(rendered.includes("![图片](https://example.test/image.png)"));
	assert(rendered.includes("[本机文件](file:///test-notes.txt)"));
	assert(rendered.includes("<b>原生标签内容</b>"));
	assert.deepEqual(await reply.locator("a").allTextContents(), ["查看文档", "查看帮助"]);
	assert.deepEqual(outbound, []);
}

try {
	await boot();
	await by("theme-open").click();
	await by("service-name").fill("本地验收模型");
	await by("base-url").fill(baseUrl);
	await by("model-id").fill("markdown-local");
	await by("save-settings").click();
	await by("model-overview").waitFor();
	await by("settings-close-dialog").click();
	await by("workspace").click();
	await page.waitForFunction(() => window.flower.state().then(({ selected }) => Boolean(selected)));
	const session = (await page.evaluate(() => window.flower.state())).selected;
	await by("prompt").fill(firstPrompt);
	await by("send").click();
	const reply = assistant();
	await reply.getByText("**查看", { exact: true }).waitFor();
	assert.equal(await reply.locator("strong").count(), 0);
	await page.evaluate(() => {
		window.markdownQAStable = document.querySelector(".markdown-reply > p");
	});
	await screenshot("流式-半个标记");
	gates[0].resolve();
	await reply.locator("li > strong").first().waitFor();
	assert(await page.evaluate(() => window.markdownQAStable === document.querySelector(".markdown-reply > p")));
	assert.equal(await page.locator(".user-message-text").first().textContent(), firstPrompt);
	await screenshot("用户截图-中文粗体和列表");
	gates[1].resolve();
	await reply.locator("table").waitFor();
	const thread = by("thread-scroll");
	const overflow = await thread.evaluate((node) => {
		node.scrollTop = 0;
		return node.scrollHeight - node.clientHeight;
	});
	assert(overflow > 0);
	gates[2].resolve();
	await page.locator('.task[data-status="succeeded"]').first().waitFor();
	assert.equal(await thread.evaluate((node) => node.scrollTop), 0);
	await assertFormatted();
	await screenshot("浅色-完整 Markdown");
	assert.equal(await page.evaluate(async (id) => (await window.flower.history(id))[0].text, session), raw);

	const docs = reply.getByRole("link", { name: "查看文档" });
	const help = reply.getByRole("link", { name: "查看帮助" });
	await docs.evaluate((node) => node.click());
	assert.deepEqual((await readEvidence()).opened, []);
	await docs.click();
	await expectOpened([docsLink]);
	await help.press("Enter");
	await expectOpened([docsLink, helpLink]);
	const rejectedAddresses = ["file:///test-notes.txt", "https://user@example.test/flower", "https://"];
	for (const address of rejectedAddresses) {
		await assert.rejects(
			page.evaluate((url) => window.flower.openReplyLink(url), address),
			/无法打开/,
		);
	}
	const linkEvidence = await readEvidence();
	assert.deepEqual(linkEvidence.opened, [docsLink, helpLink]);
	await page.getByRole("button", { name: "复制回复原文", exact: true }).first().click();
	await page.getByText("已复制回复原文。", { exact: true }).waitFor();
	assert.deepEqual((await readEvidence()).copied, [raw]);

	await by("prompt").fill(errorPrompt);
	await by("send").click();
	const failed = page.locator('.task[data-status="failed"]').last();
	await failed.waitFor();
	assert.equal(await failed.locator(".user-message-text").textContent(), errorPrompt);
	const printedError = failed.locator(".message-error");
	assert.equal(await printedError.textContent(), "模型运行失败");
	assert.equal(await printedError.locator("strong, b").count(), 0);
	assert.deepEqual(
		await page.evaluate((failure) => {
			const root = document.createElement("div");
			const scroller = document.createElement("div");
			// 第一档起 thread 需要「回到底部」按钮，这里只核对失败说明，传入临时按钮即可。
			const bottom = document.createElement("button");
			window.agentUI.thread(root, scroller, {}, bottom).update([{ requestId: "验证", status: "failed", failure }]);
			const output = root.querySelector(".message-error");
			return { text: output.textContent, childElements: output.childElementCount };
		}, errorText),
		{ text: errorText, childElements: 0 },
	);

	const previousHtml = await reply.innerHTML();
	await app.close();
	app = undefined;
	await boot();
	await assistant().locator("table").waitFor();
	await assertFormatted();
	assert.equal(await assistant().innerHTML(), previousHtml);
	assert.equal(await page.locator('.task[data-status="failed"] .message-error').textContent(), "模型运行失败");
	assert.equal(await page.evaluate(async (id) => (await window.flower.history(id))[0].text, session), raw);
	await page.getByRole("button", { name: "复制回复原文", exact: true }).first().click();
	await page.getByText("已复制回复原文。", { exact: true }).waitFor();
	assert.deepEqual((await readEvidence()).copied, [raw]);

	await by("theme-open").click();
	await by("settings-appearance").click();
	await page.locator(".theme-settings").getByText("深色", { exact: true }).click();
	await page.locator(".theme-save").click();
	await page.locator("#settings-close-dialog").click();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(660, 710));
	await page.waitForFunction(() => innerWidth === 660 && innerHeight === 710);
	const scroll = await assistant().evaluate((node) => {
		const sizes = (element) => [element.clientWidth, element.scrollWidth];
		const bar = (element) => [element.classList.contains("soft-scroll"), getComputedStyle(element).scrollbarWidth];
		return {
			code: sizes(node.querySelector("pre")),
			table: sizes(node.querySelector(".markdown-table-scroll")),
			thread: sizes(document.getElementById("thread-scroll")),
			bars: [bar(node.querySelector("pre")), bar(node.querySelector(".markdown-table-scroll"))],
		};
	});
	// 代码块保持不换行并横向滚动；表格单元格随宽度换行，长文本不再撑出横向滚动。
	assert(scroll.code[1] > scroll.code[0]);
	assert(scroll.table[1] <= scroll.table[0]);
	assert(scroll.thread[1] <= scroll.thread[0]);
	assert.deepEqual(scroll.bars, [
		[true, "auto"],
		[true, "auto"],
	]);
	await by("thread-scroll").evaluate((pane) => {
		const code = pane.querySelector(".markdown-reply pre");
		pane.scrollTop += code.getBoundingClientRect().top - pane.getBoundingClientRect().top - 85;
	});
	await screenshot("深色窄窗-代码和表格");
	const images = ["流式-半个标记", "用户截图-中文粗体和列表", "浅色-完整 Markdown", "深色窄窗-代码和表格"];
	await writeFile(
		join(evidence, "evidence.json"),
		JSON.stringify(
			{
				executablePath,
				profile,
				scroll,
				requests,
				outbound,
				copiedMatchesOriginal: true,
				reopenedMatchesOriginal: true,
				links: {
					openedByMouse: linkEvidence.opened[0],
					openedByKeyboard: linkEvidence.opened[1],
					dialogs: linkEvidence.dialogs,
					rejectedAddresses,
				},
				raw,
				images,
			},
			null,
			2,
		),
	);
	console.log("Windows Markdown 验收通过。流式、历史、主题、窄窗、原文、剪贴板和可信链接交互已核对。");
} catch (error) {
	await page?.screenshot({ path: join(evidence, "failure.png"), timeout: 2000 }).catch(() => {});
	await writeFile(join(evidence, "failure-requests.json"), JSON.stringify(requests, null, 2)).catch(() => {});
	throw error;
} finally {
	for (const gate of gates) gate.resolve();
	await app?.close();
	server.closeAllConnections();
	await new Promise((resolveClose) => server.close(resolveClose));
}
