# trellis 多包配置与 spec 补全(flower-telemetry / flower-observer)

## Goal

flower-telemetry 注册进 .trellis/config.yaml packages(flower-observer 已注册);为两个包新建 .trellis/spec/<pkg>/ 规范目录(index.md + 分层指南),沉淀:node:sqlite WAL/upsert 实测范式、httpSink 线协议服务端实现要点(幂等/禁3xx/坏行容忍)、跨通道计数去重模式、telemetry sink 实现约定(fail-open/不抛错)、tsc --build 指定包构建避 TS5083 技巧

## Requirements

### R1 · packages 注册(配置)

- `.trellis/config.yaml` 的 `packages` 增加 `flower-telemetry`(`path: packages/flower-telemetry`),按现有条目字母序插入。
- 核对 `flower-observer` 已注册(已存在,无需改动)。

### R2 · 新建 `.trellis/spec/flower-telemetry/backend/`(客户端侧沉淀)

- `index.md`:风格对齐现有包索引(指南表格 + When-to-Use 触发清单)。
- sink 实现约定指南,覆盖:
  - **fail-open / 不抛错**:sink 内吞掉所有 fetch/IO 异常,仅 `DEBUG_TELEMETRY=1` 时单行 warn;telemetry 故障绝不阻塞业务主流程。
  - **httpSink 客户端线协议要点**:NDJSON 批量推送、幂等键设计(超时重发同批,由服务端按 `(traceId, seq)` 去重)、不跟随 3xx 重定向、`AbortSignal.timeout` 限时。
- 素材出处:`archive/2026-06/06-10-telemetry-http-sink/design.md`、`06-10-flower-telemetry-pipeline/design.md` 及 `packages/flower-telemetry/src/`(`pipeline.ts` / `sinks/`)现状。

### R3 · 新建 `.trellis/spec/flower-observer/backend/`(服务端侧沉淀)

- `index.md`:同上风格。
- 数据库指南:**node:sqlite 实测范式** — WAL 模式开启姿势、`INSERT ... ON CONFLICT` upsert 幂等入库、`(traceId, seq)` 去重键设计。
- ingest 协议指南:**httpSink 线协议服务端要点** — 幂等入库、禁 3xx(只回 2xx/4xx/5xx)、坏行容忍(单行解析失败不拒整批)、可选 Bearer 鉴权(未配置=内网裸跑,失败 401 不影响客户端 fail-open)。
- **跨通道计数去重模式**(metrics 统计口径):按素材量并入 ingest 指南或独立成篇,实现时定。
- 素材出处:`archive/2026-06/06-10-flower-observer/design.md`、`implement.md` 及 `packages/flower-observer/src/`(`db.ts` / `ingest.ts` / `metrics.ts`)现状。

### R4 · 构建技巧沉淀

- **tsc --build 指定包构建避 TS5083**:给出可复制的命令范式与适用场景,落在两个包 spec 之一并从另一侧索引互链(或各自简记)。

### R5 · 风格与边界

- 新增 spec 与现有 13 个 index 的结构、语言(中文)、表格风格保持一致。
- 仅新增文件 + config.yaml 一处注册;不改既有 spec 内容(`guides/index.md` 如需互链,只增不删改)。

## Acceptance Criteria

- [ ] `.trellis/config.yaml` packages 含 `flower-telemetry` 且 path 正确;`python3 ./.trellis/scripts/task.py list` 等脚本运行无报错。
- [ ] `.trellis/spec/flower-telemetry/backend/` 存在 `index.md` + ≥1 个指南文件,覆盖:sink fail-open/不抛错约定、httpSink 客户端线协议要点。
- [ ] `.trellis/spec/flower-observer/backend/` 存在 `index.md` + ≥1 个指南文件,覆盖:node:sqlite WAL/upsert 范式、服务端 ingest 要点(幂等/禁3xx/坏行容忍)、跨通道计数去重模式。
- [ ] TS5083 构建技巧已沉淀且两个包索引均可达(本包成文或互链)。
- [ ] 所有知识点标注真实出处(`packages/` 代码路径或 archive 任务文档),无凭空杜撰内容。
- [ ] 纯文档 + 配置变更:`git diff` 仅触及 `.trellis/`,不改任何 `packages/*/src` 代码。

## Notes

- 轻量文档任务,PRD-only(不另写 design.md / implement.md)。
- 素材集中在 `.trellis/tasks/archive/2026-06/` 下三个已归档任务的 design/implement 文档,实现时先读素材再落笔,引用需核对行号/文件名仍有效。
