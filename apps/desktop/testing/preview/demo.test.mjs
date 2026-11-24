import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDemo, readSample } from "./demo.mjs";

test("样例白名单、实际只读工具、流式结果及取消恢复", async (t) => {
	const folder = await mkdtemp(join(tmpdir(), "flower-desktop-test-"));
	t.after(() => rm(folder, { recursive: true, force: true }));
	await assert.rejects(readSample("../package.json"), /内置样例/);
	await assert.rejects(readSample("C:\\Windows\\win.ini"), /内置样例/);
	assert.match(await readSample("orders"), /A,150/);
	const events = [];
	let observe;
	const receiver = (event) => {
		events.push(event);
		observe?.(event);
	};
	const wait = (match) =>
		new Promise((done) => {
			observe = (event) => {
				if (match(event)) done(event);
			};
		});
	const app = createDemo(folder, receiver);
	assert.throws(() => app.submit("orders", "arbitrary"), /样例和任务/);
	await assert.rejects(app.history("unknown"), /内置样例/);
	const reading = wait(({ type }) => type === "tool_started");
	const cancelledRequest = await app.submit("orders", "summary");
	const started = await reading;
	const cancelled = wait(({ type }) => type === "terminal");
	await app.cancel("orders", cancelledRequest.requestId, started.runId);
	assert.equal((await cancelled).status, "cancelled");
	const completed = wait(({ type }) => type === "terminal");
	await app.submit("orders", "summary");
	assert.equal((await completed).status, "succeeded");
	assert(events.filter(({ type }) => type === "text_delta").length >= 3);
	assert(events.some(({ type }) => type === "tool_result"));
	const recovered = createDemo(folder, () => assert.fail("读历史触发了运行事件"));
	const orders = await recovered.history("orders");
	assert.deepEqual(
		orders.map(({ status }) => status),
		["cancelled", "succeeded"],
	);
	assert.match(orders[1].text, /金额合计 500/);
	assert.match(orders[1].text, /A：250/);
	assert.deepEqual(await recovered.history("refunds"), []);
	const rawDone = wait(({ type }) => type === "terminal");
	await app.submit("refunds", "preview");
	assert.equal((await rawDone).status, "succeeded");
	assert.match((await app.history("refunds"))[0].text, /A,15/);
});
