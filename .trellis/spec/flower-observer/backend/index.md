# Backend Development Guidelines

> `@flower-ai/flower-observer` 常驻观测服务(ingest 幂等入库 + SQLite + trace 三页 UI)开发规范。

---

## Overview

`flower-observer` 是常驻 HTTP 服务:接收 flower-telemetry httpSink 的批量 NDJSON 推送与 SIEM 审计事件,
SQLite 幂等入库,提供 trace 列表 / 回放 / 指标 Web UI。

| 模块 | 职责 |
|------|------|
| `server.ts` | HTTP 入口与装配 |
| `config.ts` | 环境变量集中读取(全部 `OBSERVER_*` 前缀,启动期一次性解析为强类型对象) |
| `db.ts` | SQLite 存储层(node:sqlite,WAL;薄 DAO,全部 SQL 收口) |
| `ingest.ts` | NDJSON 逐行解析(坏行容忍)+ 单事务幂等 upsert + trace 聚合物化 |
| `trace-status.ts` | trace 四态推导(物化规则 + 查询期 stale-running 展示推导) |
| `metrics.ts` | 指标聚合纯函数(近 N 天 traces 内存聚合,时间参数注入) |
| `routes/ingest.ts` | `POST /v1/events` / `POST /v1/audit` / `GET /healthz`(禁 3xx 契约) |
| `routes/api.ts` / `routes/pages.ts` | JSON API 与页面路由 |
| `views/` + `static/` | 服务端渲染三页 UI(列表 / 详情回放 / 指标)与前端资源 |

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Database Guidelines](./database-guidelines.md) | node:sqlite 实测范式:WAL、upsert 幂等、薄 DAO、物化视图、保留期清理 |
| [Ingest Guidelines](./ingest-guidelines.md) | httpSink 线协议服务端要点:幂等 / 禁 3xx / 坏行容忍 / 跨通道计数去重 |

> 客户端(sink / 线协议发送侧)规范见 [flower-telemetry backend spec](../../flower-telemetry/backend/index.md)。

---

## 关键设计点

1. **服务自身要稳**:数值型环境变量解析失败回退默认值,不因配置笔误拒绝启动(`config.ts`);
   坏行计数跳过不拒整批(`ingest.ts`)
2. **幂等是端到端语义**:客户端超时重发同批 → `(trace_id, seq)` 主键冲突跳过,
   聚合增量只在事件「实际插入」时执行,重发不重计(见两份指南)
3. **events 存原文,聚合走物化**:events 表 payload 存行原文(schema 演进零迁移),
   traces 表是 ingest 事务内同步维护的物化视图,列表/指标查询不扫 events
4. **trace 四态 + seq 缺口检测**:seq 从 1 单调递增 → `event_count == max_seq` 即无缺口收齐,
   缺口可精确检测(`trace-status.ts`);stale-running 是查询期展示推导,不回写
5. **指标内存聚合**:每天几十~几百次评审、30 天上限万级行 → 纯函数内存聚合,
   避免 SQLite percentile SQL 技巧,便于单测(`metrics.ts`)
6. **Docker 构建指定包,避 TS5083**:顶层 `npm run build` 走根 tsconfig(references 全部 package),
   Dockerfile 未 COPY 的包会触发 `TS5083 Cannot read file '.../tsconfig.json'`;
   改用 `tsc --build packages/<pkg>/tsconfig.json`,递归编译该包 + 声明的 transitive deps、跳过无关包
   (实测 `ba58509`,flower-code-reviewer Dockerfile)
