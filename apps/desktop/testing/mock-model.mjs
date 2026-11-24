import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";

const token = () => randomBytes(32).toString("hex");

/** 启动只用于验收的 OpenAI 兼容回环模型。
 * @param options 测试模型、发现清单、可选 Key 和工具调用控制
 * @returns 地址、调用记录和关闭操作
 */
export async function startMockModel({
	model = "local-test",
	alternatives = [],
	discover = true,
	apiKey,
	beforePermissionTool,
	attachmentReply,
	effortByModel = new Map(),
} = {}) {
	const models = [model, ...alternatives];
	const observations = { model: [], discovery: [], attempts: [], requestFields: [], interrupted: 0 };
	let origin;
	const server = createServer(async (req, res) => {
		try {
			const path = new URL(req.url, origin).pathname;
			const expectedKey = typeof apiKey === "function" ? apiKey() : apiKey;
			const tokenMatches = req.headers.authorization === (expectedKey ? `Bearer ${expectedKey}` : undefined);
			if (req.method === "GET" && path === "/compatible/v1/models") {
				observations.discovery.push({ hasAuthorization: Boolean(req.headers.authorization), tokenMatches });
				if (!tokenMatches || !discover) {
					res.writeHead(tokenMatches ? 404 : 401).end();
					return;
				}
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						data: models.map((id) => ({
							id,
							effort: effortByModel.has(id) ? { supported_levels: effortByModel.get(id) } : undefined,
						})),
					}),
				);
				return;
			}
			if (req.method !== "POST" || path !== "/compatible/v1/chat/completions") {
				res.writeHead(404).end();
				return;
			}
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const input = JSON.parse(Buffer.concat(chunks));
			observations.requestFields.push({
				path,
				model: input.model,
				keys: Object.keys(input).sort(),
				reasoning: input.reasoning_effort,
				hasAnthropicHeaders: Boolean(req.headers["anthropic-version"] || req.headers["x-api-key"]),
				tokenMatches,
			});
			observations.attempts.push({
				model: input.model,
				hasAuthorization: Boolean(req.headers.authorization),
				tokenMatches,
				reasoning: input.reasoning_effort ?? null,
				thinking: input.thinking?.type ?? null,
			});
			if (!models.includes(input.model) || !tokenMatches) {
				res.writeHead(401).end();
				return;
			}
			const messages = input.messages;
			const last = messages.at(-1);
			const userInput = messages.findLast((item) => item.role === "user")?.content;
			const prompt = typeof userInput === "string" ? userInput : JSON.stringify(userInput);
			observations.model.push({
				model: input.model,
				tool: last.role,
				hasAuthorization: Boolean(req.headers.authorization),
				tokenMatches,
			});
			const sse = (delta, finish_reason = null) =>
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-flower-fixture",
						object: "chat.completion.chunk",
						created: 1790000000,
						model: input.model,
						choices: [{ index: 0, delta, finish_reason }],
					})}\n\n`,
				);
			const tool = (name, args) => {
				sse({
					role: "assistant",
					tool_calls: [
						{ index: 0, id: `call_${token()}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
					],
				});
				sse({}, "tool_calls");
			};
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const filename = "orders.xlsx";
			if (attachmentReply) {
				const answer = attachmentReply(messages);
				if (answer.toolCall) tool(answer.toolCall.name, answer.toolCall.args);
				else if (answer.markdown) tool("write_report", { markdown: answer.markdown, input: answer.source });
				else {
					sse({ role: "assistant", content: answer.text });
					sse({}, "stop");
				}
				res.end("data: [DONE]\n\n");
				return;
			}
			if (prompt.includes("取消用例")) {
				res.once("close", () => {
					observations.interrupted++;
				});
				sse({ role: "assistant", content: "准备处理" });
				return;
			}
			if (prompt.includes("延续刚才的会话")) {
				const previous = messages.some((message) => message.role === "tool" && message.content.includes("核对库存清单"));
				sse({ role: "assistant", content: previous ? "沿用上一轮：核对库存清单。" : "缺少前一轮上下文。" });
				sse({}, "stop");
			} else if (prompt.includes("权限验收")) {
				const toolCount = messages
					.slice(messages.findLastIndex(({ role }) => role === "user") + 1)
					.filter(({ role }) => role === "tool").length;
				if (last.role !== "tool" || (prompt.includes("双次写入") && toolCount === 1)) {
					if (beforePermissionTool) await beforePermissionTool(prompt);
					if (prompt.includes("读取目录")) tool("list_workspace", { directory: "." });
					else if (prompt.includes("读取文本")) tool("read_text_file", { path: "notes.txt" });
					else
						tool("analyze_excel", {
							path: filename,
							sheet: "订单",
							groupColumn: "部门",
							valueColumn: "金额",
							createOutputs: !prompt.includes("只读汇总"),
						});
				} else {
					sse({ role: "assistant", content: `工具回执：${last.content}` });
					sse({}, "stop");
				}
			} else if (prompt.includes("notes.txt")) {
				if (last.role !== "tool") tool("read_text_file", { path: "notes.txt" });
				else {
					const known = last.content.includes("核对库存清单");
					sse({ role: "assistant", content: known ? "行动项：核对库存清单。" : "未读到约定的行动项。" });
					sse({}, "stop");
				}
			} else if (last.role !== "tool") tool("inspect_excel", { path: filename });
			else if (last.content.includes('"preview"'))
				tool("analyze_excel", {
					path: filename,
					sheet: "订单",
					groupColumn: "部门",
					valueColumn: "金额",
					createOutputs: true,
				});
			else {
				sse({ role: "assistant", content: "正在整理汇总结果…" });
				// 给实机验收留出可观察的流式执行阶段。
				await setTimeout(4500);
				if (res.destroyed) return;
				sse({ content: "\n\n分析完成。合计 500。" });
				sse({ content: "请查看分析报告和汇总工作簿。" });
				sse({}, "stop");
			}
			res.end("data: [DONE]\n\n");
			return;
		} catch {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	origin = `http://127.0.0.1:${server.address().port}`;
	return {
		baseUrl: `${origin}/compatible/v1`,
		modelId: model,
		observations,
		close() {
			server.closeAllConnections();
			return new Promise((resolve) => server.close(resolve));
		},
	};
}
