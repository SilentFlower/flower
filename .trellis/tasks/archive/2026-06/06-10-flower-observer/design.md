# design.md — flower-observer 常驻观测服务

## Technical Design

### 总体架构(数据流向)

```
flower-telemetry httpSink ──批量 NDJSON──→ POST /v1/events ─┐
flower-compliance→siemSink ──单条 JSON──→ POST /v1/audit ──┤   packages/flower-observer
CI artifact(flower-review-trace.jsonl)──curl 同端点导入──→┘   (Hono @ node:22-alpine)
                                                              │
                                  ingest:逐行解析(坏行容忍)→ 事务内
                                  (trace_id, seq) 幂等 upsert + trace 聚合物化
                                                              ▼
                                  SQLite(node:sqlite,WAL,单文件 volume)
                                                              │
              ┌──────────────── 查询 API(JSON)───────────────┤
              ▼                                               ▼
  /traces 列表页    /traces/:id 详情回放页    /metrics 指标页(SSR HTML + 原生 JS)
              └────── 顶栏 product 板块切换(多产品一等维度)──────┘
```

技术栈(决策依据 `research/tech-stack.md`):**Hono + @hono/node-server**(合计 0 运行时
依赖)、**node:sqlite**(Node ≥22.13 免 flag;WAL + upsert 已实测;DAO 薄层隔离,逃生口
better-sqlite3 同范式)、**无构建服务端 HTML + 原生 JS**(htmx 暂不引入,uPlot vendor 进
static/ 供指标页,内网离线可用)。Postgres / Vite SPA 均已否决(见 research)。

### 包结构(packages/flower-observer,形态对齐 flower-ops-bot)

```
src/
├── server.ts          # 入口:Hono app 装配 + serve;启动 retention 定时器
├── config.ts          # env 集中读取(见环境变量表)
├── db.ts              # node:sqlite 打开 + WAL + schema 迁移 + 薄 DAO(全部 SQL 收口在此)
├── ingest.ts          # NDJSON 解析(坏行计数跳过)+ 事务 upsert + trace 聚合物化
├── trace-status.ts    # 四态推导:物化规则 + 查询期 stale-running 判定
├── routes/
│   ├── ingest.ts      # POST /v1/events(NDJSON)/ POST /v1/audit(SIEM 单条)/ GET /healthz
│   ├── api.ts         # GET /api/traces /api/traces/:id /api/products /api/metrics
│   └── pages.ts       # GET /traces /traces/:id /metrics(SSR)+ serveStatic(/static)
├── views/
│   ├── layout.ts      # 顶栏(板块切换/时间范围)+ 页面骨架(模板字符串函数)
│   ├── trace-list.ts  # 列表页(列/过滤/状态徽章/GitLab 外链)
│   ├── trace-detail.ts# 详情页(树重建/平铺切换/产出 tab/节点详情)
│   ├── metrics.ts     # 指标页(卡片 + uPlot 图)
│   └── tree.ts        # span 树重建:attempt → turnIndex → seq;toolCallId 配对
└── static/
    ├── app.css / app.js
    └── vendor/uplot.* # 仅指标页引
src/__tests__/         # vitest(与 telemetry 包同模式)
Dockerfile / README.md / package.json / tsconfig.json
```

### 存储模型(SQLite,WAL)

```sql
-- 全量事件:原始 JSON 整行保存(schema 演进零迁移),关键列提升做索引
CREATE TABLE IF NOT EXISTS events (
  trace_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  product  TEXT NOT NULL,
  kind     TEXT NOT NULL,        -- trace_start|span|outcome|trace_end
  ts       INTEGER NOT NULL,
  payload  TEXT NOT NULL,        -- JSON.stringify(TelemetryEvent) 原文
  PRIMARY KEY (trace_id, seq)
);

-- trace 物化视图(列表/指标查询不扫 events;ingest 事务内同步维护)
CREATE TABLE IF NOT EXISTS traces (
  trace_id     TEXT PRIMARY KEY,
  product      TEXT NOT NULL,
  project      TEXT, mr_iid TEXT, commit_sha TEXT, pipeline_id TEXT,   -- correlation
  started_at   INTEGER, ended_at INTEGER,
  status       TEXT NOT NULL DEFAULT 'running',  -- running|success|failed|incomplete
  turns INTEGER, tool_calls INTEGER, duration_ms INTEGER,              -- trace_end.totals
  comment_count INTEGER NOT NULL DEFAULT 0,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  block_count   INTEGER NOT NULL DEFAULT 0,      -- security_block 计数
  exit_code INTEGER, skill_used TEXT,            -- run_summary
  max_seq INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_list ON traces(product, started_at DESC);

-- SIEM 审计通道(独立表;traceId 可空兼容旧 payload)
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT, product TEXT, kind TEXT NOT NULL, tool TEXT,
  payload TEXT NOT NULL, ts INTEGER NOT NULL, received_at INTEGER NOT NULL
);
```

### ingest 语义(routes/ingest.ts + ingest.ts)

- `POST /v1/events`:`c.req.text()` 拿原始体 → 按行 split → 逐行 `JSON.parse`;
  缺 `traceId/seq/kind/product/ts` 或 parse 失败 = 坏行(计数器 + DEBUG 日志,**不拒整批**)
- 单事务内:`INSERT INTO events ... ON CONFLICT(trace_id, seq) DO NOTHING`(同 seq 重发
  内容相同,无需 UPDATE)+ 按 kind 增量维护 traces 行(见下)→ 响应
  `200 {accepted, skipped, badLines}`
- **幂等**:整批重发 → events 全部 conflict-skip;traces 聚合只在 events 实际插入时增量,
  重发不重计
- 鉴权:`OBSERVER_INGEST_TOKEN` 已配置时,`/v1/events` 与 `/v1/audit` 校验
  `Authorization: Bearer`,失败 401(客户端 fail-open 不受影响);未配置 = 内网裸跑。
  读 API / 页面不鉴权(内网工具,无多租户假设)
- `POST /v1/audit`:单条 JSON(兼容 sendAudit payload:kind/product/ts/user/host,
  `traceId` 可缺省)→ security_events;`tool_blocked` 同时回写对应 trace 的 block_count
  (traces 行可能尚不存在 → 容忍,仅存 security_events)
- **JSONL artifact 导入 = 同一端点**:`curl --data-binary @flower-review-trace.jsonl
  -H 'Content-Type: application/x-ndjson' <url>/v1/events` —— 行格式与 httpSink
  逐字节一致(httpSink 任务的设计红利),零额外解析代码,即 PRD R8

### trace 四态物化(trace-status.ts;规则源 research/ui-patterns.md §五.6)

| 事件 | 物化动作 |
|------|---------|
| `trace_start` | upsert traces 行:correlation/started_at,status=running |
| `run_summary` outcome | exit_code/skill_used 落列 |
| `line_comment` outcome | comment_count++;severity=blocker 时 blocker_count++ |
| `security_block` outcome | block_count++ |
| `trace_end` | ended_at/totals 落列;**完整性判定**:`event_count == max_seq` → status = exitCode===0 ? success : failed;有缺口 → incomplete |
| (查询期) | status=running 且 `now - last_event_at > OBSERVER_STALE_RUNNING_MINUTES` → 显示为 incomplete(不回写,纯展示推导) |

注:seq 由 pipeline 从 1 单调递增,`event_count == max_seq` 即无缺口。

### UI 三页(信息架构全部来自 research/ui-patterns.md §四,此处只记决策)

- **列表页**:列=状态/时间/项目/MR/commit·pipeline/product/时长/轮·工具/评论(blocker
  红徽)/拦截;过滤=时间 lookback(1h/24h/7d/30d)+project+MR+状态+product;
  过滤态全进 URL query;行点击整页跳详情;顶部统计条(今日次数/失败/平均时长)
- **详情页**:头部摘要(含 ⚠ seq 缺口黄条)+「执行流」/「产出」两 tab;执行流支持
  树状↔按 seq 平铺切换;`tool_call+tool_result` 按 toolCallId 配对单卡片,拦截红条内联,
  `line_comment` 内联进流;turn 节点展开 timing 分解全表;右栏节点详情
  (pretty↔raw、默认折叠、"已脱敏/单字段≤4000"灰字);**明示边界:行为回放,
  无 assistant 正文/thinking(stream 不入库)**;running trace 页面 JS 定时(30s)拉取刷新
- **指标页**:卡片(近 7 天次数/成功率/P50/P95 时长/平均评论/拦截总数)+
  uPlot 图(按天次数·product 分组、时长分布)+ 最慢 Top10 表;全部按当前板块过滤
- **板块管理(R4)**:顶栏 product 下拉,选项 = `SELECT DISTINCT product`(动态发现,
  不硬编码);三页查询全部携带 product 条件;product 徽章配色按名称哈希
- **GitLab 外链**(Jaeger linkPatterns 思想):`OBSERVER_GITLAB_BASE_URL` +
  correlation 拼 MR / commit / pipeline URL;line_comment 拼 MR diff 行锚点

### 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `OBSERVER_PORT` | 4810 | 监听端口 |
| `OBSERVER_DB_PATH` | `data/observer.db` | SQLite 文件(Docker volume 挂载点) |
| `OBSERVER_INGEST_TOKEN` | (空=不鉴权) | ingest/audit 端点 Bearer token,与客户端 `FLOWER_TELEMETRY_TOKEN` 配对 |
| `OBSERVER_RETENTION_DAYS` | 90 | 保留期;每日定时删 `started_at` 超期的 traces/events/security_events |
| `OBSERVER_STALE_RUNNING_MINUTES` | 30 | running 超时视为 incomplete 的展示阈值 |
| `OBSERVER_GITLAB_BASE_URL` | (空=不出外链) | 内网 GitLab 根,如 `http://gitlab.xhgjdev.com` |

### 兼容性 / 边界

| 面 | 策略 |
|----|------|
| ingest 契约 | 严格实现 httpSink 任务钉死的线协议(2xx 语义;**不可返回 3xx**) |
| sendAudit 旧 payload | `traceId` 可缺省,字段开放结构原样存 payload |
| 事件 schema 演进 | events.payload 存原文,新增字段零迁移;提升列仅信封 + 聚合所需 |
| stream 事件 | 契约上不会推来;若收到(直发文件导入含杂行)按坏行跳过 |
| Node ExperimentalWarning | start 脚本加 `--disable-warning=ExperimentalWarning` |

## Rollout / Rollback

- 新包独立部署(Dockerfile 同 ops-bot 模式,db 文件挂 volume),不影响任何现有产品;
  根 tsconfig references + `.trellis/config.yaml` packages 注册 flower-observer
- 接流 = 在评审 CI 配 `FLOWER_TELEMETRY_URL`(+token);`SIEM_INGEST_URL` 指向
  `/v1/audit` 可选;回滚 = 删配置停服务,db 文件保留,客户端 fail-open 零影响
- 风险:UI 工作量占比高 → implement 分三段提交(底座 ingest/存储 → 查询 API →
  UI 三页),每段可独立验证
