/**
 * 环境变量集中读取(全部 OBSERVER_* 前缀)
 *
 * 设计:启动期一次性读取并解析为强类型配置对象,业务代码不直接碰 process.env;
 * 数值型变量解析失败时回退默认值(观测服务自身要稳,不因配置笔误拒绝启动)。
 */

/** 监听端口默认值 */
const DEFAULT_PORT = 4810;
/** SQLite 文件路径默认值(Docker volume 挂载点) */
const DEFAULT_DB_PATH = "data/observer.db";
/** 数据保留天数默认值 */
const DEFAULT_RETENTION_DAYS = 90;
/** running 超时视为 incomplete 的展示阈值默认值(分钟) */
const DEFAULT_STALE_RUNNING_MINUTES = 30;

/**
 * 观测服务运行配置
 */
export interface ObserverConfig {
	/** 监听端口(OBSERVER_PORT,默认 4810) */
	port: number;
	/** SQLite 文件路径(OBSERVER_DB_PATH,默认 data/observer.db) */
	dbPath: string;
	/** ingest/audit 端点 Bearer token(OBSERVER_INGEST_TOKEN;空 = 不鉴权,内网裸跑) */
	ingestToken: string;
	/** 数据保留天数(OBSERVER_RETENTION_DAYS,默认 90) */
	retentionDays: number;
	/** running 超时视为 incomplete 的展示阈值,分钟(OBSERVER_STALE_RUNNING_MINUTES,默认 30) */
	staleRunningMinutes: number;
	/** 内网 GitLab 根 URL(OBSERVER_GITLAB_BASE_URL;空 = 不渲染外链) */
	gitlabBaseUrl: string;
}

/**
 * 解析正整数型环境变量,非法或缺省时回退默认值
 *
 * @param raw 环境变量原始值
 * @param fallback 默认值
 * @returns 解析结果(仅接受 > 0 的有限整数)
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === "") return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 从环境变量加载配置
 *
 * @returns 强类型配置对象(所有字段已填默认值)
 */
export function loadConfig(): ObserverConfig {
	return {
		port: parsePositiveInt(process.env.OBSERVER_PORT, DEFAULT_PORT),
		dbPath: process.env.OBSERVER_DB_PATH || DEFAULT_DB_PATH,
		ingestToken: process.env.OBSERVER_INGEST_TOKEN ?? "",
		retentionDays: parsePositiveInt(process.env.OBSERVER_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
		staleRunningMinutes: parsePositiveInt(process.env.OBSERVER_STALE_RUNNING_MINUTES, DEFAULT_STALE_RUNNING_MINUTES),
		gitlabBaseUrl: (process.env.OBSERVER_GITLAB_BASE_URL ?? "").replace(/\/+$/, ""),
	};
}
