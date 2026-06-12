# @flower-ai/flower-observer

flower 系产品的常驻观测服务:实时接收 `@flower-ai/flower-telemetry` httpSink 推送的全量
归一化事件并幂等入库(SQLite),兼任 SIEM 审计事件接收端,提供「评审 trace 列表 /
单次评审回放 / 指标面板」Web UI——回答"评审跑得怎么样、卡在哪、产出了什么、拦截了什么"。

## 架构

```
flower-telemetry httpSink ──批量 NDJSON──→ POST /v1/events ─┐
flower-compliance→siemSink ──单条 JSON──→ POST /v1/audit ──┤   flower-observer(Hono)
CI artifact(flower-review-trace.jsonl)──curl 同端点导入──→┘
                                                             │
                                 ingest:逐行解析(坏行容忍)→ 事务内
                                 (trace_id, seq) 幂等 upsert + trace 聚合物化
                                                             ▼
                                 SQLite(node:sqlite,WAL,单文件 volume)
                                                             │
             ┌──────────────── 查询 API(/api/*)─────────────┤
             ▼                                               ▼
 /traces 列表页    /traces/:id 详情回放页    /metrics 指标页(SSR HTML + 原生 JS)
             └────── 顶栏 product 板块切换(多产品一等维度)──────┘
```

技术栈:Hono + `@hono/node-server`(合计 0 运行时依赖)、内置 `node:sqlite`(WAL)、
无构建服务端 HTML + 原生 JS(uPlot vendor 进 `static/vendor/`,内网离线可用)。

## 端点

| 端点 | 说明 |
|------|------|
| `POST /v1/events` | NDJSON 批量 ingest(httpSink 线协议;Bearer 鉴权可选) |
| `POST /v1/audit` | SIEM 单条审计(兼容 `sendAudit` payload,含无 traceId 旧格式) |
| `GET /healthz` | 健康检查 |
| `GET /api/traces` | trace 列表(product/时间/项目/MR/状态过滤 + 分页) |
| `GET /api/traces/:id` | 单条 trace + 全量事件(回放顺序) |
| `GET /api/products` | 产品板块动态发现 |
| `GET /api/metrics` | 指标聚合(卡片 / 按天 / 时长分布 / 最慢 Top10) |
| `GET /traces` `/traces/:id` `/metrics` | Web UI 三页(读路径不鉴权,内网工具) |

### ingest 契约

严格实现 `@flower-ai/flower-telemetry` README「httpSink 线协议」节:

- `Content-Type: application/x-ndjson`,body 每事件一行 `JSON.stringify(TelemetryEvent)`,
  **与 JSONL artifact 逐字节同格式**(同一解析器吃 HTTP 推送与文件导入两种来源)
- 客户端超时重发 → 服务端按 `(traceId, seq)` 幂等 upsert,**整批重发不产生重复且聚合不重计**
- `2xx` = 成功(绝不返回 3xx);响应 `{accepted, skipped, badLines}`
- 坏行(parse 失败 / 信封缺失 / stream 杂行)计数跳过,不拒整批
- 配置 `OBSERVER_INGEST_TOKEN` 时校验 `Authorization: Bearer`(与客户端
  `FLOWER_TELEMETRY_TOKEN` 配对),失败 401(客户端 fail-open,不影响评审主流程)

### trace 四态

| 状态 | 判定 |
|------|------|
| running | 已开始未收尾 |
| success | 已收尾,无 seq 缺口,exitCode=0 |
| failed | 已收尾,无 seq 缺口,exitCode≠0(或缺 run_summary) |
| incomplete | 已收尾但有 seq 缺口;或 running 超过 `OBSERVER_STALE_RUNNING_MINUTES` 无新事件(查询期展示推导,不回写) |

## 部署

```bash
# 构建(仓库根目录执行)
docker build -f packages/flower-observer/Dockerfile -t flower-observer .

# 运行(db 文件挂 volume;TZ 已内置 Asia/Shanghai,指标按天分界用)
docker run -d --name flower-observer \
  -p 4810:4810 \
  -v flower-observer-data:/app/data \
  -e OBSERVER_INGEST_TOKEN=<内网共享 token> \
  -e OBSERVER_GITLAB_BASE_URL=http://gitlab.xhgjdev.com \
  flower-observer
```

接流 = 在评审 CI 配置 `FLOWER_TELEMETRY_URL=http://<host>:4810/v1/events`
(+`FLOWER_TELEMETRY_TOKEN`);`SIEM_INGEST_URL=http://<host>:4810/v1/audit` 可选。
回滚 = 删配置停服务,db 文件保留,客户端 fail-open 零影响。

本地开发:

```bash
npm run dev -w packages/flower-observer     # tsx watch,静态资源直读 src/static
npm test -w packages/flower-observer        # vitest
```

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `OBSERVER_PORT` | `4810` | 监听端口 |
| `OBSERVER_DB_PATH` | `data/observer.db` | SQLite 文件路径(镜像内为 `/app/data/observer.db`,挂 volume) |
| `OBSERVER_INGEST_TOKEN` | (空=不鉴权) | `/v1/*` 写入端点 Bearer token,与客户端 `FLOWER_TELEMETRY_TOKEN` 配对 |
| `OBSERVER_RETENTION_DAYS` | `90` | 保留期;每日定时删除超期 trace 连同 events / security_events |
| `OBSERVER_STALE_RUNNING_MINUTES` | `30` | running 超时视为 incomplete 的展示阈值 |
| `OBSERVER_GITLAB_BASE_URL` | (空=不出外链) | 内网 GitLab 根 URL,列表/详情页拼 MR / commit / pipeline / diff 行锚点外链 |
| `DEBUG_OBSERVER` | (空) | `=1` 时打印坏行诊断 warn(默认静默) |
| `TZ` | 镜像内 `Asia/Shanghai` | 指标页「按天」聚合的时区分界 |

## JSONL artifact 导入(补数 / 对账)

行格式与 httpSink 推送逐字节一致,同一端点直接导入:

```bash
curl --data-binary @flower-review-trace.jsonl \
  -H 'Content-Type: application/x-ndjson' \
  -H 'Authorization: Bearer <token>' \
  http://<host>:4810/v1/events
# → {"accepted":312,"skipped":0,"badLines":0}
# 与 httpSink 已推送的部分自动去重(skipped 计数),聚合不重计
```

## UI 说明(设计边界)

- **列表页**:状态/时间/项目/MR/时长/评论/拦截列;过滤态全进 URL query(可分享);
  「进行中」状态是 httpSink 实时推送的核心红利
- **详情页**:**行为回放**而非对话回放——`stream` 事件不入库,无 assistant 正文 /
  thinking;执行流支持树状(attempt → turn → 叶子)↔ 按 seq 平铺切换,tool_call /
  tool_result 按 toolCallId 配对,拦截红条与行内评论内联;turn 节点可展开 timing
  十余项分解(回答"卡在哪");seq 缺口黄条精确报告区间;running trace 30s 自动刷新
- **指标页**:卡片 + 按天次数图(uPlot,product 分组)+ 时长分布 + 最慢 Top10,
  全部按当前板块过滤
- **板块**:以 `product` 为一级组织维度,选项从数据动态发现(distinct),不硬编码

## 安全

- 数据含代码 diff / 评论(pipeline 已脱敏截断但仍敏感)→ **仅限内网部署** + token 鉴权
- 事件内容按不可信输入处理:页面渲染全量 HTML 转义(防存储型 XSS);静态资源白名单
  显式枚举(免路径穿越)
- 读 API / 页面不鉴权(内网工具,无多租户假设;如需收紧可挂反代)
