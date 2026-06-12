# flower-telemetry httpSink 实时推送(NDJSON 批量 → flower-observer)

## Goal

让 telemetry 自己承担"遥测发送"职责:新增 `httpSink`,把全量归一化事件以批量 NDJSON
实时推送到常驻观测服务(flower-observer,独立立项)。覆盖 jsonlSink/artifact 模式
无法覆盖的两类场景:① 评审进行中的实时观测;② ops-bot 等无 CI artifact 的常驻产品
(推送是它们唯一的全量数据通路)。

## Background / Known Context

* 前置任务 `06-10-flower-telemetry-pipeline` 已落地 pipeline + 3 sink(console/jsonl/siem),
  本任务是 sink 体系的第 4 个成员,等前者 PR 合入 main 后基于 main 开分支。
* sink 接口契约(`types.ts:242`):`onEvent` 同步、不得抛错;耗时操作 sink 内部
  fire-and-forget;`flush()` run 结束收尾。pipeline 对每个 sink 有 try-catch 兜底。
* `stream` 事件**必须忽略**(`types.ts:7` 明文:仅供 consoleSink;且 thinking/text delta
  不做脱敏,推出去会泄 secret)— 与 jsonlSink 同一过滤规则(`jsonl.ts:31`)。
* 事件已自带网络传输语义:`traceId`(流身份)+ `seq`(单调递增 → 服务端幂等去重、
  缺口检测)+ `trace_end`(完整性判定)。服务端按 `(traceId, seq)` upsert 即可,
  httpSink 重发不会写重。
* 既有姿态约定(必须对齐):fail-open 静默、`DEBUG_TELEMETRY=1` 才 warn
  (`pipeline.ts:46`)、非 critical(受 `FLOWER_TELEMETRY=0` 总开关控制,
  `pipeline.ts:70`)、URL 型环境变量 = 完整端点(对齐 `SIEM_INGEST_URL` 语义)。
* siemSink 不动:metadata-only / critical("不可关")是审计语义,与本 sink 的
  观测语义平行,不合并。
* 装配点:`telemetry-setup.ts:35 buildTelemetrySinks()`,配了 `FLOWER_TELEMETRY_URL`
  才挂载 httpSink(模式同 consoleSink 受 FLOWER_VERBOSE 控制)。

## Requirements

* R1 新增 `packages/flower-telemetry/src/sinks/http.ts`:`httpSink({ url, token? })`
  * 线格式:`POST <url>`,`Content-Type: application/x-ndjson`,body = 每事件一行
    `JSON.stringify`(与 JSONL 文件**同一行格式** — 服务端一个解析器吃两种来源)
  * 鉴权:`token` 存在时带 `Authorization: Bearer <token>`
  * 批量:攒批发送(缓冲达 `batchSize` 条即发,或距上次发送超 `flushIntervalMs` 由
    下一事件触发;默认值见 design.md),不逐事件 POST
  * 有界缓冲:失败批留在缓冲随下批重试;缓冲超上限丢最旧(绝不无限吃内存)
  * fail-open:发送失败默认静默(`DEBUG_TELEMETRY=1` 单行 warn),带
    `AbortSignal.timeout`,绝不抛错、绝不阻塞主流程
  * `flush()`:把剩余缓冲做最后一次发送尝试(带超时),失败放弃
  * 忽略 `kind === "stream"` 事件;非 critical
* R2 `telemetry-setup.ts` 接线:`FLOWER_TELEMETRY_URL` 已配置时挂载
  `httpSink({ url, token: FLOWER_TELEMETRY_TOKEN })`
* R3 配套同步:`.env.example`、flower-telemetry README、flower-code-reviewer README、
  `types.ts:7` 注释("jsonlSink / siemSink 必须忽略"补上 httpSink)、changeset
* R4 `projectAuditRecord` 增加 `traceId` 字段:SIEM 实时事件与全量 trace 精确关联
  (加字段,payload 向后兼容;四类投影统一补齐)

## Acceptance Criteria

* [ ] httpSink 单测:批量触发(条数/间隔)、stream 过滤、失败重试入缓冲、缓冲上限
  丢弃、flush 收尾、token 头、URL 未配/fetch 异常时 fail-open 不抛错
* [ ] siemSink 单测:四类审计投影均含 `traceId`(R4)
* [ ] telemetry-setup 单测:FLOWER_TELEMETRY_URL 配置与否的挂载行为
* [ ] 全仓 lint / typecheck / test 通过
* [ ] NDJSON 行格式与 jsonlSink 输出逐字节一致(同一事件序列化结果相同)
* [ ] `FLOWER_TELEMETRY=0` 时 httpSink 不收事件(非 critical 语义)

## Definition of Done (team quality bar)

* 单测覆盖上述 AC;lint / typecheck / CI 绿
* README ×2 + .env.example + types.ts 注释同步
* changeset(flower-telemetry minor;若 R4 纳入则 +1 条)

## Out of Scope (explicit)

* flower-observer 服务本身(单独立项:ingest 端点 / 存储 / UI / artifact 补拉)
* ops-bot 产品接线(httpSink 通用,接线归 ops-bot 自己的任务)
* 跨 run 持久化重试(磁盘 spill)— 观测数据可靠性等级不需要;artifact 是备份通道
* 压缩(gzip)、HTTP/2、长连接复用 — YAGNI,量级不需要
* siemSink 行为变更(R4 仅加字段)

## Decision (ADR-lite)

**Context**:常驻观测服务需要全量 trace 数据;原讨论方案为 GitLab webhook + artifact 拉取。
**Decision**:由 telemetry 自己承担推送(httpSink 为主通路),理由:① ops-bot 等常驻产品
无 artifact,推送是唯一通路;② sink 抽象本就为此预留;③ 实时性。artifact 降级为
备份/对账通道,webhook 补拉降级为 observer 二期可选修复通道。R4(audit 加 traceId)
经确认纳入本任务。参数默认值:batchSize=50 / flushIntervalMs=2000 / maxBufferedEvents=2000
/ requestTimeoutMs=2000(对齐 siemSink 超时姿态),详见 design.md。
**Consequences**:observer 宕机期间数据仅有 run 内重试,run 结束即放弃(可接受:
观测级数据,artifact 仍是兜底);服务端必须实现 (traceId, seq) 幂等 ingest。

## Research References

* 前置任务设计:`.trellis/tasks/06-10-flower-telemetry-pipeline/design.md`(sink 体系
  与事件模型;本任务是其"可插拔 sink"扩展点的直接行权)
* 线协议契约与 sink 内部机制:本任务 `design.md`(observer 立项时以此为 ingest 契约)
