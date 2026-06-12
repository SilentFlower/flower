# flower-observer 常驻观测服务(ingest + 存储 + trace UI)

## Goal

为 flower 系产品(code-reviewer,后续 ops-bot)提供常驻观测服务:实时接收
flower-telemetry httpSink 推送的全量归一化事件并幂等入库,兼任 SIEM 审计事件接收端,
提供「评审 trace 列表 / 单次评审回放 / 指标」的 Web UI——回答"评审跑得怎么样、
卡在哪、产出了什么、拦截了什么"。

## Background / Known Context

* **ingest 契约已钉死**(由前置任务 `06-10-telemetry-http-sink` 定义,见其 design.md
  与 flower-telemetry README「httpSink 线协议」节):
  - `POST <FLOWER_TELEMETRY_URL>`,`Content-Type: application/x-ndjson`,
    body 每事件一行 `JSON.stringify(TelemetryEvent)`,可选 `Authorization: Bearer <token>`
  - **行格式与 JSONL artifact 逐字节一致** → 服务端一个解析器吃两种来源(HTTP 推送 / 文件导入)
  - 客户端超时重发 → **服务端必须按 `(traceId, seq)` 幂等 upsert**
  - `2xx` = 成功;其余客户端整批重试(注意:别用 3xx/重定向)
* **事件模型**(`@flower-ai/flower-telemetry` types.ts,字段显式声明可依赖):
  `trace_start`(correlation{project,mrIid,commitSha,pipelineId} + reason)/
  `span`(agent|turn|llm_call|tool_call|tool_result,含脱敏 input/result、turn timing)/
  `outcome`(line_comment|self_check|security_block|run_summary)/
  `trace_end`(totals);`stream` 不会被推送
* **完整性语义**:收到 `trace_end` = trace 收齐;`seq` 单调递增 → 缺口可精确检测
* **SIEM 事件**(若把 `SIEM_INGEST_URL` 也指到本服务):单条 JSON POST,
  kind ∈ session_start|tool_call|tool_result|tool_blocked,自带 `traceId`(R4 已补)+ user/host
* **量级**:每天几十~几百次评审 × 每次数百事件,单字段 ≤4000 字符(pipeline 已截断)
* **monorepo 先例**:`packages/flower-ops-bot` 即常驻服务形态
  (`src/server.ts`、dev=tsx watch、start=node dist/server.js、自有 Dockerfile)
* **部署环境**:公司内网,Harbor 镜像仓(192.168.27.236),GitLab CI;
  数据含代码 diff/评论(已脱敏但敏感)→ 仅内网 + token 鉴权
* 历史决策(httpSink 任务 ADR):推送为主通路;artifact 为备份/对账;
  webhook+artifact 补拉降级为本服务的**二期可选**修复通道

## Assumptions (temporary)

* 单实例部署足够(量级小);无高可用要求
* UI 使用者是内部研发,无多租户/权限分级需求(一个共享 token 即可)

## Research References

* [`research/tech-stack.md`](research/tech-stack.md) — 推荐 Hono(2 包零依赖)+
  内置 node:sqlite(WAL/upsert 已实测)+ 无构建服务端 HTML;Postgres 否决;
  better-sqlite3 为逃生口(注意内网下载预编译二进制的可达性);裸 node:http 为保守替代
* [`research/ui-patterns.md`](research/ui-patterns.md) — Jaeger/Langfuse/LangSmith/Phoenix
  信息架构 12 条共识 + 事件模型逐项映射 + MVP 三页清单(列名/过滤器/区块级);
  关键边界:行为回放(stream 不入库)、树靠 attempt→turnIndex→seq 重建、四态服务端物化
* ingest 契约源头:`.trellis/tasks/06-10-telemetry-http-sink/design.md`、
  `packages/flower-telemetry/README.md`

## Decision (ADR-lite)

**Q1 · 代码放置 → monorepo 新包 `packages/flower-observer`**(2026-06-10 确认)
理由:服务核心是消费 TelemetryEvent schema,workspace 依赖
`@flower-ai/flower-telemetry` 获得编译期类型同步;`flower-ops-bot` 已踩出
常驻服务全套模式(server.ts / tsx dev / 自有 Dockerfile);复用 CI、biome、
tsc references、Harbor 镜像链路。代价:与产品包同仓发版节奏耦合(可接受,
服务本身也随 schema 演进)。

**MVP 范围 → 全量一期**(用户确认):ingest + 列表 + 详情回放 + 指标面板,
「多产品板块管理」为一等需求(R4)。

**Q2 · 存储 → SQLite(内置 node:sqlite,WAL)**:零依赖零构建,upsert 已实测;
DAO 薄层收口 SQL,逃生口 better-sqlite3 同范式;Postgres 否决。

**Q3 · HTTP 层 → Hono + @hono/node-server**(用户确认):两包合计 0 运行时依赖,
覆盖 NDJSON 原始体/静态/HTML 三类响应;ops-bot 裸 http 先例是单入口场景的选择,
不机械套用。UI = 无构建服务端 HTML + 原生 JS,uPlot vendor;Vite SPA 否决。

**Q4 · 数据保留 → 默认 90 天**,`OBSERVER_RETENTION_DAYS` 可配,每日定时清理。

**设计边界(必须明示)**:详情页是**行为回放**而非对话回放(stream 不入库,
无 assistant 正文/thinking);不做完整 Gantt(span 无 parent_id,重建树 + 耗时横条降级)。

## Requirements(MVP 已确认:ingest + 列表 + 回放 + 指标面板 + 多产品板块)

* R1 ingest 端点:按既定契约接收 NDJSON 批量;`(traceId, seq)` 幂等 upsert;
  Bearer token 校验(env 配置);坏行容忍(坏行计数跳过,不拒整批)
* R2 SIEM 接收端点:接收单条审计 JSON(兼容 sendAudit payload),经 traceId 与 trace 关联
* R3 存储:traces / events 模型;`trace_end` 标记完整;超时未收尾标记「半截」;
  保留期清理(默认 90 天,env 可配)
* R4 **多产品板块**:以 `product` 为一级组织维度(板块切换导航);产品列表从数据
  动态发现(distinct product),不硬编码;列表/详情/指标均按当前板块过滤
* R5 trace 列表页:状态(进行中/完整/半截)、按 project / MR / 时间过滤、
  关键列(correlation、totals、产出摘要);「进行中」是 httpSink 实时推送的核心红利
* R6 trace 详情回放页:按 seq 重放 span/outcome 流(turn 分组、工具调用 IO 折叠、
  评论/拦截/自检结果突出);UI 信息架构参考 research/ui-patterns.md
* R7 指标面板(按板块):评审时长分布、turn/tool 统计、拦截统计、评论产出
  (具体指标集随 research 与 design 收敛;对非 code-reviewer 产品退化为通用指标)
* R8 JSONL 文件导入(CLI 或上传):同一解析器消费 artifact,补数/对账
* R9 部署:packages/flower-observer 新包(workspace 依赖 flower-telemetry 取类型),
  自有 Dockerfile,README 含部署与环境变量说明

## Acceptance Criteria

* [ ] ingest:NDJSON 批量入库;**整批重发不产生重复且聚合不重计**((traceId,seq) 幂等)
* [ ] 坏行跳过并计数(响应含 badLines),不拒整批;配置 token 时无/错鉴权返回 401
* [ ] SIEM 端点兼容 sendAudit payload(含**无 traceId 的旧格式**),tool_blocked 回写计数
* [ ] trace 四态物化正确(单测):无 trace_end=running;exitCode 0/非0=success/failed;
  seq 缺口=incomplete;running 超时在查询期显示为 incomplete
* [ ] JSONL artifact 经 curl 导入 /v1/events,结果与 httpSink 推送完全一致(同一解析器)
* [ ] 列表页:板块切换 + 时间/项目/MR/状态过滤(URL query 即状态)+ 四态徽章 +
  GitLab 外链 + 评论/拦截列
* [ ] 详情页:执行流树状↔平铺切换、tool_call/result 按 toolCallId 配对、line_comment
  内联、拦截红条、turn timing 展开表、产出 tab 四区块、seq 缺口黄条
* [ ] 指标页:卡片 + 按天图 + 时长分布 + 最慢 Top10,均按板块过滤
* [ ] 保留期清理生效(超期 trace 连同 events/security_events 删除)
* [ ] `npx biome check packages/flower-observer` / `npm run build` /
  `npm test -w packages/flower-observer` 全绿;Dockerfile 可构建
* [ ] README(部署/env 表/契约引用/导入示例)+ .env.example + changeset

## Definition of Done (team quality bar)

* 单测(ingest 幂等/坏行容忍/鉴权)+ lint/typecheck/test 绿
* README(部署方式 + 环境变量 + 契约引用)
* Dockerfile 可构建运行

## Out of Scope (explicit)

* GitLab webhook + artifact 自动补拉(二期;R8 的手动 curl 导入先顶上)
* ops-bot 产品接线(httpSink 通用,等 ops-bot 自己的任务;本服务 product 维度已就绪)
* 高可用/多实例/多租户权限/登录体系(内网共享 token)
* 转发到真实公司 SIEM(将来需要时在本服务加 forward)
* SSE 实时推流(详情页 30s 轮询顶上)、全文搜索、min/max 时长过滤、列表侧栏预览、
  完整 Gantt 瀑布(均二期;依据 research/ui-patterns.md 的取舍)
* Vite SPA / 任何前端构建链
