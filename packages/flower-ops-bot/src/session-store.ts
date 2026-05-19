/**
 * 会话存储(Redis 实现)
 *
 * Key 格式:`flower:ops-bot:session:<conversationId>`
 * Value:    JSON.stringify({ messages, updatedAt })
 * TTL:      24 小时
 *
 * 如果环境里没有 Redis,会自动降级为进程内 Map(仅供本地开发,
 * 多副本部署绝对不能用)。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Redis from "ioredis";

/**
 * 持久化的会话数据
 */
export interface StoredSession {
	messages: AgentMessage[];
	updatedAt: number;
}

/** 24 小时 */
const TTL_SECONDS = 60 * 60 * 24;

/** 后端实例(惰性初始化) */
let backend: SessionBackend | undefined;

/**
 * 后端接口
 */
interface SessionBackend {
	get(key: string): Promise<StoredSession | undefined>;
	set(key: string, value: StoredSession): Promise<void>;
	close(): Promise<void>;
}

function getBackend(): SessionBackend {
	if (backend) return backend;
	const url = process.env.REDIS_URL;
	backend = url ? createRedisBackend(url) : createInMemoryBackend();
	return backend;
}

/**
 * 拿到一个会话(不存在返回 undefined)
 */
export async function getSession(conversationId: string): Promise<StoredSession | undefined> {
	return getBackend().get(buildKey(conversationId));
}

/**
 * 保存会话
 */
export async function saveSession(
	conversationId: string,
	session: StoredSession,
): Promise<void> {
	await getBackend().set(buildKey(conversationId), session);
}

/**
 * 优雅关闭(进程退出时调用)
 */
export async function closeSessionStore(): Promise<void> {
	if (backend) {
		await backend.close();
		backend = undefined;
	}
}

function buildKey(conversationId: string): string {
	return `flower:ops-bot:session:${conversationId}`;
}

/**
 * Redis 后端
 */
function createRedisBackend(url: string): SessionBackend {
	const redis = new Redis(url, { maxRetriesPerRequest: 3 });
	redis.on("error", (err) => console.error("[redis]", err));

	return {
		async get(key) {
			const value = await redis.get(key);
			if (!value) return undefined;
			try {
				return JSON.parse(value) as StoredSession;
			} catch {
				return undefined;
			}
		},
		async set(key, value) {
			await redis.set(key, JSON.stringify(value), "EX", TTL_SECONDS);
		},
		async close() {
			await redis.quit();
		},
	};
}

/**
 * 进程内 Map 后端(仅本地开发)
 *
 * @remarks 多副本部署一定要用 Redis,否则同一个会话的连续消息可能
 *          落到不同副本,LLM 就会"失忆"。
 */
function createInMemoryBackend(): SessionBackend {
	const map = new Map<string, StoredSession>();
	console.warn("[session-store] REDIS_URL 未设置,使用内存后端(仅本地开发)");
	return {
		async get(key) {
			return map.get(key);
		},
		async set(key, value) {
			map.set(key, value);
		},
		async close() {
			map.clear();
		},
	};
}
