import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";

export const proxyScenarios = ["proxy-settings", "proxy-bypass", "proxy-explicit", "proxy-idle", "proxy-invalid"];

async function listen(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return server.address().port;
}

/** 仅向该次测试创建的回环服务建立隧道，并记录实际抵达服务的 socket。 */
async function listenProxy(ports, tunnels, connections, name) {
	const server = createServer((_req, res) => {
		res.writeHead(405).end();
	});
	const sockets = new Set();
	server.on("connect", (req, client, head) => {
		const port = Number(req.url?.split(":").at(-1));
		if (!ports.has(port) || req.url !== `127.0.0.1:${port}`) {
			client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		const upstream = connect(port, "127.0.0.1");
		for (const socket of [client, upstream]) {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		}
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
		client.once("close", () => upstream.destroy());
		upstream.once("close", () => client.destroy());
		upstream.once("connect", () => {
			connections.push({ proxy: name, port });
			tunnels.set(`${port}:${upstream.localPort}`, name);
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream).pipe(client);
		});
	});
	const port = await listen(server);
	return {
		url: `http://127.0.0.1:${port}`,
		close() {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}

/**
 * 给真实 reviewer CLI 准备代理、局部绕过规则和用户扩展探针。
 * @param options 用例、本地服务地址及临时目录
 * @returns 子进程环境、HTTP 观测和验收函数
 */
export async function createProxyFixture({ scenario, originUrl, observerUrl, runRoot, agentDir }) {
	const ports = new Set([Number(new URL(originUrl).port)]);
	const tunnels = new Map();
	const connections = [];
	const requests = [];
	const capture = (req) => {
		const { localPort, remotePort } = req.socket;
		const proxy = tunnels.get(`${localPort}:${remotePort}`) ?? "direct";
		requests.push({ path: req.url, proxy });
	};
	if (scenario === "proxy-invalid") {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ httpProxy: "synthetic-proxy-secret@" }));
		return {
			env: {},
			capture,
			serveIdleProbe: () => false,
			close() {},
			verify(output) {
				assert.match(output, /HTTP 代理配置无效/);
				assert.doesNotMatch(output, /synthetic-proxy-secret/);
				assert.deepEqual(requests, []);
				return { requests, connections };
			},
		};
	}

	let tls;
	let ca;
	let httpsUrl;
	if (scenario === "proxy-explicit") {
		// 证书仅用于这次合成请求，以本次 CA 校验 TLS。
		ca = join(runRoot, "tls-cert.pem");
		const key = join(runRoot, "tls-key.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
				"-keyout",
				key,
				"-out",
				ca,
			],
			{ stdio: "ignore" },
		);
		tls = createHttpsServer({ cert: await readFile(ca), key: await readFile(key) }, (req, res) => {
			capture(req);
			res.end("HTTPS 本地探针");
		});
		const port = await listen(tls);
		ports.add(port);
		httpsUrl = `https://127.0.0.1:${port}/probe-https`;
	}
	const configured = await listenProxy(ports, tunnels, connections, "settings");
	const explicitHttp = httpsUrl ? await listenProxy(ports, tunnels, connections, "http-env") : undefined;
	const explicitHttps = httpsUrl ? await listenProxy(ports, tunnels, connections, "https-env") : undefined;
	const noProxy = [new URL(observerUrl).host];
	if (scenario === "proxy-bypass") noProxy.push(new URL(originUrl).host);
	const httpProxy = explicitHttp?.url ?? configured.url;
	const httpsProxy = explicitHttps?.url ?? configured.url;
	const idle = scenario === "proxy-idle";
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			httpProxy: `  ${configured.url}  `,
			...(idle ? { httpIdleTimeoutMs: 400 } : {}),
		}),
	);
	await writeFile(
		join(agentDir, "extensions/probe.ts"),
		`export default function (pi) {
		console.log("FLOWER-DISCOVERY-USER");
		pi.on("session_start", async () => {
			console.log("FLOWER-PROXY-MATCH",
				process.env.HTTP_PROXY === ${JSON.stringify(httpProxy)} && process.env.HTTPS_PROXY === ${JSON.stringify(httpsProxy)});
			${httpsUrl ? `console.log("FLOWER-PROXY-HTTPS", await (await fetch(${JSON.stringify(httpsUrl)})).text());` : ""}
			${
				idle
					? `for (const phase of ["headers", "body"]) {
				try { await (await fetch(${JSON.stringify(`${originUrl}/probe-idle/`)} + phase)).text(); }
				catch (error) { console.log("FLOWER-PROXY-IDLE", phase, error.cause?.code); }
			}`
					: ""
			}
		});
	}`,
	);
	return {
		env: {
			NO_PROXY: noProxy.join(","),
			...(explicitHttp ? { HTTP_PROXY: httpProxy, HTTPS_PROXY: httpsProxy, NODE_EXTRA_CA_CERTS: ca } : {}),
		},
		capture,
		serveIdleProbe(path, res) {
			if (!idle || !path.startsWith("/probe-idle/")) return false;
			if (path.endsWith("/body")) {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.write("首块");
			}
			return true;
		},
		close() {
			configured.close();
			explicitHttp?.close();
			explicitHttps?.close();
			tls?.closeAllConnections();
			tls?.close();
		},
		verify(output) {
			assert.match(output, /FLOWER-PROXY-MATCH true/);
			const route = explicitHttp ? "http-env" : scenario === "proxy-bypass" ? "direct" : "settings";
			assert(requests.some(({ path }) => path === "/api/v4/version"));
			assert(requests.some(({ path }) => path === "/v1/chat/completions"));
			assert(requests.some(({ path }) => path.endsWith("/discussions")));
			assert(
				requests.every(({ path, proxy }) => proxy === (path === "/probe-https" ? "https-env" : route)),
				JSON.stringify(requests),
			);
			if (route === "direct") assert.deepEqual(connections, []);
			else assert(connections.length > 0 && connections.every(({ proxy }) => proxy === route || proxy === "https-env"));
			if (httpsUrl) {
				assert.match(output, /FLOWER-PROXY-HTTPS HTTPS 本地探针/);
				assert(requests.some(({ path }) => path === "/probe-https"));
			}
			if (idle) {
				assert.match(output, /FLOWER-PROXY-IDLE headers UND_ERR_HEADERS_TIMEOUT/);
				assert.match(output, /FLOWER-PROXY-IDLE body UND_ERR_BODY_TIMEOUT/);
			}
			return { requests, connections };
		},
	};
}
