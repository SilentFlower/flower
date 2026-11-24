import {
	type CreateAgentSessionServicesOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustContext,
	type ProjectTrustEvent,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

type TrustOptions = Pick<CreateAgentSessionServicesOptions, "settingsManager" | "resourceLoaderReloadOptions">;

/**
 * 为 SDK 保留 pi print 的用户级项目信任决定。
 * @param cwd 当前评审 checkout
 * @param agentDir 当前 pi 配置目录
 * @returns 供 SDK 在加载项目资源前使用的信任选项
 */
export function buildPrintTrustOptions(cwd: string, agentDir: string): TrustOptions {
	const store = new ProjectTrustStore(agentDir);
	const hasProtectedResources = hasTrustRequiringProjectResources(cwd);
	const settingsManager = SettingsManager.create(cwd, agentDir, {
		projectTrusted: hasProtectedResources ? false : (store.get(cwd) ?? true),
	});
	if (!hasProtectedResources) return { settingsManager };

	const event: ProjectTrustEvent = { type: "project_trust", cwd };
	const context: ProjectTrustContext = {
		cwd,
		mode: "print",
		hasUI: false,
		ui: {
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => false,
			notify: (message) => console.error(message),
		},
	};
	return {
		settingsManager,
		resourceLoaderReloadOptions: {
			async resolveProjectTrust({ extensionsResult }) {
				// 在任何处理器开始前快照。显式决定先于默认设置和已记忆决定。
				const handlers = extensionsResult.extensions.map((extension) => ({
					path: extension.path,
					handlers: extension.handlers.get("project_trust")?.slice() ?? [],
				}));
				for (const { path, handlers: pending } of handlers) {
					for (const handler of pending) {
						let decision: { trusted: unknown; remember?: unknown };
						try {
							const result = await handler(event, context);
							if (typeof result !== "object" || result === null || !("trusted" in result)) {
								throw new Error("项目信任扩展返回无效结果");
							}
							decision = result;
						} catch (error) {
							console.warn("[code-reviewer] 项目信任扩展错误", path, error instanceof Error ? error.message : error);
							continue;
						}
						if (decision.trusted === "undecided") continue;
						const trusted = decision.trusted === "yes";
						if (decision.remember === true) store.set(cwd, trusted);
						return trusted;
					}
				}
				return store.get(cwd) ?? settingsManager.getDefaultProjectTrust() === "always";
			},
		},
	};
}
