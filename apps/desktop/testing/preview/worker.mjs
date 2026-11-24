import { createDemo, runtimeIdentity } from "./demo.mjs";

const port = process.parentPort;
const protocol = 1;
let demo;
port.on("message", async ({ data: frame }) => {
	if (!frame || frame.protocol !== protocol || typeof frame.id !== "string") return;
	try {
		let value;
		switch (frame.type) {
			case "init":
				if (demo || typeof frame.directory !== "string") throw new Error();
				demo = createDemo(frame.directory, (event) => port.postMessage({ protocol, kind: "event", event }));
				value = await runtimeIdentity();
				break;
			case "history":
				value = await demo.history(frame.sample);
				break;
			case "submit":
				value = await demo.submit(frame.sample, frame.task);
				break;
			case "cancel":
				value = await demo.cancel(frame.sample, frame.requestId, frame.runId);
				break;
			default:
				throw new Error();
		}
		port.postMessage({ protocol, kind: "response", id: frame.id, value });
	} catch {
		port.postMessage({ protocol, kind: "response", id: frame.id, error: "操作失败，请检查样例或重启预览。" });
	}
});
