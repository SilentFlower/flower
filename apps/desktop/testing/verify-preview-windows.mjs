import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const [exeArg, evidenceArg, toolingArg] = process.argv.slice(2);
assert(process.platform === "win32", "请在 Windows Node 上运行验收");
assert(exeArg && evidenceArg && toolingArg, "用法：verify-windows.mjs <EXE> <新证据目录> <安装了 playwright 的目录>");
const exe = resolve(exeArg);
const evidence = resolve(evidenceArg);
const require = createRequire(join(resolve(toolingArg), "package.json"));
const { _electron: electron } = require("playwright");
await mkdir(evidence);
const profile = join(evidence, "profile");

function power(script) {
	const utf8 = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ";
	const encoded = Buffer.from(utf8 + script, "utf16le").toString("base64");
	return JSON.parse(
		execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 20000,
		}).trim(),
	);
}

const hardware = power(
	[
		"$p = Get-CimInstance Win32_Processor | Select-Object -First 1",
		"$s = Get-CimInstance Win32_ComputerSystem",
		"$o = Get-CimInstance Win32_OperatingSystem",
		"[ordered]@{CPU=$p.Name.Trim(); Cores=$p.NumberOfCores; Logical=$p.NumberOfLogicalProcessors; RAM=$s.TotalPhysicalMemory; Windows=$o.Caption; Build=$o.BuildNumber} | ConvertTo-Json -Compress",
	].join("; "),
);

function processTree(root) {
	return power(
		[
			"$p = Get-CimInstance Win32_Process",
			"$ids = [Collections.Generic.HashSet[int]]::new()",
			`$null = $ids.Add(${root})`,
			"do { $n = $ids.Count; foreach ($x in $p) { if ($ids.Contains($x.ParentProcessId)) { $null = $ids.Add($x.ProcessId) } } } while ($n -lt $ids.Count)",
			"$tree = @(Get-Process -Id ([int[]] @($ids)) -ErrorAction SilentlyContinue | Sort-Object Id | Select-Object Id, ProcessName, PrivateMemorySize64)",
			"ConvertTo-Json -InputObject $tree -Compress",
		].join("; "),
	);
}

function status(page, text) {
	return page.waitForFunction((value) => document.querySelector("#run-status").textContent === value, text);
}

async function canStart(page) {
	await page.waitForFunction(() => !document.querySelector("#start").disabled);
}

async function checkInitial(page) {
	assert.equal(await page.locator("h1").textContent(), "本地隔离演示");
	assert(await page.locator("#start").isEnabled());
	const surface = await page.evaluate(async () => {
		const preview = window.flowerPreview;
		const a = await Promise.allSettled([
			preview.history("C:\\Windows\\win.ini"),
			preview.submit("../package.json", "summary"),
			preview.submit("orders", "unknown"),
		]);
		return { boundary: a.map((item) => item.status), node: typeof window.require };
	});
	assert.deepEqual(surface.boundary, ["rejected", "rejected", "rejected"]);
	assert.equal(surface.node, "undefined");
	await page.locator("#directory").selectOption("服务样例");
	await page.locator("#file").selectOption("tickets");
	await page.locator("#directory").selectOption("经营样例");
	await page.locator("#file").selectOption("orders");
	await page.locator("#task").selectOption("summary");
	await page.locator("#start").click();
	await status(page, "正在读取样例文件");
	await page.locator("#cancel").click();
	await status(page, "已取消");
	await page.locator("#retry").click();
	await page.waitForFunction(() => document.querySelector("#output").textContent.includes("金额合计 500"));
	await status(page, "已完成");
	assert.match(await page.locator("#output").textContent(), /A：250\s+B：250/);
	await page.waitForFunction(() => document.querySelector("#history").children.length === 2);
	await page.screenshot({ path: join(evidence, "preview.png") });
	await page.locator("#file").selectOption("refunds");
	await page.waitForFunction(() => !document.querySelector("#empty").hidden);
	assert.equal(await page.locator("#history li").count(), 0);
}

async function checkRestore(page) {
	await page.waitForFunction(() => document.querySelector("#history").children.length === 2);
	assert.match(await page.locator("#history").textContent(), /已完成.*已取消/s);
	assert.match(await page.locator("#output").textContent(), /金额合计 500/);
	await page.locator("#start").click();
	await status(page, "正在读取样例文件");
}

const mib = (bytes) => Number((bytes / 1048576).toFixed(2));
const raw = [];
const checks = [];
for (let i = 0; i < 8; i++) {
	const app = await electron.launch({
		executablePath: exe,
		chromiumSandbox: true,
		args: [`--user-data-dir=${profile}`],
		timeout: 25000,
	});
	const closedIds = [];
	try {
		const page = await app.firstWindow();
		await canStart(page).catch(async (error) => {
			console.error(
				await page.locator("#core-status").textContent(),
				await app.evaluate(() => globalThis.flowerPreviewDiagnostics),
			);
			throw error;
		});
		const info = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
			...globalThis.flowerPreviewDiagnostics,
			visible: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
			profile: electronApp.getPath("userData"),
		}));
		assert.equal(info.profile.toLowerCase(), profile.toLowerCase(), "验收需使用独立资料目录");
		assert(info.visible && info.identity?.runtime === "0.1.0" && info.identity?.pi === "1.6.0");
		assert(info.windowInteractiveMs <= info.childStartedMs && info.childStartedMs < info.coreReadyMs);
		await setTimeout(1000);
		const tree = processTree(info.mainPid);
		closedIds.push(...tree.map(({ Id }) => Id));
		const core = tree.find(({ Id }) => Id === info.identity.pid);
		assert(core && tree.some(({ Id }) => Id === info.mainPid));
		raw.push({
			launch: i + 1,
			windowInteractiveMs: Number(info.windowInteractiveMs.toFixed(2)),
			coreReadyMs: Number(info.coreReadyMs.toFixed(2)),
			forkToCoreMs: Number((info.coreReadyMs - info.childStartedMs).toFixed(2)),
			corePrivateMiB: mib(core.PrivateMemorySize64),
			treePrivateMiB: mib(tree.reduce((sum, item) => sum + item.PrivateMemorySize64, 0)),
			identity: info.identity,
			electron: info.electron,
			tree,
		});
		await writeFile(join(evidence, "samples.json"), JSON.stringify({ hardware, raw, checks }, null, 2));
		if (i === 0) {
			await checkInitial(page);
			checks.push("目录与文件选择、非法路径、流式结果、取消、重试和样例隔离通过");
		}
		if (i === 1) {
			await checkRestore(page);
			checks.push("退出重开恢复取消和完成记录");
		}
		if (i === 2) {
			await page.waitForFunction(() => document.querySelector("#history").children.length === 3);
			assert.match(await page.locator("#history").textContent(), /上次运行已中断/);
			assert.match(await page.locator("#run-status").textContent(), /已中断/);
			checks.push("执行中退出后恢复中断状态，未自动重做");
		}
	} finally {
		await app.close();
	}
	// Windows 允许子进程在主进程退出后的很短时间内收尾。
	await setTimeout(400);
	const remaining = power(
		`@(Get-Process -Id ${closedIds.join(",")} -ErrorAction SilentlyContinue).Count | ConvertTo-Json -Compress`,
	);
	assert.equal(remaining, 0, "关闭后仍有此轮 Electron 进程");
}
checks.push("八轮关闭均未留存应用进程");
await writeFile(join(evidence, "samples.json"), JSON.stringify({ hardware, raw, checks }, null, 2));
console.log(JSON.stringify({ hardware, samples: raw.length, checks }));
