import { RuntimeError } from "@flower-ai/agent-runtime";
import {
	buildIdentity,
	createFixtureHost,
	employee,
	protocolVersion,
} from "../../../packages/agent-runtime/test/fixtures/host.mjs";

if (!process.send || !process.argv[2]) throw new Error("桌面验证进程需要父进程 IPC 和临时目录");

const fixture = createFixtureHost({
	directory: process.argv[2],
	name: "desktop-node",
	probeOperations: process.argv[3] === "--operation-probe",
	onEvent: (_subject, event) => send({ kind: "event", event }),
	onProbe: (_subject, probe) => send({ kind: "probe", probe }),
});
const client = fixture.client(employee);

/** 通过专用进程通道发送验证帧。 */
function send(frame, onSent) {
	if (process.connected) process.send(frame, onSent ?? (() => {}));
}

/** 校验帧后执行受控测试主体的请求。 */
async function handle(frame) {
	const { type, sessionId } = frame;
	if (type === "stats") return fixture.stats();
	if (type === "shutdown") return undefined;
	if (typeof sessionId !== "string" || !sessionId.trim()) {
		throw new RuntimeError("invalid-input", "会话标识无效");
	}
	switch (type) {
		case "submit":
			return client.submit(sessionId, frame.input);
		case "cancelQueued":
			return client.cancelQueued(sessionId, frame.requestId);
		case "cancelRunning":
			return client.cancelRunning(sessionId, frame.runId);
		case "query":
			return client.getSession(sessionId);
		case "holdRead":
			return fixture.holdRead(employee, sessionId);
		case "releaseRead":
			return fixture.releaseRead(employee, sessionId);
		default:
			throw new RuntimeError("invalid-input", "未知的验证命令");
	}
}

process.on("message", async (frame) => {
	if (!frame || typeof frame !== "object" || typeof frame.id !== "string") return;
	try {
		if (frame.protocolVersion !== protocolVersion || "subject" in frame || "workspace" in frame) {
			throw new RuntimeError("invalid-input", "IPC 版本或宿主边界无效");
		}
		const value = await handle(frame);
		const response = { kind: "response", id: frame.id, ok: true, value };
		if (frame.type === "shutdown") send(response, () => process.disconnect());
		else send(response);
	} catch (error) {
		const failure =
			error instanceof RuntimeError
				? { code: error.code, message: error.message }
				: { code: "agent-error", message: "验证命令执行失败" };
		send({ kind: "response", id: frame.id, ok: false, failure });
	}
});

send({ kind: "ready", ...(await buildIdentity(import.meta.resolve("@flower-ai/agent-runtime"))) });
