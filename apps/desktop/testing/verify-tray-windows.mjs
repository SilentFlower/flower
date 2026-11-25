import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { startMockModel } from "./mock-model.mjs";

const [rootArg, playwrightPath] = process.argv.slice(2);
assert(rootArg && process.platform === "win32", "请指定受管理的 Windows 测试安装目录");
const { _electron: electron } = createRequire(import.meta.url)(playwrightPath || "playwright-core");
const root = resolve(rootArg);
const version = (await readFile(join(root, "current.txt"), "utf8")).trim();
const exe = join(root, "versions", version, "Flower Desktop.exe");
const icon = await readFile(join(root, "versions", version, "resources", "flower.ico"));
for (const binary of [exe, join(root, "Flower Desktop.exe")]) {
	const contents = await readFile(binary);
	for (let i = 0; i < icon.readUInt16LE(4); i++) {
		const entry = 6 + 16 * i;
		const offset = icon.readUInt32LE(entry + 12);
		assert(contents.includes(icon.subarray(offset, offset + icon.readUInt32LE(entry + 8))), "运行文件缺少品牌图标资源");
	}
}
const scratch = await mkdtemp(join(await realpath(tmpdir()), "flower-tray-"));
const profile = join(scratch, "profile");
const workspace = join(scratch, "中文工作区");
const reply = "后台任务已完成。";
const pendingReply = Promise.withResolvers();
const fixture = await startMockModel({
	attachmentReply: async () => {
		await pendingReply.promise;
		return { text: reply };
	},
});
let client;

/**
 * 在启动时读取原生托盘和菜单，供隔离桌面触发回调。应用进程启动任务以后不再遍历堆。
 * @param {import("playwright-core").ElectronApplication} client 已启动的真实发行程序
 * @returns {Promise<void>} 已找到工作台的托盘及菜单
 */
async function captureTray(client) {
	await client.evaluate(async ({ Tray, Menu }) => {
		const { Session } = process.getBuiltinModule("node:inspector");
		const session = new Session();
		session.connect();
		const send = (method, params) =>
			new Promise((resolve, reject) =>
				session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))),
			);
		const group = { objectGroup: "flower-tray-test" };
		globalThis.flowerTrayTypes = { Tray, Menu };
		const capture = async (type, select) => {
			const { result } = await send("Runtime.evaluate", {
				expression: `globalThis.flowerTrayTypes.${type}.prototype`,
				...group,
			});
			const { objects } = await send("Runtime.queryObjects", { prototypeObjectId: result.objectId, ...group });
			const found = await send("Runtime.callFunctionOn", {
				objectId: objects.objectId,
				functionDeclaration: select.toString(),
				returnByValue: true,
			});
			if (found.result.value !== true) throw new Error(`未找到原生 ${type}`);
		};
		try {
			await capture("Tray", function () {
				globalThis.flowerTestTray = this.find((tray) => tray.listenerCount?.("click") > 0);
				return !!globalThis.flowerTestTray;
			});
			await capture("Menu", function () {
				globalThis.flowerTestMenu = this.find((menu) => menu.items?.some((item) => item.label === "退出 Flower"));
				return !!globalThis.flowerTestMenu;
			});
		} finally {
			delete globalThis.flowerTrayTypes;
			await send("Runtime.releaseObjectGroup", group);
			session.disconnect();
		}
	});
}

/**
 * 触发原生菜单项或托盘左键回调。
 * @param {string} action 菜单文案或 click
 * @returns {Promise<void>} 已派发对应操作
 */
async function trayAction(action) {
	await client.evaluate((_, action) => {
		if (action === "click") globalThis.flowerTestTray.emit("click");
		else {
			const item = globalThis.flowerTestMenu.items.find((item) => item.label === action);
			if (!item) throw new Error(`托盘菜单缺少 ${action}`);
			setImmediate(() => item.click());
		}
	}, action);
}

async function until(check, message) {
	const deadline = Date.now() + 45000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(message);
		await delay(120);
	}
}

try {
	await mkdir(workspace);
	client = await electron.launch({
		executablePath: exe,
		args: [`--user-data-dir=${profile}`],
		chromiumSandbox: true,
		timeout: 45000,
	});
	const page = await client.firstWindow();
	await captureTray(client);
	const visible = () => client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
	const hide = async () => {
		await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
		assert.equal(await visible(), false);
	};
	await page.waitForFunction(async () => (await window.flower?.state())?.ready);
	assert.equal((await page.evaluate(() => window.flower.desktopUpdateState())).trayAvailable, true);
	await client.evaluate(({ dialog }, dir) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
		globalThis.flowerTrayExitPrompts = 0;
		dialog.showMessageBox = async () => {
			globalThis.flowerTrayExitPrompts++;
			return { response: 1 };
		};
	}, workspace);
	await page.evaluate(
		(baseUrl) => window.flower.saveModel({ serviceId: "", modelId: "local-test", apiKey: "", baseUrl }),
		fixture.baseUrl,
	);
	const session = await page.evaluate(() => window.flower.chooseWorkspace());
	const sent = await page.evaluate((id) => window.flower.submit(id, "请在后台继续处理", true), session);
	await until(() => fixture.observations.model.some((entry) => entry.model === "local-test"), "未开始模型请求");
	await hide();
	await trayAction("退出 Flower");
	await until(() => client.evaluate(() => globalThis.flowerTrayExitPrompts === 1), "显式退出未询问未完成任务");
	assert(await visible());
	await hide();
	pendingReply.resolve();
	await until(
		async () =>
			(await page.evaluate((id) => window.flower.history(id), session)).some(
				(turn) => turn.requestId === sent.requestId && turn.status === "succeeded" && turn.text === reply,
			),
		"隐藏窗口时任务未完成",
	);
	assert.equal(await visible(), false);
	await trayAction("click");
	assert(await visible());
	await hide();
	await trayAction("打开 Flower Desktop");
	await until(visible, "托盘菜单未恢复窗口");
	await hide();
	await promisify(execFile)(join(root, "Flower Desktop.exe"), [`--user-data-dir=${profile}`]);
	await until(visible, "再次启动未恢复已有窗口");
	await hide();
	const closed = client.waitForEvent("close", { timeout: 30000 });
	await Promise.all([
		closed,
		trayAction("退出 Flower").catch((error) => {
			if (!String(error).includes("has been closed")) throw error;
		}),
	]);
	client = undefined;
	console.log(`Windows ${version} 主程序和启动器图标、后台任务、取消退出、托盘恢复、重复启动及退出通过`);
} finally {
	pendingReply.resolve();
	await client
		?.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({ response: 0 });
		})
		.catch(() => {});
	await client?.close().catch(() => {});
	await fixture.close();
	await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}
