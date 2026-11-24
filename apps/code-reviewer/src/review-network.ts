import { EventEmitter } from "node:events";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Client, type Dispatcher, EnvHttpProxyAgent, install, Pool, setGlobalDispatcher } from "undici";

/** pi 1.6.0 在可信设置加载前使用的 HTTP 空闲时限。 */
export const REVIEW_HTTP_BOOTSTRAP_IDLE_MS = 300_000;

const originalFetch = globalThis.fetch;
let installedFetch: typeof globalThis.fetch | undefined;

function handleDispatcherErrors<T extends Dispatcher>(dispatcher: T): T {
	// 流中止仍由 fetch 读端感知，避免错误事件另外终止进程。
	if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", () => {});
	return dispatcher;
}

function createClient(origin: string | URL, options: Client.Options): Client {
	return handleDispatcherErrors(new Client(origin, options));
}

/**
 * 给一次性 reviewer 进程安装与 pi print 兼容的 HTTP 配置。
 * @param settings pi 设置，代理只读取用户级配置
 * @param idleTimeoutMs 引导阶段可传默认值，可信设置加载后使用有效配置
 */
export function configureReviewHttp(settings: SettingsManager, idleTimeoutMs = settings.getHttpIdleTimeoutMs()): void {
	const configuredProxy = settings.getGlobalSettings().httpProxy;
	if (configuredProxy != null && typeof configuredProxy !== "string") {
		throw new Error("HTTP 代理配置无效，评审已停止");
	}
	const proxy = configuredProxy?.trim();
	if (proxy) {
		process.env.HTTP_PROXY ??= proxy;
		process.env.HTTPS_PROXY ??= proxy;
	}
	let dispatcher: EnvHttpProxyAgent;
	try {
		dispatcher = handleDispatcherErrors(
			new EnvHttpProxyAgent({
				allowH2: false,
				proxyTunnel: true,
				bodyTimeout: idleTimeoutMs,
				headersTimeout: idleTimeoutMs,
				connect: { autoSelectFamilyAttemptTimeout: 2_000 },
				clientFactory: createClient,
				factory(origin, options: Pool.Options) {
					return options.connections === 1
						? createClient(origin, options)
						: handleDispatcherErrors(new Pool(origin, { ...options, factory: createClient }));
				},
			}),
		);
	} catch {
		// 代理 URL 可能含凭据，配置错误不应把原始值带入日志。
		throw new Error("HTTP 代理配置无效，评审已停止");
	}
	setGlobalDispatcher(dispatcher);

	// fetch 与 dispatcher 来自同一 Undici 版本，保留宿主主动替换的 fetch。
	if (globalThis.fetch === (installedFetch ?? originalFetch)) {
		install();
		installedFetch = globalThis.fetch;
	}
}
