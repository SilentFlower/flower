import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAutomation, latestScheduleSlot } from "../workbench/automation.mjs";
import { mergeBackground, recentBackground, summarizeBackground } from "../workbench/background-tasks.mjs";
import { launchDesktop } from "./desktop-harness.mjs";
import { startMockModel } from "./mock-model.mjs";

async function until(check) {
	for (let i = 0; i < 200; i++) {
		const result = await check();
		if (result) return result;
		await delay(30);
	}
	throw new Error("等待操作收尾超时。");
}

const plan = {
	title: "汇总资料",
	workspaceId: "a",
	prompt: "检查工作区",
	frequency: "daily",
	time: "12:01",
	weekday: 0,
	writeMode: "read",
};

test("定时任务按本地日周时刻启动，在窗口内并发扫描也只派发一次", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "flower-automation-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let now = +new Date(2026, 5, 3, 12, 0, 50);
	let ready = true;
	const launched = [];
	const options = {
		path: join(directory, "automation.json"),
		clock: () => now,
		workspace(id) {
			assert.equal(id, "a");
		},
		available: () => ready,
		async launch(run) {
			launched.push(run);
			return { requestId: "request" };
		},
		async abort() {},
		async recover() {},
		changed() {},
	};
	const first = createAutomation(options);
	const id = await first.savePlan(undefined, plan);
	assert.equal(
		latestScheduleSlot({ ...plan, frequency: "weekly", weekday: 3 }, +new Date(2026, 5, 4, 12)).at,
		+new Date(2026, 5, 3, 12, 1),
	);
	await first.tick();
	assert.deepEqual(launched, []);
	now += 15_000;
	await Promise.all([first.tick(), first.tick()]);
	assert.equal((await first.view()).runs[0]?.status, "running");
	assert.equal(launched.length, 1);
	const original = (await first.view()).runs[0];
	await first.finish(original.id, "succeeded", "检查通过", "request");
	first.close();
	now += 2 * 86400000;
	const second = createAutomation(options);
	await second.load();
	assert.deepEqual(
		(await second.view()).runs.map(({ status }) => status),
		["missed", "succeeded"],
	);
	await second.tick();
	assert.equal(launched.length, 1);
	ready = false;
	const waiting = await second.runNow(id);
	assert.equal((await second.view()).runs[0].status, "queued");
	await assert.rejects(second.runNow(id), /尚?在运行|仍在运行/);
	await second.cancel(waiting);
	assert.equal((await second.view()).runs[0].status, "cancelled");
	await second.enable(id, false);
	await second.remove(id);
	assert.deepEqual((await second.view()).plans, []);
	assert.equal((await second.view()).runs.length, 3);
	second.close();
});

test("空转收尾时同时扫描和手动入队，无须下一轮定时器即可派发", { timeout: 20000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "flower-automation-wake-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let now = +new Date(2026, 5, 3, 12, 0, 50);
	const starts = [];
	const firstStart = Promise.withResolvers();
	const releaseFirst = Promise.withResolvers();
	const automation = createAutomation({
		path: join(directory, "automation.json"),
		clock: () => now,
		workspace() {},
		available: () => true,
		async launch(run) {
			starts.push(run);
			if (starts.length === 1) {
				firstStart.resolve();
				await releaseFirst.promise;
			}
			return { requestId: run.id };
		},
		async abort() {},
		async recover() {},
		changed() {},
	});
	const scheduled = await automation.savePlan(undefined, plan);
	const manual = await automation.savePlan(undefined, { ...plan, title: "另一项计划", time: "14:30" });
	const empty = automation.drain();
	now += 15_000;
	const tick = automation.tick();
	await firstStart.promise;
	const added = await automation.runNow(manual);
	try {
		assert.equal((await automation.view()).runs.find(({ id }) => id === added)?.status, "queued");
	} finally {
		releaseFirst.resolve();
	}
	await Promise.all([empty, tick]);
	assert.deepEqual(
		starts.map(({ plan }) => plan),
		[scheduled, manual],
	);
	assert.deepEqual(
		(await automation.view()).runs.map(({ status }) => status),
		["running", "running"],
	);
	automation.close();
});

test("任务摘要只显示同一授权工作区，未恢复的在途状态有明确结果", () => {
	const snapshot = {
		requests: [
			{ requestId: "a", workspaceId: "w", status: "running", input: "任务", steps: [{ target: "读取文件" }] },
			{ requestId: "b", workspaceId: "other", status: "succeeded", text: "另一个工作区" },
			{ requestId: "c", workspaceId: "w", status: "running", input: "断线任务" },
		],
	};
	const rows = mergeBackground(summarizeBackground(snapshot), [{ id: "d", input: "待发送", createdAt: 30 }], {
		workspaceId: "w",
		active: new Set(["a"]),
		approvals: new Set(["a"]),
		questions: false,
		paused: true,
	});
	assert.deepEqual(
		recentBackground(rows).map(({ id, status }) => [id, status]),
		[
			["d", "paused"],
			["a", "waiting-write"],
			["c", "interrupted"],
		],
	);
	assert.equal(rows.find(({ id }) => id === "a").progress, "读取文件");
});

test("自动化通过真实宿主与 pi 执行，后台记录关联会话，重启后保留结果", { timeout: 30000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-automation-ipc-"));
	const workspace = join(root, "验收工作区");
	await mkdir(workspace);
	const fixture = await startMockModel({ attachmentReply: () => ({ text: "合成自动化已运行。" }) });
	let desktop = await launchDesktop(root);
	t.after(async () => {
		await desktop.close();
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	});
	await desktop.state((state) => state.ready);
	await desktop.api.saveModel({
		serviceId: "",
		name: "本机回环",
		baseUrl: fixture.baseUrl,
		modelId: fixture.modelId,
		apiKey: "",
	});
	desktop.choose(workspace);
	const selected = await desktop.api.chooseWorkspace();
	const initial = await desktop.api.state();
	const workspaceId = initial.draft.workspaceId;
	const planId = await desktop.api.saveAutomation(undefined, { ...plan, workspaceId, title: "系统检查" });
	const run = await desktop.api.runAutomation(planId);
	await desktop.event((event) => event.type === "terminal" && event.sessionId === run);
	const task = await until(async () =>
		(await desktop.api.backgroundTasks()).find(({ id, status }) => id === run && status === "succeeded"),
	);
	assert.equal(task.session, run);
	assert.equal(task.workspace, "验收工作区");
	assert.match(task.result, /合成自动化/);
	assert.equal((await desktop.api.state()).selected, selected);
	await desktop.api.selectSession(run);
	assert.equal((await desktop.api.history(run))[0].text, "合成自动化已运行。");
	await desktop.close();
	desktop = await launchDesktop(root);
	await desktop.state((state) => state.ready);
	const result = (await desktop.api.backgroundTasks()).find(({ id }) => id === run);
	assert.equal(result.status, "succeeded");
	assert.equal((await desktop.api.automationState()).plans[0].id, planId);
	assert.equal((await desktop.api.automationState()).runs.length, 1);
});
