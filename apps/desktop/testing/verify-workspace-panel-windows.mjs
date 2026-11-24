import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [binary, output, tooling, sampleBook] = process.argv.slice(2);
assert(
	process.platform === "win32" && sampleBook,
	"用法：verify-workspace-panel-windows.mjs <EXE> <新证据目录> <Playwright> <测试工作簿>",
);
const evidence = resolve(output);
const profile = join(evidence, "profile");
const workspace = join(evidence, "项目资料");
const alternate = join(evidence, "设计记录");
const require = createRequire(join(resolve(tooling), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
await mkdir(join(workspace, "周报"), { recursive: true });
await mkdir(join(workspace, "归档"));
await mkdir(alternate);
await writeFile(join(workspace, "项目说明.txt"), "本周项目资料");
await writeFile(join(workspace, "归档", "完整记录.md"), "资料".repeat(15000));
await writeFile(join(workspace, "预算.zip"), "占位文件");
await copyFile(resolve(sampleBook), join(workspace, "订单数据.xlsx"));
await writeFile(join(workspace, "费用.csv"), '部门,预算\r\n"产品,设计",200\r\n');
await writeFile(join(workspace, "超长首行.csv"), `"${"花".repeat(30000)}",100\n`);
await writeFile(join(workspace, "进度.tsv"), "项目\t状态\n工作台\t已验收");
await writeFile(join(workspace, "样式.css"), ".report { color: teal; }");
await writeFile(join(workspace, "示例.html"), "<h1>仅预览源文件</h1>");
await writeFile(
	join(workspace, "封面.png"),
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC", "base64"),
);
const word = join(evidence, "docx-source");
await mkdir(join(word, "word"), { recursive: true });
await writeFile(
	join(word, "word/document.xml"),
	'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>项目交付说明</w:t></w:r></w:p><w:p><w:r><w:t>第一阶段已完成验收。</w:t></w:r></w:p></w:body></w:document>',
);
execFileSync("tar.exe", ["-a", "-cf", join(evidence, "word.zip"), "-C", word, "word/document.xml"]);
await rename(join(evidence, "word.zip"), join(workspace, "交付说明.docx"));
await writeFile(join(alternate, "访谈记录.txt"), "第二个工作区");
const report =
	"# 项目周报\n\n本周完成了 **客户访谈** 和首轮交付验收。\n\n## 本周进展\n\n- 完成三次客户访谈\n- 核对两份交付清单\n\n| 项目 | 状态 |\n| --- | --- |\n| 需求确认 | 已完成 |\n| 第二轮验收 | 进行中 |";
await writeFile(join(workspace, "周报", "项目周报.md"), report);
for (let i = 0; i < 166; i++) await writeFile(join(workspace, "归档", `记录-${i}.txt`), String(i));
const app = await electron.launch({
	executablePath: resolve(binary),
	args: [`--user-data-dir=${profile}`],
	chromiumSandbox: true,
});
try {
	const page = await app.firstWindow();
	page.setDefaultTimeout(8000);
	const by = (id) => page.locator(`#${id}`);
	const row = (label) => page.getByRole("button", { name: label, exact: true });
	const pdf = await app.evaluate(async ({ BrowserWindow }) => {
		const sample = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
		try {
			const markup =
				'<meta charset="utf-8"><style>@page{size:A5;margin:15mm}body{font:16px "Microsoft YaHei";color:#242d32}section{break-after:page}section:last-child{break-after:auto}h1{font-size:32px}hr{border:0;height:5px;background:#476a58}td{padding:8px 40px 8px 0}</style><section><hr><h1>项目进展报告</h1><p>第一阶段 · 交付验收</p><table><tr><td>客户访谈</td><td>已完成</td></tr><tr><td>第二轮验收</td><td>进行中</td></tr></table></section><section><hr><h1>后续安排</h1><p>下周整理反馈并复核交付清单。</p></section>';
			await sample.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`);
			return (await sample.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true })).toString("base64");
		} finally {
			sample.destroy();
		}
	});
	await writeFile(join(workspace, "项目进展.pdf"), Buffer.from(pdf, "base64"));
	await app.evaluate(
		({ app, BrowserWindow, dialog }, fixture) => {
			if (app.getPath("userData").toLowerCase() !== fixture.profile.toLowerCase()) throw new Error("资料目录不符");
			BrowserWindow.getAllWindows()[0].setContentSize(1282, 800);
			globalThis.panelFixture = fixture.workspace;
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.panelFixture] });
		},
		{ profile, workspace },
	);
	await page.locator("#workspace:not(:disabled)").waitFor();
	async function checkToggle() {
		// 开关位于标题栏内、窗口按钮左侧，且能接收点击。
		const position = await by("workspace-panel-toggle").evaluate((node) => {
			const rect = node.getBoundingClientRect();
			const chrome = document.querySelector(".desktop-chrome").getBoundingClientRect();
			return {
				inside: rect.top >= chrome.top && rect.bottom <= chrome.bottom,
				hit: node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
			};
		});
		assert(position.inside && position.hit, JSON.stringify(position));
	}
	await checkToggle();
	await by("workspace-panel-toggle").click();
	await by("panel-content").getByRole("button", { name: "选择工作区" }).click();
	await row("进入目录：周报").waitFor();
	await checkToggle();
	assert.equal(await by("workspace-panel-toggle").getAttribute("aria-expanded"), "true");
	const first = await page.evaluate(async () => (await window.flower.state()).selected);
	await by("prompt").fill("整理本周项目进展");
	await page.mouse.move(20, 300);
	await page.screenshot({ scale: "css", path: join(evidence, "工作区文件.png") });
	await row("进入目录：归档").click();
	await page.waitForFunction(() => document.querySelectorAll(".panel-file-row").length === 160);
	await row("显示更多").click();
	await page.waitForFunction(() => document.querySelectorAll(".panel-file-row").length === 167);
	await row("预览文件：完整记录.md").click();
	await by("panel-status").getByText("仅预览文件开头的 64 KiB。").waitFor();
	assert(!(await by("panel-content").textContent()).includes("�"));
	await by("panel-up").click();
	await by("panel-up").click();
	await row("预览文件：项目说明.txt").click();
	await by("panel-content").getByText("本周项目资料", { exact: true }).waitFor();
	await by("panel-up").click();
	await row("预览文件：预算.zip").click();
	await by("panel-status").getByText("此格式暂不支持预览。").waitFor();
	await by("panel-up").click();
	await row("预览文件：订单数据.xlsx").click();
	await page.locator("#panel-content .panel-sheet table").first().waitFor();
	await by("panel-up").click();
	for (const [name, selector, expected] of [
		["费用.csv", "td", "产品,设计"],
		["进度.tsv", "td", "已验收"],
		["样式.css", "pre", ".report { color: teal; }"],
		["示例.html", "pre", "<h1>仅预览源文件</h1>"],
		["交付说明.docx", "p", "第一阶段已完成验收。"],
	]) {
		await row(`预览文件：${name}`).click();
		await by("panel-content").locator(selector).filter({ hasText: expected }).waitFor();
		await by("panel-up").click();
	}
	await row("预览文件：封面.png").click();
	await page.waitForFunction(() => document.querySelector(".panel-image")?.naturalWidth === 1);
	await by("panel-up").click();
	await row("预览文件：超长首行.csv").click();
	await by("panel-status").getByText("前 64 KiB 中没有完整的记录可预览。").waitFor();
	await by("panel-up").click();
	await row("预览文件：项目进展.pdf").click();
	const firstPage = page.getByRole("img", { name: "PDF 第 1 页" });
	await firstPage.waitFor({ timeout: 20000 });
	const pdfWorker = () => page.workers().find((worker) => worker.url().endsWith("/pdf.worker.mjs"));
	assert(pdfWorker(), "PDF 必须在独立的本地解析线程中打开");
	async function pixels(canvas) {
		return canvas.evaluate((node) => {
			const data = node.getContext("2d").getImageData(0, 0, node.width, node.height).data;
			let dark = 0;
			for (let index = 0; index < data.length; index += 4) if (data[index] < 140 && data[index + 3] === 255) dark++;
			return dark;
		});
	}
	const firstInk = await pixels(firstPage);
	assert(firstInk > 50);
	await row("下一页").click();
	const secondInk = await pixels(page.getByRole("img", { name: "PDF 第 2 页" }));
	assert(secondInk > 50 && secondInk !== firstInk);
	assert(await row("下一页").isDisabled());
	await row("上一页").click();
	await firstPage.waitFor();
	await by("workspace-panel-expand").click();
	await page.waitForFunction(() => {
		const panel = document.querySelector("#workspace-panel");
		return (
			panel.getBoundingClientRect().width > 950 &&
			panel.querySelector("canvas")?.width >= panel.querySelector(".panel-pdf-page").clientWidth
		);
	});
	await page.mouse.move(20, 300);
	await page.screenshot({ scale: "css", path: join(evidence, "PDF放大阅读.png") });
	await by("workspace-panel-expand").press("Escape");
	assert.equal(await by("workspace-panel-expand").getAttribute("aria-pressed"), "false");
	const oldWorkerClosed = pdfWorker().waitForEvent("close");
	await page.evaluate(() => {
		// 同一事件循环发起翻页并关闭，覆盖尚在绘制时释放面板的路径。
		document.querySelector('[aria-label="下一页"]').click();
		document.getElementById("workspace-panel-close").click();
	});
	await oldWorkerClosed;
	assert.equal(await by("panel-content").locator("canvas").count(), 0);
	await by("workspace-panel-toggle").click();
	await firstPage.waitFor();
	assert(pdfWorker());
	await by("panel-up").click();
	await row("进入目录：周报").click();
	await row("预览文件：项目周报.md").click();
	await by("panel-content").getByRole("heading", { name: "项目周报" }).waitFor();
	assert.equal(await by("panel-content").locator("strong").textContent(), "客户访谈");
	assert.equal(await by("panel-content").locator("table").count(), 1);
	const pane = by("workspace-panel");
	const bounds = await pane.boundingBox();
	await by("workspace-panel-resize").press("ArrowLeft");
	await page.waitForFunction(
		(old) => document.getElementById("workspace-panel").getBoundingClientRect().width > old + 15,
		bounds.width,
	);
	await page.mouse.move(20, 300);
	const grip = await by("workspace-panel-resize").boundingBox();
	const start = grip.x + grip.width / 2;
	await page.mouse.move(start, grip.y + 60);
	await page.mouse.down();
	await page.mouse.move(start - 55, grip.y + 60, { steps: 5 });
	await page.mouse.up();
	assert((await pane.boundingBox()).width > bounds.width + 55);
	await checkToggle();
	await by("panel-location").click();
	await page.screenshot({ scale: "css", path: join(evidence, "报告预览.png") });
	await by("workspace-panel-close").click();
	assert.equal(await by("prompt").inputValue(), "整理本周项目进展");
	await by("workspace-panel-toggle").click();
	await by("panel-content").getByRole("heading", { name: "项目周报" }).waitFor();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(660, 630));
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await by("workspace-panel-scrim").waitFor();
	assert(await page.locator(".conversation").evaluate((node) => node.inert));
	assert(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth));
	await page.screenshot({ scale: "css", path: join(evidence, "窄窗预览.png") });
	await by("workspace-panel-close").press("Escape");
	await pane.waitFor({ state: "hidden" });
	assert.equal(await by("prompt").inputValue(), "整理本周项目进展");
	assert(await by("workspace-panel-toggle").evaluate((node) => node === document.activeElement));
	await app.evaluate(({ BrowserWindow }, path) => {
		globalThis.panelFixture = path;
		BrowserWindow.getAllWindows()[0].setContentSize(1282, 800);
	}, alternate);
	await by("workspace-panel-toggle").click();
	await by("workspace").click();
	await row("预览文件：访谈记录.txt").waitFor();
	assert.equal(await by("panel-content").getByText("项目周报").count(), 0);
	const rejected = await page.evaluate(async (old) => {
		try {
			await window.flower.previewWorkspaceFile(old, "周报/项目周报.md");
			return false;
		} catch {
			return true;
		}
	}, first);
	assert(rejected);
	await writeFile(
		join(evidence, "result.json"),
		JSON.stringify({
			directory: true,
			pagination: 167,
			markdown: true,
			workbook: true,
			chatCorner: true,
			image: true,
			document: true,
			table: ["CSV", "TSV"],
			source: ["CSS", "HTML"],
			pdfPagesInk: [firstInk, secondInk],
			pdfWorkerClosedAndReopened: true,
			maximize: true,
			resize: true,
			draft: true,
			narrow: true,
			isolation: true,
		}),
	);
	console.log("工作区右栏通过目录分页、文本、工作簿、Markdown、调宽、窄窗和跨会话隔离验证。");
} finally {
	await app.close();
}
