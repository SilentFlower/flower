# Database Guidelines

> node:sqlite(`DatabaseSync`)实测范式:WAL、upsert 幂等、薄 DAO、物化视图、保留期清理。

---

## Overview

`flower-observer` 用 Node 内置 `node:sqlite` 模块(同步 API),**没有 ORM、没有迁移工具**。
全部 SQL 收口在 `db.ts` 单文件(薄 DAO),业务层不直接拼 SQL——
万一 node:sqlite 踩到缺口,切 better-sqlite3 只改本文件(同步同范式)。

---

## 打开与 PRAGMA(实测范式)

```typescript
import { DatabaseSync, type StatementSync } from "node:sqlite";

// 确保父目录存在(Docker volume 首次挂载为空目录)
if (dbPath !== ":memory:") {
	mkdirSync(dirname(dbPath), { recursive: true });
}
this.db = new DatabaseSync(dbPath);
// WAL:读不阻塞写;NORMAL 配 WAL 是官方推荐组合(观测数据可容忍极端断电丢尾)
this.db.exec("PRAGMA journal_mode = WAL");
this.db.exec("PRAGMA synchronous = NORMAL");
this.db.exec(SCHEMA_DDL);
```

- 建表 DDL 全部 `CREATE TABLE IF NOT EXISTS`(幂等,**启动即迁移**,无迁移脚本)
- 单测用 `:memory:`;`journalMode()` 暴露 `PRAGMA journal_mode` 供单测断言 WAL 生效
  (`:memory:` 库 journal_mode 是 `memory`,断言 WAL 需用临时文件库)
- 服务进程整个生命周期持有连接,`close()` 仅单测清理用

## upsert 幂等(重发不重计的根基)

```typescript
// INSERT ... ON CONFLICT DO NOTHING + changes 判定「实际插入」
this.stmtInsertEvent = this.db.prepare(
	"INSERT INTO events (...) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(trace_id, seq) DO NOTHING",
);

insertEventIfAbsent(row: EventRow): boolean {
	const result = this.stmtInsertEvent.run(...);
	return result.changes > 0;   // false = 冲突跳过,调用方据此跳过聚合增量
}
```

- `(trace_id, seq)` 为主键;同 seq 重发内容相同(httpSink 超时重发语义),**无需 UPDATE**,DO NOTHING 即可
- **聚合增量只在「实际插入」时执行**——幂等不重计的关键不在 INSERT 本身,而在 `changes > 0` 的返回值约定
- 计数器累加用 SQL 表达式保持幂等友好:`max_seq = MAX(max_seq, ?)`、`last_event_at = MAX(last_event_at, ?)`(乱序容忍)

## 事务(一批一事务)

```typescript
transaction<T>(fn: () => T): T {
	this.db.exec("BEGIN");
	try {
		const result = fn();
		this.db.exec("COMMIT");
		return result;
	} catch (err) {
		this.db.exec("ROLLBACK");
		throw err;
	}
}
```

- node:sqlite 无 better-sqlite3 的 `db.transaction()` 包装,手写 BEGIN/COMMIT/ROLLBACK;事务体必须**同步**
- ingest 整批单事务:失败回滚后客户端按线协议整批重试,不会出现半批落库

## Prepared Statements

- 全部语句在构造函数 `prepare` 一次,存为 `private readonly stmtXxx: StatementSync` 类字段复用
- 动态 WHERE(如 `listTraces` 的多条件过滤)例外:运行期拼 SQL + 即时 `prepare`,
  条件子句与参数数组同步 push,避免占位符错位

## 物化视图(traces 表)

- events 表存事件**原始 JSON 整行**(payload 列,schema 演进零迁移),仅信封 + 聚合所需列提升为独立列
- traces 表是 ingest 事务内同步维护的物化视图:列表 / 指标查询**不扫 events**
- 物化行创建用 `INSERT ... ON CONFLICT(trace_id) DO NOTHING`(ensure)+ 独立 UPDATE(touch),
  各事件 kind 对应专用 `applyXxx` UPDATE 语句

## 保留期清理

```typescript
// 先删子数据再删 traces(无外键,顺序仅为语义清晰);时间判定用 COALESCE 兜底缺 started_at 的行
"DELETE FROM events WHERE trace_id IN (SELECT trace_id FROM traces WHERE COALESCE(started_at, last_event_at) < ?)"
```

- 无外键约束(性能 + 简单),级联删除靠子查询手工保证
- 孤儿审计记录(无 traceId 的旧 payload)按自身事件时间单独判超期

## Common Mistakes

- ❌ 业务层直接拼 SQL(全部 SQL 必须收口 `db.ts`,否则失去"切库只改一文件"的逃生通道)
- ❌ 文件库忘开 WAL(默认 journal 模式读写互斥,常驻服务读路径会被 ingest 写阻塞)
- ❌ 忘记 `mkdirSync(dirname(dbPath))`(Docker volume 首次挂载为空目录,直接打开报错)
- ❌ 用 `INSERT OR REPLACE` 代替 `ON CONFLICT DO NOTHING`(REPLACE 是 DELETE+INSERT,触发重计且丢已有行 rowid)
- ❌ 聚合增量不看 `insertEventIfAbsent` 返回值(重发场景重复计数,幂等失效)
- ❌ 事务体里混 `await`(BEGIN/COMMIT 手工事务必须同步完成,跨 tick 会被其他写挤进事务)
- ❌ 在 `:memory:` 库上断言 `journal_mode === "wal"`(内存库恒为 memory)
