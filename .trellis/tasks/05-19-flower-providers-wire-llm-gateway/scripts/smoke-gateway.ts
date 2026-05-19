/**
 * Step 11 — 端到端真实网关验证脚本(AC7)
 *
 * 对 4 个 provider 各跑 1 次 streamSimple,验证:
 *   - havefun-anthropic    + claude-opus-4-7
 *   - havefun-gemini       + gemini-2.5-flash
 *   - havefun-openai-responses + gpt-5.5(关键:网关漏报但实际支持)
 *   - havefun-openai       + grok-4.20-fast(extras 路径)
 *
 * 用法(运行前确保 LLM_API_KEY 已注入,**不**进 git):
 *
 *   export LLM_BASE_URL=https://jp-ai.havefun.eu.cc
 *   export LLM_API_KEY=<真实 key>
 *   export LLM_EXTRA_MODELS_JSON='[{"id":"grok-4.20-fast","nativeApi":"openai-completions"}]'
 *   npx tsx .trellis/tasks/05-19-flower-providers-wire-llm-gateway/scripts/smoke-gateway.ts
 *
 * 脚本会对每个 provider 打印第一个 chunk 的前 100 字符,不打印 apiKey。
 * 任务收尾时此脚本**留在 task workspace 不 commit 到 packages/**。
 */

import { streamSimple } from "@earendil-works/pi-ai";
import { buildHavefunModel, type ProviderName } from "@flower-ai/flower-providers";

interface SmokeCase {
	provider: ProviderName;
	modelId: string;
	label: string;
}

const CASES: SmokeCase[] = [
	{ provider: "havefun-anthropic", modelId: "claude-opus-4-7", label: "Claude Opus" },
	{ provider: "havefun-gemini", modelId: "gemini-2.5-flash", label: "Gemini Flash" },
	{ provider: "havefun-openai-responses", modelId: "gpt-5.5", label: "GPT-5.5 (response)" },
	{ provider: "havefun-openai-responses", modelId: "gpt-5.4", label: "GPT-5.4 (response)" },
	{ provider: "havefun-openai", modelId: "grok-4.20-fast", label: "Grok 4.20 (openai extras)" },
];

const PROMPT = "用一句话介绍你自己。回答不超过 30 字。";

async function runCase(c: SmokeCase): Promise<void> {
	const model = buildHavefunModel(c.provider, c.modelId);
	const apiKey = process.env.LLM_API_KEY;
	if (!apiKey) {
		throw new Error("缺少 LLM_API_KEY env");
	}

	console.log(`\n=== ${c.label} (${c.provider} / ${c.modelId}) ===`);
	try {
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: PROMPT, timestamp: Date.now() }] },
			{ apiKey, maxTokens: 200 },
		);

		let collected = "";
		for await (const ev of stream) {
			if (ev.type === "text_delta") {
				collected += ev.delta;
				if (collected.length >= 100) break;
			}
			if (ev.type === "done") {
				const lastText = ev.message.content.find((c) => c.type === "text");
				if (lastText && lastText.type === "text") collected = lastText.text;
				break;
			}
			if (ev.type === "error") {
				throw new Error(`provider error: ${ev.error.errorMessage ?? "(unknown)"}`);
			}
		}
		console.log(`  ✓ 收到响应(前 100 字符):${collected.slice(0, 100)}...`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`  ✗ 失败:${msg}`);
		throw err;
	}
}

async function main() {
	for (const c of CASES) {
		await runCase(c);
	}
	console.log(`\n[smoke] AC7 完成:${CASES.length} 个 case 全部拿到真实响应。`);
}

main().catch((err) => {
	console.error("\n[smoke] 失败,详情见上文。");
	console.error(err);
	process.exit(1);
});
