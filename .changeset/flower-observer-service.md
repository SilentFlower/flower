---
"@flower-ai/flower-observer": minor
---

新增 `@flower-ai/flower-observer` 常驻观测服务(首发):

- **ingest**:`POST /v1/events` 按 httpSink 线协议接收批量 NDJSON,`(traceId, seq)` 幂等
  upsert(整批重发不重复且聚合不重计),坏行容忍计数,Bearer 鉴权可选;JSONL artifact
  经同一端点 curl 导入(行格式与推送逐字节一致,同一解析器)
- **SIEM 接收端**:`POST /v1/audit` 兼容 `sendAudit` payload(含无 traceId 旧格式),
  `tool_blocked` 回写拦截计数并按 (traceId, tool, ts) 与 events 通道跨通道去重
- **存储**:内置 `node:sqlite`(WAL),events 存事件原文(schema 演进零迁移)+
  traces 物化视图;trace 四态物化(running/success/failed/incomplete,seq 缺口精确检测,
  stale-running 查询期推导);保留期每日清理(默认 90 天)
- **Web UI 三页**(SSR HTML + 原生 JS,零前端构建链):trace 列表(过滤态进 URL query、
  四态徽章、GitLab 外链)、详情行为回放(执行流树状↔平铺、toolCallId 配对卡片、拦截红条
  与评论内联、turn timing 分解、缺口黄条、running 30s 自刷新)、指标面板(卡片 +
  uPlot 按天图 + 时长分布 + 最慢 Top10);多产品板块(product)一等维度动态发现
- **部署**:自有 Dockerfile(node:22-alpine,db volume,内置 TZ),查询 JSON API
  (/api/traces /api/products /api/metrics)随服务提供
