import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// 组件只在使用时调用 DOM 工具，加载时提供同名替身即可测试纯逻辑。
function load() {
	const window = { flowerUI: { element() {}, icon() {}, button() {}, mark() {} } };
	runInNewContext(readFileSync(new URL("../workbench/ui/agent.js", import.meta.url), "utf8"), { window });
	return window.agentUI;
}

test("导航当前轮次：贴底为最后一轮，否则取顶部进入视口上部三分之一的最后一轮", () => {
	const { navigatorTurn } = load();
	assert.equal(navigatorTurn([], 600, false), -1);
	assert.equal(navigatorTurn([], 600, true), -1);
	// 最后一轮很短、顶部仍在阅读线下方时，贴底也视为在读最后一轮。
	assert.equal(navigatorTurn([-900, -300, 500], 600, true), 2);
	assert.equal(navigatorTurn([-900, -300, 500], 600, false), 1);
	// 阅读线为视口高度的三分之一，恰好落在线上的一轮算作当前轮次。
	assert.equal(navigatorTurn([-400, 200, 700], 600, false), 1);
	assert.equal(navigatorTurn([-400, 201, 700], 600, false), 0);
	// 全部轮次都在阅读线下方（如停在顶部留白处）时为第一轮。
	assert.equal(navigatorTurn([250, 700, 1200], 600, false), 0);
	assert.equal(navigatorTurn([-1200, -800, -20], 600, false), 2);
});

test("导航预览：提问取原话或附件名，回复取正文开头，无正文时按状态说明", () => {
	const { turnPreview } = load();
	const plain = (value) => ({ ...value });
	assert.deepEqual(plain(turnPreview({ input: "  汇总\n  三月数据 ", status: "succeeded" }, "已完成汇总。")), {
		title: "汇总 三月数据",
		body: "已完成汇总。",
	});
	assert.deepEqual(
		plain(turnPreview({ input: "", attachments: [{ name: "a.xlsx" }, { name: "b.csv" }], status: "succeeded" }, "")),
		{ title: "a.xlsx、b.csv", body: "" },
	);
	assert.equal(turnPreview({ file: "旧版.xlsx", status: "succeeded" }, "").title, "旧版.xlsx");
	assert.equal(turnPreview({ status: "succeeded" }, "").title, "（无文字）");
	assert.equal(turnPreview({ input: "问", status: "queued" }, "").body, "正在处理…");
	assert.equal(turnPreview({ input: "问", status: "running" }, "  ").body, "正在处理…");
	assert.equal(turnPreview({ input: "问", status: "failed", failure: "网关超时" }, "").body, "网关超时");
	assert.equal(turnPreview({ input: "问", status: "failed" }, "").body, "运行失败");
	assert.equal(turnPreview({ input: "问", status: "cancelled" }, "").body, "已取消");
	assert.equal(turnPreview({ input: "问", status: "interrupted" }, "").body, "上次运行已中断");
	assert.equal(turnPreview({ input: "问", status: "denied" }, "").body, "未获授权");
	// 已有部分正文时优先显示正文，失败原因由消息本身展示。
	assert.equal(turnPreview({ input: "问", status: "failed", failure: "网关超时" }, "部分结果").body, "部分结果");
	// 正文压缩空白后按码点截取前 160 个字符，不切开表情。
	const long = `${"表".repeat(150)}\n\n  ${"😀".repeat(20)}`;
	const body = turnPreview({ input: "问", status: "succeeded" }, long).body;
	assert.equal(Array.from(body).length, 160);
	assert.equal(body, `${"表".repeat(150)} ${"😀".repeat(9)}`);
});
