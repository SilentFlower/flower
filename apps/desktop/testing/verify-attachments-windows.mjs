import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { startMockModel } from "./mock-model.mjs";

const [exe, evidence, tooling, workspace] = process.argv.slice(2);
assert(
	process.platform === "win32" && workspace,
	"在独立 Window Station 中运行：<EXE> <新证据目录> <Playwright> <含预算.xlsx和说明.docx的测试目录>",
);
const profile = join(resolve(evidence), "profile");
const store = join(profile, "local-workbench");
await mkdir(store, { recursive: true });
const { _electron: electron } = createRequire(join(resolve(tooling), "package.json"))("playwright");
const quote = "供应商报价.pdf";
const budget = "采购预算.xlsx";
const doc = "采购说明.docx";
const findings = {};
const source = join(workspace, quote);
const inbox = join(evidence, "来件");
await mkdir(inbox);
const note = "验收记录.txt";
await writeFile(join(inbox, note), "核对资料\n\n周五下午交付。");
const tiny = "小图标.png";
await writeFile(
	join(inbox, tiny),
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC", "base64"),
);
const photo = "采购成本趋势.png";
const externalBudget = join(inbox, budget);
const externalDoc = join(inbox, doc);
await copyFile(join(workspace, budget), externalBudget);
await unlink(join(workspace, budget));
await copyFile(join(workspace, doc), externalDoc);
let markdown;
const fixture = await startMockModel({
	attachmentReply(messages) {
		const user = messages.findLast((item) => item.role === "user");
		const parts = Array.isArray(user.content) ? user.content : [{ type: "text", text: user.content }];
		const content = parts
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("\n");
		if (content.includes("汇总之前的预算表")) {
			if (messages.at(-1).role !== "tool")
				return {
					toolCall: {
						name: "analyze_excel",
						args: {
							path: findings.reference,
							sheet: "年度预算",
							groupColumn: "项目",
							valueColumn: "预算单价",
							createOutputs: false,
						},
					},
				};
			findings.externalTotal = JSON.parse(messages.at(-1).content).total;
			return { text: `预算实算合计 ${findings.externalTotal} 元。` };
		}
		if (content.includes("核对单价")) {
			if (messages.at(-1).role === "tool") return { text: "核对报告已生成。" };
			const pdf = content.match(/第 2 页[\s\S]*?Q-274\s*[:：]\s*(\d+)/);
			const excel = content.match(/行 7｜[^\n]*?B7="(\d+)"/);
			if (!pdf || !excel || !content.includes("第 1 页") || !content.includes("合同摘要") || !content.includes("年度预算"))
				return { text: "附件证据不完整。" };
			findings.quote = Number(pdf[1]);
			findings.budget = Number(excel[1]);
			markdown = `# 采购核对报告\n\nQ-274 报价 ${pdf[1]} 元，预算 ${excel[1]} 元，差额 ${Number(pdf[1]) - Number(excel[1])} 元。\n\n- 报价来源：${quote}，第 2 页\n- 预算来源：${budget}，年度预算!B7`;
			findings.reference = content.match(/文件工具使用引用 (attachment:[a-f\d]{64})/)?.[1];
			assert(findings.reference);
			return { markdown, source: findings.reference };
		}
		findings.word = content.includes("交付时间为周五");
		findings.image = parts.some(
			(part) => part.type === "image_url" && part.image_url?.url.startsWith("data:image/png;base64,iVBOR"),
		);
		return { text: findings.word && findings.image ? "已收到正文和截图。" : "资料不完整。" };
	},
});
await writeFile(join(store, "model.json"), JSON.stringify({ modelId: fixture.modelId, baseUrl: fixture.baseUrl }));
let app;
let page;
async function boot() {
	app = await electron.launch({
		executablePath: resolve(exe),
		args: [`--user-data-dir=${profile}`],
		chromiumSandbox: true,
	});
	page = await app.firstWindow();
	page.setDefaultTimeout(16000);
	await app.evaluate(
		({ app, dialog }, input) => {
			if (app.getPath("userData").toLowerCase() !== input.profile.toLowerCase()) throw new Error("资料路径不符");
			dialog.showOpenDialog = async (_win, opt) => ({
				canceled: false,
				filePaths: opt.properties.includes("openDirectory") ? [input.workspace] : input.files,
			});
		},
		{ profile, workspace, files: [source, externalBudget] },
	);
	await page.locator("#workspace:not(:disabled)").waitFor();
}
const by = (id) => page.locator(`#${id}`);
const button = (name) => page.getByRole("button", { name, exact: true });
const chip = (name) => by("attachment").locator(".chip-name").getByText(name, { exact: true });
try {
	await boot();
	const pdf = await app.evaluate(async ({ BrowserWindow }) => {
		const sample = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
		try {
			const html =
				'<meta charset="utf-8"><style>@page{size:A5;margin:15mm}section{break-after:page}section:last-child{break-after:auto}</style><section><h1>合同摘要</h1></section><section><h1>供应商单价</h1><p>Q-274: 375</p></section>';
			await sample.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
			return (await sample.webContents.printToPDF({ preferCSSPageSize: true })).toString("base64");
		} finally {
			sample.destroy();
		}
	});
	await writeFile(source, Buffer.from(pdf, "base64"));
	await by("workspace").click();
	// 在独立 Window Station 覆盖空剪贴板，以及系统中实际可读的 PNG。
	await app.evaluate(({ clipboard }) => clipboard.clear());
	await by("composer-add").press("ArrowDown");
	assert.equal(await chip("截图 1.png").count(), 0);
	await by("paste-clipboard-image").click();
	await page.getByText("剪贴板中没有图片。", { exact: true }).waitFor();
	await app.evaluate(
		({ clipboard, ClipboardItem }, png) =>
			clipboard.write([new ClipboardItem({ "image/png": new Blob([Buffer.from(png, "base64")], { type: "image/png" }) })]),
		(await readFile(join(inbox, tiny))).toString("base64"),
	);
	await by("composer-add").click();
	await by("paste-clipboard-image").click();
	await chip("截图 1.png").waitFor();
	await button("移除 截图 1.png").click();
	await chip("截图 1.png").waitFor({ state: "hidden" });
	await by("composer-add").click();
	await by("file").click();
	await chip(budget).waitFor();
	await unlink(externalBudget);
	const id = await page.evaluate(async () => (await window.flower.state()).selected);
	await button(`移除 ${quote}`).click();
	await chip(quote).waitFor({ state: "hidden" });
	await by("composer-add").click();
	await by("reference-workspace").click();
	await button(`预览文件：${quote}`).click();
	await by("panel-reference").click();
	await chip(quote).waitFor();
	assert.equal(await by("panel-reference").getAttribute("aria-disabled"), "true");
	await by("panel-up").click();
	await by("prompt").fill("核对单价，标出 PDF 页码和预算表行号，生成核对报告。");
	await page.mouse.move(10, 10);
	await page.screenshot({ scale: "css", path: join(evidence, "多文件草稿.png") });
	await by("new-session").click();
	await by("attachment").waitFor({ state: "hidden" });
	await page.evaluate((session) => window.flower.selectSession(session), id);
	await chip(quote).waitFor();
	await page.evaluate((session) => window.flower.setWriteMode(session, "ask"), id);
	await by("send").click();
	await by("write-allow")
		.waitFor({ timeout: 30000 })
		.catch(async (error) => {
			throw new Error(`未看到报告审批：${await by("timeline").innerText()}`, { cause: error });
		});
	assert((await by("write-files").textContent()).includes("核对报告.md"));
	await by("write-allow").click();
	await button("预览核对报告").click();
	await by("panel-content").getByRole("heading", { name: "采购核对报告" }).waitFor();
	assert.match(await by("panel-content").textContent(), /差额 55 元/);
	const requests = await page.evaluate((session) => window.flower.history(session), id);
	const artifact = requests[0].artifacts[0];
	assert.equal(await readFile(join(workspace, artifact), "utf8"), markdown);
	await page.screenshot({ scale: "css", path: join(evidence, "核对结果.png") });
	await by("workspace-panel-close").click();
	const chart = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 1200;
		canvas.height = 680;
		const c = canvas.getContext("2d");
		c.fillStyle = "#f7f6ef";
		c.fillRect(0, 0, 1200, 680);
		c.fillStyle = "#223a33";
		c.font = 'bold 46px "Microsoft YaHei"';
		c.fillText("采购成本趋势", 68, 100);
		c.fillStyle = "#597064";
		c.font = '24px "Microsoft YaHei"';
		c.fillText("年度预算与实际报价", 68, 146);
		for (let i = 0; i < 4; i++) {
			c.fillStyle = "#d5dbd1";
			c.fillRect(90, 250 + i * 85, 1030, 2);
		}
		for (const [color, points] of [
			["#376a53", [475, 450, 460, 402, 370, 387]],
			["#bf7651", [460, 423, 433, 331, 286, 262]],
		]) {
			c.strokeStyle = color;
			c.lineWidth = 8;
			c.lineJoin = "round";
			c.beginPath();
			for (const [i, v] of points.entries()) {
				if (i) c.lineTo(98 + i * 193, v);
				else c.moveTo(98, v);
			}
			c.stroke();
			points.forEach((v, i) => {
				c.fillStyle = color;
				c.beginPath();
				c.arc(98 + i * 193, v, 9, 0, Math.PI * 2);
				c.fill();
			});
		}
		c.font = '22px "Microsoft YaHei"';
		c.fillStyle = "#54685c";
		for (let i = 0; i < 6; i++) c.fillText(`${i + 1}月`, 80 + i * 193, 572);
		return canvas.toDataURL("image/png").split(",")[1];
	});
	await writeFile(join(inbox, photo), Buffer.from(chart, "base64"));
	await writeFile(join(workspace, photo), Buffer.from(chart, "base64"));
	await page.evaluate(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.id = "qa-drop";
		document.body.append(input);
	});
	await by("qa-drop").setInputFiles([externalDoc, join(inbox, photo), join(inbox, note), join(inbox, tiny)]);
	await page.evaluate(() => {
		const d = new DataTransfer();
		for (const file of document.querySelector("#qa-drop").files) d.items.add(file);
		document
			.querySelector("#composer")
			.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: d }));
		document.querySelector("#qa-drop").remove();
	});
	await chip(doc).waitFor();
	await chip(photo).waitFor();
	await unlink(join(inbox, photo));
	await unlink(externalDoc);
	await unlink(join(inbox, note));
	async function openNote(container) {
		const source = container.getByRole("button", { name: `预览附件：${note}`, exact: true });
		await source.click();
		await by("panel-content").locator(".panel-prose").filter({ hasText: "周五下午交付。" }).waitFor();
		await by("workspace-panel-close").click();
		assert(await source.evaluate((button) => document.activeElement === button));
	}
	await openNote(by("attachment"));
	await by("attachment")
		.getByRole("button", { name: `预览附件：${doc}` })
		.click();
	await by("panel-content").getByText("交付时间为周五。").waitFor();
	await by("workspace-panel-close").click();
	const preview = (container, name) => container.getByRole("button", { name: `查看大图：${name}`, exact: true });
	async function checkImage(control, width, capture) {
		await control.locator(".attachment-thumb").evaluate(async (img) => {
			if (img.src) await img.decode();
		});
		await page.waitForFunction(
			(name) =>
				[...document.querySelectorAll(".attachment-image-open")].some(
					(b) => b.title === name && b.querySelector("img")?.naturalWidth > 0,
				),
			await control.getAttribute("title"),
		);
		const size = await control
			.locator("img")
			.evaluate((img) => ({ width: img.clientWidth, height: img.clientHeight, fit: getComputedStyle(img).objectFit }));
		assert(size.width <= 54 && size.height <= 36 && size.fit === "contain", JSON.stringify(size));
		await control.focus();
		await control.press("Enter");
		await page.waitForFunction(
			(w) =>
				document.getElementById("image-viewer").open &&
				!document.getElementById("image-full").hidden &&
				document.getElementById("image-full").naturalWidth === w,
			width,
		);
		if (capture) await page.screenshot({ scale: "css", path: join(evidence, capture) });
		await by("image-zoom").click();
		assert.equal(await by("image-zoom").getAttribute("aria-pressed"), "true");
		await page.keyboard.press("Escape");
		await by("image-viewer").waitFor({ state: "hidden" });
		assert(await control.evaluate((b) => b === document.activeElement));
	}
	const small = preview(by("attachment"), tiny);
	await page.waitForFunction(
		(name) =>
			[...document.querySelectorAll(".attachment-image-open")].some(
				(button) => button.title === name && button.querySelector("img")?.naturalWidth === 1,
			),
		tiny,
	);
	assert.deepEqual(await small.locator("img").evaluate((image) => [image.clientWidth, image.clientHeight]), [1, 1]);
	await small.click();
	await page.waitForFunction(
		() => document.querySelector("#image-full").naturalWidth === 1 && !document.querySelector("#image-full").hidden,
	);
	assert.deepEqual(await by("image-full").evaluate((image) => [image.clientWidth, image.clientHeight]), [1, 1]);
	await by("image-close").click();
	await button(`移除 ${tiny}`).click();
	findings.smallImageNaturalSize = true;
	await checkImage(preview(by("attachment"), photo), 1200, "大图查看.png");
	// 同一会话再次选中同一来源后，重复引用的副本需继续供历史读取。
	await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const c = canvas.getContext("2d");
		c.fillStyle = "#fdfaf3";
		c.fillRect(0, 0, 640, 360);
		c.fillStyle = "#38584a";
		c.fillRect(0, 0, 640, 86);
		c.font = 'bold 30px "Microsoft YaHei"';
		c.fillStyle = "#fff";
		c.fillText("采购单价核对", 30, 53);
		c.font = '22px "Microsoft YaHei"';
		c.fillStyle = "#3b443e";
		for (const [i, label] of ["项目          Q-274", "供应商报价       375 元", "年度预算          320 元"].entries()) {
			c.fillText(label, 32, 145 + i * 67);
			c.fillStyle = "#deded4";
			c.fillRect(32, 164 + i * 67, 570, 1);
			c.fillStyle = "#3b443e";
		}
		const img = await new Promise((r) => canvas.toBlob(r));
		const d = new DataTransfer();
		d.items.add(new File([img], "Image.png", { type: "image/png" }));
		document
			.getElementById("prompt")
			.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: d }));
	});
	await chip("截图 1.png").waitFor();
	await checkImage(preview(by("attachment"), "截图 1.png"), 640);
	await page.screenshot({ scale: "css", path: join(evidence, "图片草稿.png") });
	await by("prompt").fill("看看采购说明里的交付时间以及这张截图。");
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(660, 630));
	await page.emulateMedia({ colorScheme: "dark" });
	await page.waitForFunction(() => document.documentElement.dataset.scheme === "dark" && innerWidth === 660);
	assert(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth === innerWidth &&
				document.getElementById("send").getBoundingClientRect().right <= innerWidth,
		),
	);
	await page.screenshot({ scale: "css", path: join(evidence, "窄窗深色.png") });
	await by("send").click();
	await by("timeline").getByText("已收到正文和截图。", { exact: true }).waitFor();
	await app.close();
	app = undefined;
	await boot();
	await by("timeline").getByText("已收到正文和截图。", { exact: true }).waitFor();
	assert.equal(await page.locator(".message-file .chip-name").count(), 6);
	await openNote(by("timeline"));
	await checkImage(preview(by("timeline"), photo), 1200);
	await checkImage(preview(by("timeline"), "截图 1.png"), 640);
	await page.screenshot({ scale: "css", path: join(evidence, "历史图片.png") });
	await by("workspace-panel-toggle").click();
	await by("panel-up").click();
	await button(`预览文件：${photo}`).click();
	await button(`查看大图：${photo}`).and(by("panel-content").locator("button")).click();
	await page.waitForFunction(
		() => document.getElementById("image-full").naturalWidth === 1200 && !document.getElementById("image-full").hidden,
	);
	await by("image-close").click();
	await by("workspace-panel-close").click();
	assert(await by("attachment").isHidden());
	await by("prompt").fill("汇总之前的预算表");
	await by("send").click();
	await by("timeline").getByText("预算实算合计 320 元。", { exact: true }).waitFor();
	await writeFile(
		join(evidence, "result.json"),
		JSON.stringify({
			...findings,
			markup: artifact,
			restored: true,
			drop: true,
			paste: true,
			approval: true,
			externalPicker: true,
			externalDrop: true,
			thumbnail: true,
			zoom: true,
			deletedOriginal: true,
		}),
	);
} finally {
	await app?.close();
	await fixture.close();
}
