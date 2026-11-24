import { buildIdentity, createFixtureHost, service } from "./host.mjs";

/**
 * 企业 Node 验证入口直接加载运行时包根产物。
 * @param options 临时目录、观察端和可选持久化实现
 * @returns 绑定受控服务主体的企业端口
 */
export async function createEnterpriseHost(options) {
	const fixture = createFixtureHost({ ...options, name: "enterprise-node" });
	const client = fixture.client(service);
	return { fixture, client, identity: await buildIdentity(import.meta.resolve("@flower-ai/agent-runtime")) };
}
