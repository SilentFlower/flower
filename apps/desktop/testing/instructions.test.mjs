import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchDesktop } from "./desktop-harness.mjs";
import { startMockModel } from "./mock-model.mjs";

function text(message) {
	return typeof message.content === "string"
		? message.content
		: (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

test("全局指令与工作区 FLOWER.md 依次附加在系统提示之后，侧边追问同样适用", { timeout: 60000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "flower-instructions-"));
	const workspace = join(root, "工作区");
	await mkdir(workspace);
	const systems = [];
	const fixture = await startMockModel({
		attachmentReply(messages) {
			systems.push(text(messages.find(({ role }) => role === "system") ?? { content: "" }));
			return { text: "已按口径回答。" };
		},
	});
	const desktop = await launchDesktop(root);
	t.after(async () => {
		await desktop.close();
		await fixture.close();
		await rm(root, { recursive: true, force: true });
	});
	const { api } = desktop;
	await desktop.state((state) => state.ready);
	await api.saveModel({
		serviceId: "",
		name: "回环夹具",
		baseUrl: fixture.baseUrl,
		modelId: "local-test",
		apiKey: "",
		// 8000 字的 FLOWER.md 本身约 8000 token，窗口需留出余量。
		capability: { mode: "none", contextWindow: "65536", levels: [] },
	});
	desktop.choose(workspace);
	const id = await api.chooseWorkspace();
	const ask = async (input) => {
		const { requestId } = await api.submit(id, input);
		const terminal = await desktop.event((event) => event.requestId === requestId && event.type === "terminal");
		assert.equal(terminal.status, "succeeded", terminal.failure?.message);
		return systems.at(-1);
	};

	// 交付卡片元信息只读当前会话工作区内符合产物格式的路径。
	await assert.rejects(api.artifactInfo(id, "FLOWER.md"), /不属于可打开的分析产物/);

	// 未设置时系统提示不含口径段落，详情卡没有口径信息。
	assert.doesNotMatch(await ask("第一问"), /口径偏好/);
	assert.deepEqual((await api.contextUsage(id)).instructions, { personal: false });

	await assert.rejects(api.saveInstructions("长".repeat(4001)), /最多 4000 字/);
	await api.saveInstructions("  金额保留两位小数。  ");
	assert.equal((await api.state()).instructions, "金额保留两位小数。");
	await writeFile(join(workspace, "FLOWER.md"), "# 采购部口径\n\n部门名称用全称。");
	const both = await ask("第二问");
	assert.match(
		both,
		/口径偏好[\s\S]*【个人全局指令】\n金额保留两位小数。[\s\S]*【工作区约定（FLOWER\.md）】\n# 采购部口径/,
	);
	assert(both.indexOf("【个人全局指令】") < both.indexOf("【工作区约定"));
	assert.deepEqual((await api.contextUsage(id)).instructions, { personal: true, workspace: { truncated: false } });

	// FLOWER.md 超过 8000 字时只读取前 8000 字并注明。
	await writeFile(join(workspace, "FLOWER.md"), `${"甲".repeat(8000)}乙`);
	const long = await ask("第三问");
	assert.match(long, /甲{8000}\n（超过 8000 字的部分未读取）/);
	assert.doesNotMatch(long, /乙/);
	assert.deepEqual((await api.contextUsage(id)).instructions.workspace, { truncated: true });

	// 侧边追问同样附加口径。
	await api.openSideChat(id);
	const { requestId } = await api.submitSideChat(id, "侧边：按口径说明");
	await desktop.event((event) => event.requestId === requestId && event.type === "terminal");
	assert.match(systems.at(-1), /当前是侧边追问[\s\S]*【个人全局指令】[\s\S]*【工作区约定（FLOWER\.md）】/);

	// 清空个人指令、删除 FLOWER.md 后不再附加。
	await api.saveInstructions("");
	await rm(join(workspace, "FLOWER.md"));
	assert.doesNotMatch(await ask("第四问"), /口径偏好/);

	// 重启后个人指令随初始化下发。
	await api.saveInstructions("结论写在开头。");
	await desktop.restart();
	await desktop.state((state) => state.ready);
	// 侧边追问随 workbench.json 保留到用户关闭。
	assert.equal((await api.state()).sideChats.length, 1);
	assert.match(await ask("重启后提问"), /【个人全局指令】\n结论写在开头。/);
});
