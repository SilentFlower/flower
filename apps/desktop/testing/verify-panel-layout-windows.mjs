import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [binary, output, tooling] = process.argv.slice(2);
assert(
	process.platform === "win32" && tooling,
	"用法：verify-panel-layout-windows.mjs <EXE> <新证据目录> <Playwright>",
);
const evidence = resolve(output);
const profile = join(evidence, "profile");
const workspace = join(evidence, "布局工作区");
const require = createRequire(join(resolve(tooling), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
await mkdir(join(workspace, "资料"), { recursive: true });
await writeFile(join(workspace, "资料", "周报.md"), "# 本周进展\n\n- 完成停靠验证\n");
await writeFile(join(workspace, "说明.txt"), "初始说明\n");
const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { stdio: "pipe" });
git("init", "-q", "-b", "main");
git("add", "--", ".");
git("-c", "user.name=Flower", "-c", "user.email=flower@example.invalid", "commit", "-q", "-m", "初始资料");
await writeFile(join(workspace, "说明.txt"), "初始说明\n停靠后仍显示的改动\n");

const results = { scenarios: {} };
const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;

async function open() {
	const app = await electron.launch({
		executablePath: resolve(binary),
		args: [`--user-data-dir=${profile}`],
		chromiumSandbox: true,
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(8000);
	await app.evaluate(
		({ app, dialog }, fixture) => {
			if (app.getPath("userData").toLowerCase() !== fixture.profile.toLowerCase()) throw new Error("资料目录不符");
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.workspace] });
		},
		{ profile, workspace },
	);
	await page.locator("#workspace:not(:disabled)").waitFor();
	const by = (id) => page.locator(`#${id}`);
	async function settle() {
		await page.waitForFunction(() => !document.getElementById("workbench").dataset.windowFit);
		// 过渡解冻后等待两帧，让网格和窗口尺寸稳定。
		await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
	}
	const native = () =>
		app.evaluate(({ BrowserWindow, screen }) => {
			const window = BrowserWindow.getAllWindows()[0];
			const bounds = window.getBounds();
			const display = screen.getDisplayMatching(bounds);
			return {
				bounds,
				content: window.getContentBounds(),
				workArea: display.workArea,
				scaleFactor: display.scaleFactor,
				maximized: window.isMaximized(),
				displays: screen.getAllDisplays().map(({ id, workArea, scaleFactor }) => ({ id, workArea, scaleFactor })),
			};
		});
	const geometry = () =>
		page.evaluate(() => {
			const box = (selector) => {
				const node = document.querySelector(selector);
				if (!node || node.closest("[hidden]")) return null;
				const { x, y, width, height, right } = node.getBoundingClientRect();
				return { x, y, width, height, right };
			};
			return {
				innerWidth,
				side: document.getElementById("workbench").dataset.panelSide,
				sidebar: box(".sidebar"),
				chat: box(".conversation"),
				composer: box("#composer"),
				prompt: box("#prompt"),
				panel: box("#workspace-panel"),
			};
		});
	async function snapshot(label) {
		const shot = { label, native: await native(), page: await geometry() };
		// 页面坐标加上内容区原点得到屏幕坐标，用于比较聊天区在显示器上的位置。
		shot.screen = {
			sidebarX: shot.native.content.x + shot.page.sidebar.x,
			chatX: shot.native.content.x + shot.page.chat.x,
			composerX: shot.native.content.x + shot.page.composer.x,
		};
		return shot;
	}
	async function place(bounds) {
		const content = await app.evaluate(({ BrowserWindow }, next) => {
			const window = BrowserWindow.getAllWindows()[0];
			if (window.isMaximized()) window.unmaximize();
			window.setBounds(next);
			return window.getContentBounds();
		}, bounds);
		await page.waitForFunction((width) => Math.abs(innerWidth - width) <= 1, content.width);
		await settle();
	}
	async function moveTo(area, size) {
		// 跨缩放比例一步设置外框会按新比例放大尺寸，先移入目标屏，等页面缩放更新后再定尺寸。
		const point = { x: area.x + 40, y: area.y + 40 };
		const scale = await app.evaluate(({ BrowserWindow, screen }, target) => {
			const window = BrowserWindow.getAllWindows()[0];
			if (window.isMaximized()) window.unmaximize();
			window.setPosition(target.x, target.y);
			return screen.getDisplayNearestPoint(target).scaleFactor;
		}, point);
		await page.waitForFunction((factor) => Math.abs(devicePixelRatio - factor) < 0.01, scale);
		await place({ ...point, ...size });
	}
	async function toggle(openPanel) {
		if (openPanel) await by("workspace-panel-toggle").click();
		else await by("workspace-panel-close").click();
		await by("workspace-panel").waitFor({ state: openPanel ? "visible" : "hidden" });
		await settle();
	}
	return { app, page, by, settle, native, snapshot, place, moveTo, toggle };
}

function sameChat(before, after, message, samePosition = true) {
	const facts = {
		chatWidth: [before.page.chat.width, after.page.chat.width],
		composerWidth: [before.page.composer.width, after.page.composer.width],
		promptWidth: [before.page.prompt.width, after.page.prompt.width],
		sidebarWidth: [before.page.sidebar.width, after.page.sidebar.width],
	};
	if (samePosition) {
		facts.chatX = [before.screen.chatX, after.screen.chatX];
		facts.composerX = [before.screen.composerX, after.screen.composerX];
		facts.sidebarX = [before.screen.sidebarX, after.screen.sidebarX];
	}
	for (const [name, [a, b]] of Object.entries(facts)) assert(near(a, b), `${message}：${name} ${a} → ${b}`);
}

function insideArea({ bounds, workArea }) {
	return (
		bounds.x >= workArea.x &&
		bounds.y >= workArea.y &&
		bounds.x + bounds.width <= workArea.x + workArea.width &&
		bounds.y + bounds.height <= workArea.y + workArea.height
	);
}

async function headerDragPoint(page) {
	const point = await page.locator(".workspace-panel-header").evaluate((header) => {
		const { left, right, top, height } = header.getBoundingClientRect();
		const y = Math.floor(top + height / 2);
		let start = Math.max(0, Math.ceil(left));
		let widest = { x: start, y, width: 0 };
		// 按实际命中计算连续空白，隐藏标签及溢出的按钮都不会误作拖动起点。
		for (let x = start; x < Math.min(right, innerWidth); x++) {
			const hit = document.elementFromPoint(x, y);
			if (
				!header.contains(hit) ||
				hit.closest("button, a[href], input, textarea, select, summary, [role='separator'], [contenteditable='true']")
			) {
				start = x + 1;
				continue;
			}
			const width = x - start + 1;
			if (width > widest.width) widest = { x: Math.floor((start + x) / 2), y, width };
		}
		return widest;
	});
	assert(point.width >= 8, `标题栏需要至少 8 像素连续可拖空白，实际 ${point.width} 像素`);
	return point;
}

let session = await open();
try {
	const { app, page, by, native, snapshot, place, moveTo, toggle } = session;
	await by("workspace").click();
	await page.waitForFunction(() => window.flower.state().then(({ draft }) => Boolean(draft)));
	assert.equal(await page.locator(".session-row").count(), 0);
	await by("prompt").fill("整理布局验证");
	const { workArea, displays, scaleFactor } = await native();
	results.display = { workArea, scaleFactor, displays };
	const home = {
		x: workArea.x + Math.max(0, Math.min(200, workArea.width - 1850)),
		y: workArea.y + 60,
		width: 1250,
		height: 760,
	};
	await place(home);

	// 1. 右侧空间充足：窗口向右扩出面板宽度，左栏、聊天区和输入框保持屏幕位置与宽度。
	const before = await snapshot("打开前");
	await toggle(true);
	const after = await snapshot("打开后");
	assert.equal(after.native.bounds.x, before.native.bounds.x);
	assert(near(after.native.bounds.width - before.native.bounds.width, after.page.panel.width, 2));
	assert(insideArea(after.native));
	sameChat(before, after, "右侧展开");
	await page.mouse.move(5, 300);
	await page.screenshot({ scale: "css", path: join(evidence, "右侧展开.png") });
	await toggle(false);
	const closed = await snapshot("收起后");
	assert.deepEqual(closed.native.bounds, before.native.bounds);
	sameChat(before, closed, "收起还原");
	results.scenarios.expand = { before, after, closed };

	// 2. 反复开关五次不漂移。
	for (let round = 0; round < 5; round++) {
		await toggle(true);
		await toggle(false);
	}
	const repeated = await snapshot("反复开关后");
	assert.deepEqual(repeated.native.bounds, before.native.bounds);
	results.scenarios.repeat = { rounds: 5, bounds: repeated.native.bounds };

	// 3. 右侧空间不足：向左补足缺口，窗口留在工作区内，聊天区宽度不变。
	const edge = { ...home, x: workArea.x + workArea.width - home.width - 120 };
	await place(edge);
	const edgeBefore = await snapshot("靠右打开前");
	await toggle(true);
	const edgeAfter = await snapshot("靠右打开后");
	assert(insideArea(edgeAfter.native));
	assert(edgeAfter.native.bounds.x < edgeBefore.native.bounds.x);
	assert.equal(edgeAfter.native.bounds.x + edgeAfter.native.bounds.width, workArea.x + workArea.width);
	sameChat(edgeBefore, edgeAfter, "靠右展开", false);
	await toggle(false);
	assert.deepEqual((await native()).bounds, edgeBefore.native.bounds);
	results.scenarios.rightEdge = { before: edgeBefore, after: edgeAfter };

	// 4. 窗口已占满工作区宽度：不扩展，面板占用聊天区。
	const full = { x: workArea.x, y: home.y, width: workArea.width, height: home.height };
	await place(full);
	const fullBefore = await native();
	await toggle(true);
	const fullAfter = await snapshot("占满宽度打开后");
	assert.deepEqual(fullAfter.native.bounds, fullBefore.bounds);
	await toggle(false);
	assert.deepEqual((await native()).bounds, fullBefore.bounds);
	results.scenarios.fullWidth = { bounds: fullBefore.bounds, chatWidthWithPanel: fullAfter.page.chat.width };

	// 5. 最大化：不扩展；展开后最大化再收起，退出最大化时还原原外框。
	await place(home);
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
	await page.waitForFunction((width) => innerWidth > width + 50, home.width);
	const maximized = await native();
	await toggle(true);
	assert.deepEqual((await native()).bounds, maximized.bounds);
	await toggle(false);
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
	await page.waitForFunction((width) => Math.abs(innerWidth - width) <= 1, before.native.content.width);
	assert.deepEqual((await native()).bounds, before.native.bounds);
	await toggle(true);
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
	await page.waitForFunction((width) => innerWidth > width + 50, after.native.content.width);
	await toggle(false);
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
	await page.waitForFunction((width) => Math.abs(innerWidth - width) <= 1, before.native.content.width);
	const unmaximized = await snapshot("最大化期间收起后");
	assert.deepEqual(unmaximized.native.bounds, before.native.bounds);
	sameChat(before, unmaximized, "退出最大化还原");
	results.scenarios.maximized = { maximizedBounds: maximized.bounds, restored: unmaximized.native.bounds };

	// 6. 展开期间移动并调宽：收起只减去扩出的宽度，保留用户的位移和调宽。
	await toggle(true);
	const moved = await native();
	await place({ ...moved.bounds, x: moved.bounds.x + 40, y: moved.bounds.y + 30, width: moved.bounds.width + 120 });
	await toggle(false);
	const userAdjusted = await native();
	assert.deepEqual(userAdjusted.bounds, {
		x: before.native.bounds.x + 40,
		y: before.native.bounds.y + 30,
		width: before.native.bounds.width + 120,
		height: before.native.bounds.height,
	});
	results.scenarios.userMoveResize = { expanded: moved.bounds, restored: userAdjusted.bounds };

	// 7. 窄窗沿用覆盖抽屉，不扩展窗口，Esc 收起后草稿仍在。
	await place({ ...home, width: 900, height: 700 });
	const narrowBefore = await native();
	await toggle(true);
	await by("workspace-panel-scrim").waitFor();
	assert.deepEqual((await native()).bounds, narrowBefore.bounds);
	assert(await page.locator(".conversation").evaluate((node) => node.inert));
	await page.screenshot({ scale: "css", path: join(evidence, "窄窗抽屉.png") });
	await by("workspace-panel-close").press("Escape");
	await by("workspace-panel").waitFor({ state: "hidden" });
	assert.deepEqual((await native()).bounds, narrowBefore.bounds);
	assert.equal(await by("prompt").inputValue(), "整理布局验证");
	results.scenarios.narrow = { bounds: narrowBefore.bounds };

	// 8. 拖动标题栏空白处换到左侧：保留窗口扩展、聊天宽度和正在查看的 Git 差异。
	await place(home);
	await toggle(true);
	const expanded = await snapshot("拖动前");
	await by("panel-git").click();
	await page.locator(".git-row", { hasText: "说明.txt" }).click();
	const diff = page.locator(".git-diff");
	await diff.waitFor();
	const diffText = await diff.textContent();
	assert(diffText.includes("停靠后仍显示的改动"));
	await diff.evaluate((node) => {
		globalThis.dockedDiff = node;
	});
	const blank = await headerDragPoint(page);
	await page.mouse.move(blank.x, blank.y);
	await page.mouse.down();
	await page.mouse.move(blank.x - 3, blank.y + 2);
	assert.equal(await page.locator(".panel-drop-zone").count(), 0, "点击容差内不应进入拖动");
	const leftTarget = expanded.page.chat.x + 80;
	await page.mouse.move(leftTarget, blank.y + 120, { steps: 8 });
	const zone = page.locator(".panel-drop-zone");
	await zone.waitFor();
	assert.equal(await zone.textContent(), "松手放到聊天区左侧");
	const zoneBox = await zone.boundingBox();
	assert(near(zoneBox.x, expanded.page.chat.x, 1));
	await page.screenshot({ scale: "css", path: join(evidence, "拖动高亮左侧.png") });
	await page.mouse.up();
	await session.settle();
	const docked = await snapshot("拖到左侧后");
	assert.equal(docked.page.side, "left");
	assert(docked.page.panel.right <= docked.page.chat.x + 1);
	assert.deepEqual(docked.native.bounds, expanded.native.bounds);
	sameChat(before, docked, "拖到左侧后的聊天宽度", false);
	assert(await diff.evaluate((node) => node === globalThis.dockedDiff));
	assert.equal(await diff.textContent(), diffText);
	assert.equal(await by("panel-git").getAttribute("aria-pressed"), "true");
	assert.equal(await page.locator(".panel-drop-zone, .panel-drag-ghost").count(), 0);
	await page.mouse.move(5, 300);
	await page.screenshot({ scale: "css", path: join(evidence, "左侧停靠.png") });
	results.scenarios.dragLeft = { before: expanded, after: docked, blankWidth: blank.width };

	// 9. 拖向右侧途中按 Esc：取消拖动，不收起面板，停靠位置不变。
	const leftBlank = await headerDragPoint(page);
	await page.mouse.move(leftBlank.x, leftBlank.y);
	await page.mouse.down();
	await page.mouse.move(docked.page.chat.right - 80, leftBlank.y + 120, { steps: 8 });
	await zone.waitFor();
	assert.equal(await zone.textContent(), "松手放到聊天区右侧");
	await page.keyboard.press("Escape");
	assert.equal(await page.locator(".panel-drop-zone, .panel-drag-ghost").count(), 0);
	await page.mouse.up();
	assert(await by("workspace-panel").isVisible());
	assert.equal((await session.snapshot("取消后")).page.side, "left");
	assert(await diff.evaluate((node) => node === globalThis.dockedDiff));
	assert.equal(await diff.textContent(), diffText);
	results.scenarios.cancel = { side: "left", panelOpen: true, diffPreserved: true, blankWidth: leftBlank.width };

	// 10. 点击标签与拖动调宽手柄不触发停靠。
	await by("panel-files").click();
	assert.equal(await by("panel-files").getAttribute("aria-pressed"), "true");
	const grip = await by("workspace-panel-resize").boundingBox();
	const panelWidth = (await by("workspace-panel").boundingBox()).width;
	await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
	await page.mouse.down();
	await page.mouse.move(grip.x + grip.width / 2 + 40, grip.y + 200, { steps: 5 });
	assert.equal(await page.locator(".panel-drop-zone").count(), 0);
	await page.mouse.up();
	const resized = await session.snapshot("左侧调宽后");
	assert(resized.page.panel.width > panelWidth + 30);
	assert.equal(resized.page.side, "left");
	await by("panel-git").click();
	results.scenarios.controls = { panelWidth: [panelWidth, resized.page.panel.width] };

	// 11. 键盘停靠：标题栏按钮切换左右，状态区域播报结果，窗口不变。
	await by("workspace-panel-dock").focus();
	await page.keyboard.press("Enter");
	assert.equal(await by("workbench").getAttribute("data-panel-side"), "right");
	assert.equal(await by("panel-layout-live").textContent(), "文件面板已移到聊天区右侧。");
	assert.deepEqual((await native()).bounds, expanded.native.bounds);
	assert(await by("workspace-panel-dock").evaluate((node) => node === document.activeElement));
	await page.keyboard.press("Space");
	assert.equal(await by("workbench").getAttribute("data-panel-side"), "left");
	results.scenarios.keyboard = { announced: true };

	// 12. 面板放大与 Esc 还原仍可用。
	await by("workspace-panel-expand").click();
	assert.equal(await by("workspace-panel-expand").getAttribute("aria-pressed"), "true");
	await by("workspace-panel-expand").press("Escape");
	assert.equal(await by("workspace-panel-expand").getAttribute("aria-pressed"), "false");
	assert(await by("workspace-panel").isVisible());

	// 13. 左侧停靠时收起还原窗口；从收起状态打开同样扩窗，聊天区保持宽度。
	await toggle(false);
	assert.deepEqual((await native()).bounds, before.native.bounds);
	const leftBefore = await snapshot("左侧打开前");
	await toggle(true);
	const leftAfter = await snapshot("左侧打开后");
	assert(near(leftAfter.native.bounds.width - leftBefore.native.bounds.width, leftAfter.page.panel.width, 2));
	sameChat(leftBefore, leftAfter, "左侧展开", false);
	await toggle(false);
	assert.deepEqual((await native()).bounds, before.native.bounds);
	assert.equal(await by("prompt").inputValue(), "整理布局验证");
	results.scenarios.leftOpen = { before: leftBefore, after: leftAfter };

	// 14. 混合缩放的多显示器：先移入目标屏并等待缩放更新，再在该屏定尺寸，按实际回读判断。
	const other = displays.find(({ workArea: area }) => area.x !== workArea.x || area.y !== workArea.y);
	if (other) {
		const area = other.workArea;
		// 基准宽度为面板和边距留出空间，保证这一屏可以完整扩展；空间不足另由靠右场景覆盖。
		const size = {
			width: Math.min(1150, Math.floor((area.width - 80) / 1.4)),
			height: Math.min(720, area.height - 80),
		};
		await moveTo(area, size);
		const secondBefore = await snapshot("第二显示器打开前");
		assert(insideArea(secondBefore.native), JSON.stringify(secondBefore.native));
		await toggle(true);
		const secondAfter = await snapshot("第二显示器打开后");
		assert(insideArea(secondAfter.native));
		sameChat(secondBefore, secondAfter, "第二显示器展开", false);
		await toggle(false);
		const rounds = [(await native()).bounds];
		for (let round = 0; round < 7; round++) {
			await toggle(true);
			await toggle(false);
			rounds.push((await native()).bounds);
		}
		// 分数缩放允许单次 1 DIP 取整，但反复开关不得逐次累积。
		for (const [index, bounds] of rounds.entries()) {
			for (const key of ["x", "y", "width", "height"])
				assert(
					near(bounds[key], secondBefore.native.bounds[key]),
					`第二显示器第 ${index + 1} 次收起后 ${key}：${bounds[key]}`,
				);
		}
		results.scenarios.secondaryDisplay = {
			scaleFactor: other.scaleFactor,
			before: secondBefore,
			after: secondAfter,
			rounds,
		};
		await moveTo(workArea, { width: home.width, height: home.height });
	} else {
		results.scenarios.secondaryDisplay = { skipped: "当前只有一块显示器" };
	}
	await place(home);

	// 15. 并排布局下把面板收至最小宽度，分别验证隐藏和显示工具标签时仍可拖动。
	await toggle(true);
	await by("workspace-panel-resize").press("Home");
	const narrowPanel = await snapshot("面板最小宽度");
	assert.equal(narrowPanel.page.panel.width, 320);
	assert(await by("panel-current-tool").isHidden());
	const toRight = await headerDragPoint(page);
	await page.mouse.move(toRight.x, toRight.y);
	await page.mouse.down();
	await page.mouse.move(narrowPanel.page.chat.right - 80, toRight.y + 120, { steps: 8 });
	await zone.waitFor();
	assert.equal(await zone.textContent(), "松手放到聊天区右侧");
	await page.screenshot({ scale: "css", path: join(evidence, "最窄面板拖向右侧.png") });
	await page.mouse.up();
	const narrowRight = await snapshot("最窄面板停靠右侧");
	assert.equal(narrowRight.page.side, "right");
	assert.equal(narrowRight.page.panel.width, 320);
	assert.deepEqual(narrowRight.native.bounds, narrowPanel.native.bounds);
	assert.equal(await page.locator(".panel-drop-zone, .panel-drag-ghost").count(), 0);

	await by("panel-more-tools").click();
	await page.locator('#panel-tool-menu [data-panel-mode="tasks"]').click();
	assert(await by("panel-current-tool").isVisible());
	const toLeft = await headerDragPoint(page);
	await page.mouse.move(toLeft.x, toLeft.y);
	await page.mouse.down();
	await page.mouse.move(narrowRight.page.chat.x + 80, toLeft.y + 120, { steps: 8 });
	await zone.waitFor();
	assert.equal(await zone.textContent(), "松手放到聊天区左侧");
	await page.mouse.up();
	const narrowLeft = await snapshot("最窄面板停靠左侧");
	assert.equal(narrowLeft.page.side, "left");
	assert.equal(narrowLeft.page.panel.width, 320);
	assert.deepEqual(narrowLeft.native.bounds, narrowPanel.native.bounds);
	assert(await by("panel-current-tool").isVisible());
	assert.equal(await page.locator(".panel-drop-zone, .panel-drag-ghost").count(), 0);
	await toggle(false);
	results.scenarios.minimumWidthDrag = {
		panelWidth: narrowPanel.page.panel.width,
		dragRightBlankWidth: toRight.width,
		dragLeftBlankWidth: toLeft.width,
		bounds: narrowPanel.native.bounds,
	};
} finally {
	await session.app.close();
}

// 16. 重启后恢复左侧停靠，仍按原规则扩窗与还原。
session = await open();
try {
	const { page, by, snapshot, place, toggle } = session;
	assert.equal(await by("workbench").getAttribute("data-panel-side"), "left");
	// 只有面板首选项需要重启恢复，离线的临时草稿关联通过正常目录入口重新选择。
	await by("workspace").click();
	await page.waitForFunction(() => window.flower.state().then(({ draft }) => Boolean(draft)));
	const { workArea } = await session.native();
	await place({
		x: workArea.x + Math.max(0, Math.min(200, workArea.width - 1850)),
		y: workArea.y + 60,
		width: 1250,
		height: 760,
	});
	const restartBefore = await snapshot("重启后打开前");
	await toggle(true);
	const restartAfter = await snapshot("重启后打开后");
	assert(restartAfter.page.panel.right <= restartAfter.page.chat.x + 1);
	sameChat(restartBefore, restartAfter, "重启后左侧展开", false);
	await page.mouse.move(5, 300);
	await page.screenshot({ scale: "css", path: join(evidence, "重启后左侧停靠.png") });
	await toggle(false);
	assert.deepEqual((await session.native()).bounds, restartBefore.native.bounds);
	results.scenarios.restart = { side: "left", before: restartBefore, after: restartAfter };
} finally {
	await session.app.close();
}

await writeFile(join(evidence, "result.json"), JSON.stringify(results, null, "\t"));
console.log("面板停靠与窗口扩展通过扩展、靠右、占满、最大化、移动调宽、窄窗、拖放、取消、键盘与重启验证。");
