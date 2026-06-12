# implement.md — flower-observer 常驻观测服务

> 分三段落地(每段独立可验证、独立 commit):A 底座(Step 1-4)→ B 查询 API(Step 5)
> → C UI 三页(Step 6-7)→ 收尾(Step 8-9)。

## Implementation Checklist

### 段 A:包骨架 + ingest 底座

- [ ] Step 1 包骨架:`packages/flower-observer/`(package.json:dep 仅 hono +
      @hono/node-server + workspace flower-telemetry(类型);scripts 对齐 ops-bot:
      dev=tsx watch / start=node --disable-warning=ExperimentalWarning dist/server.js)、
      tsconfig(references flower-telemetry)、根 tsconfig references 注册、
      `.trellis/config.yaml` packages 注册;`config.ts` + `server.ts`(Hono 装配 + /healthz)
- [ ] Step 2 `db.ts`:node:sqlite 打开 + WAL + schema DDL(events/traces/security_events,
      见 design.md)+ 薄 DAO(upsert/聚合更新/查询全部 SQL 收口);单测:幂等 upsert、
      WAL 生效
- [ ] Step 3 ingest:`ingest.ts` + `routes/ingest.ts`(POST /v1/events:NDJSON 逐行
      解析坏行容忍、事务 upsert、trace 聚合物化、Bearer 鉴权、响应 accepted/skipped/badLines);
      `trace-status.ts` 四态规则;单测:整批重发不重计、坏行跳过、401、
      trace_end 缺口→incomplete、exitCode→success/failed
- [ ] Step 4 SIEM:POST /v1/audit(单条 JSON,兼容无 traceId 旧 payload,
      tool_blocked 回写 block_count)+ 单测

### 段 B:查询 API

- [ ] Step 5 `routes/api.ts`:GET /api/traces(product/时间/项目/MR/状态过滤 + 分页,
      stale-running 查询期推导)、/api/traces/:id(trace 行 + events 全量)、
      /api/products(distinct)、/api/metrics(卡片数字 + 按天聚合 + 时长分布 + 最慢 Top10);
      单测:过滤组合、stale 推导、聚合正确性

### 段 C:UI 三页

- [ ] Step 6 列表页 + 详情页:`views/layout.ts`(顶栏板块切换/时间范围)、
      `views/trace-list.ts`(列/过滤表单/状态徽章/GitLab 外链/统计条/URL query 状态)、
      `views/tree.ts`(attempt→turnIndex→seq 树重建 + toolCallId 配对;纯函数,单测)、
      `views/trace-detail.ts`(执行流树状↔平铺 / 产出 tab / 节点详情折叠 / timing 展开表 /
      缺口黄条 / running 30s 自刷新)、`static/app.css|app.js`
- [ ] Step 7 指标页:`views/metrics.ts` + vendor uPlot 进 `static/vendor/`(离线);
      卡片 + 两图 + Top10 表

### 收尾

- [ ] Step 8 交付物:Dockerfile(ops-bot 模式 + db volume)、README(部署/环境变量表/
      ingest 契约引用 telemetry README/JSONL 导入 curl 示例)、`.env.example` 增
      OBSERVER_* 注释段、changeset(@flower-ai/flower-observer minor 首发)
- [ ] Step 9 手动 e2e:本地起服务 → 用真实 flower-review-trace.jsonl curl 导入 →
      三页逐项核对(状态/外链/回放/产出/指标);再用 httpSink 真推一次
      (FLOWER_TELEMETRY_URL 指本地)验证实时链路

## Validation

- `npx biome check packages/flower-observer`(注意:不要跑全仓 `npm run check`,
  本环境 biome CLI 与 schema 版本不匹配会重排无关文件)
- `npm run build`(类型门禁;`npm run typecheck` 有先于本任务的 TS6310 问题)
- `npm test -w packages/flower-observer`
- Docker:`docker build -f packages/flower-observer/Dockerfile .` 可构建

## Review Gates

- 开工前:确认 `feat/telemetry-http-sink` 已合入 main(httpSink 契约是本服务的上游),
  从最新 main 开新分支 `feat/flower-observer`
- 段 A / B / C 各自结束:跑 Validation,分段 commit(trellis-push commit-only 可选)
- 全部完成:trellis-check-all(对照本三件套)→ trellis-push
