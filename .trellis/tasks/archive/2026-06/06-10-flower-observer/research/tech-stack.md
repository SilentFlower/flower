# Research: flower-observer 技术选型(HTTP framework / SQLite 方案 / dashboard UI 形态)

- **Query**: 内网常驻观测服务(接收 NDJSON 事件推送 + 小型 dashboard UI)的技术选型比较与推荐
- **Scope**: mixed(仓内约束盘点 + npm registry / Node 官方 changelog·docs / GitHub release 资产核实)
- **Date**: 2026-06-10
- **数据时效**: 版本号与稳定性状态均为 2026-06-10 当天从 npm registry / nodejs.org / GitHub API 实时拉取,非记忆值

## 仓内约束盘点(选型的硬边界)

| 约束 | 仓内证据 |
|---|---|
| Node `>=22.19.0`,容器基于 `node:22-alpine`(musl) | 根 `package.json` engines;`packages/flower-ops-bot/Dockerfile`、`packages/flower-code-reviewer/Dockerfile` |
| 纯 ESM + TS strict(`module: ESNext` / `moduleResolution: Bundler` / composite) | 根 `package.json` `"type": "module"`;`tsconfig.base.json` |
| 常驻服务先例 = **裸 `node:http`**,无任何框架 | `packages/flower-ops-bot/src/server.ts:13`,文件头注释明示「故意只用 Node 内置 http 模块,避免引入额外框架。路由表手写」 |
| 全仓目前 **没有** fastify / hono / express / koa / vite / react / vue(grep 命中的只是 `vitest` 子串) | 各 `packages/*/package.json` |
| native 模块在 alpine 有先例处理:koffi 自带 `musl_x64` 预编译,Dockerfile 只做了「裁掉其他 17 个架构」 | `packages/flower-code-reviewer/Dockerfile:57-58` |
| ingest 线协议已钉死:`POST` + `Content-Type: application/x-ndjson`,body 为多行 `JSON.stringify(TelemetryEvent)`,可选 `Authorization: Bearer`,2xx 即成功 | `packages/flower-telemetry/src/sinks/http.ts:104-130` |
| 工具链:biome 2.3.5 / vitest 3.2.4 / tsx 4.20 / TS 5.9 | 根 `package.json` + `flower-telemetry`、`flower-ops-bot` 的 package.json |
| 本机运行时实测:Node v22.21.1 | `node --version` |

---

## 维度 1:HTTP framework

需求画像:6~8 条路由(ingest NDJSON / SIEM 单条 JSON / 若干查询 JSON API / 静态资源或 HTML 页面 / healthz),单实例内网,无需限流网关、schema 校验等重型能力。

| 候选 | 版本(实查) | 直接依赖数 | ESM/TS 友好度 | NDJSON 原始 text body | 静态/HTML | 维护活跃度 | 适配本约束 |
|---|---|---|---|---|---|---|---|
| **Hono** + `@hono/node-server` | 4.12.25 / 2.0.4 | **0 + 0** | TS-first,类型即卖点,纯 ESM 无障碍 | `await c.req.text()` 一行拿原始体,不会被 JSON 解析器截胡 | adapter 自带 `serveStatic`(`@hono/node-server/serve-static`),`c.html()` 直出页面 | 非常活跃(4.x 高频发版) | ✅ 最佳:零运行时依赖、node-server 要求 Node>=20 |
| **裸 `node:http`** | Node 内置 | **0 包** | 内置模块,TS 类型来自 `@types/node` | 手收 chunk 拼 Buffer→string,约 10 行 | 手写(MVP 可把 HTML/JS 内联成模板字符串;真静态目录约 30 行 + content-type 表) | 随 Node 演进 | ✅ 可行且与 ops-bot 先例一致;路由/静态/query 解析全手写,API 数量涨了之后样板代码变多 |
| **Fastify** | 5.8.5(+`@fastify/static` 9.1.3) | 15(+6) | v5 官方要求 Node>=20,ESM/TS 支持成熟但类型偏「泛型体操」 | 需注册 `addContentTypeParser("application/x-ndjson", { parseAs: "string" })`,可做但属额外心智 | 需装 `@fastify/static` 插件 | 非常活跃 | ⚠️ 能力全面但本场景用不到 schema 校验/pino/插件体系,依赖树明显偏重 |
| **Express** | 5.2.1 | **28** | engines>=18;CJS 血统(ESM 下靠 interop),类型靠独立 `@types/express` | `express.text({ type: "application/x-ndjson" })` 可拿原始体 | `express.static` 内置 | v5 已于 2024 末发布,维护回暖但节奏慢 | ❌ 依赖最多、TS/ESM 体验最弱,无任何相对优势 |

**结论**:**主推 Hono + `@hono/node-server`**——两个包合计 0 个运行时依赖,与「依赖越少越好」几乎无冲突,却把路由、`c.req.text()`(NDJSON 关键点)、`serveStatic`、`c.html()` 全部补齐;TS 体验全场最佳。**保守替代:裸 `node:http`**(与 ops-bot 先例完全一致,绝对零依赖),若团队倾向延续先例也完全成立,代价是 UI 查询 API 增多后手写样板上升。Fastify/Express 在本场景无差异化收益。

---

## 维度 2:SQLite 方案(+ 是否直接上 Postgres)

需求画像:每天几十~几百次评审 × 每次数百事件(日增万级行,单字段 ≤4000 字符),`(traceId, seq)` 幂等 upsert,单实例单进程写入,UI 侧并发读。

| 候选 | 版本/状态(实查) | API 形态 | WAL/并发 | alpine(musl)构建 | 适配本约束 |
|---|---|---|---|---|---|
| **`node:sqlite`(内置)** | v22.5.0 引入;**v22.13.0 'Jod'(2025-01-07,PR #55890)起免 flag**→ 本仓 engines `>=22.19.0` 必然免 flag。稳定性:Node 22 文档 = 1.1 Active development(运行时打 ExperimentalWarning);**Node 24 文档 = 1.2 Release candidate**(当前 LTS 24.16.0) | **同步**(`DatabaseSync`/`StatementSync`),本机 v22.21.1 实测:`PRAGMA journal_mode=WAL` 对文件库生效、`ON CONFLICT(trace_id,seq) DO UPDATE` 幂等 upsert 通过;方法面齐全(`all/get/run/iterate/columns` + `function/aggregate/backup/createSession`) | WAL 可开;单进程同步写天然串行,读不阻塞 | **零构建问题**(随 Node 二进制内置,与 musl 无关) | ✅ 最佳:0 依赖、0 安装风险、API 与 better-sqlite3 同范式 |
| **better-sqlite3** | 12.10.0,engines `20.x~26.x` | 同步,事实标准,性能最强,生态文档最厚 | WAL 成熟 | v12.10.0 GitHub release **已带 `node-v127-linuxmusl-x64/arm64` 预编译**(v127 = Node 22 ABI)→ alpine 通常免编译。**但** 走 `prebuild-install`,二进制在 `npm install` 时从 **github.com release 资产**下载——本仓构建发生在内网 GitLab CI / Harbor 环境,若 GitHub 不可达即回退源码编译,需在 builder 阶段 `apk add python3 make g++` | ⚠️ 可行,是 node:sqlite 的标准逃生口;多一个 native 依赖 + 内网拉 GitHub 的不确定性 |
| **libsql(`@libsql/client`)** | client 0.17.3(5 个依赖)+ libsql 0.5.29;仍是 0.x | **异步 Promise**(无同步 API),面向 Turso/远端副本场景 | WAL 可用 | 预编译以 npm `optionalDependencies` 分发(含 `@libsql/linux-x64-musl`),走 npm registry 不碰 GitHub,内网镜像友好 | ❌ 本地单文件场景下抽象过重、API 异步化无收益、0.x 版本号;其安装分发方式(npm 带二进制)反而是三者里对内网 CI 最稳的,仅此一点值得记录 |

### SQLite vs Postgres

| | SQLite(任一实现) | Postgres |
|---|---|---|
| 运维面 | 一个 `.db` 文件 + volume;备份 = 拷文件(或 `backup()` API);升级 = 换镜像 | 多一个常驻容器/实例:密码管理、连接池、pg_dump 备份计划、大版本升级迁移、磁盘监控 |
| 本量级匹配 | 日增万级行、单写者——距 SQLite 舒适区上限(亿级行、单写)还有几个数量级 | 能力全部过剩 |
| 驱动 | 内置/同步,0~1 依赖 | `pg` 异步驱动 + 池管理 |
| 何时才需要 | — | 多实例写入、多服务共享库、复杂分析并发时 |

**结论**:**SQLite,且首选内置 `node:sqlite`**——零依赖零构建,WAL + 幂等 upsert 实测满足 ingest 契约,Node 24 已是 RC 级稳定(本仓 22 上仅有一条 ExperimentalWarning 噪音,可用 `node --disable-warning=ExperimentalWarning` 压掉);落地时把 DB 访问收进一个薄 DAO 模块,万一踩到缺口,切 better-sqlite3 是同范式同步 API 的一文件改动。**Postgres 明确否决**:单实例内网小量级下纯增运维负担,违背「零运维优先」。

---

## 维度 3:dashboard UI 形态

需求画像:trace 列表(过滤)/ trace 详情回放(按 seq 顺序渲染 span/outcome 流)/ 基础指标图。使用者为内部研发,无多租户。注意:**本仓目前没有任何前端构建链**,引入 Vite SPA 即开辟 monorepo 第一条前端工具链。

| 候选 | 构建步骤 | 维护成本 | 与需求匹配 | 适配本约束 |
|---|---|---|---|---|
| **服务端整页 HTML(模板字符串/`c.html()`)+ 原生 JS `fetch` + 可选 htmx 2.0.10(min 约 50KB / gzip 约 14KB,vendor 单文件)** | **无** | 最低:无新工具链、无 node_modules 前端分支、biome 可直接管 `.js` | 列表+过滤 = 表格 + querystring;「回放」本质是按 seq 排序渲染事件流(服务端直出或 fetch 后逐条渲染),无需 SPA 路由;htmx 适合「点击行→加载详情片段」交互 | ✅ 最佳 |
| 无构建组件方案(preact 10.29.2 + htm,或 lit-html 3.3.3,ESM 文件直引) | 无 | 低-中:引入组件心智但免构建 | 详情回放若交互复杂(折叠/高亮/搜索)比裸 DOM 操作舒服 | ⚠️ 中间档,MVP 不必,列为升级第一站 |
| **Vite SPA(React/Vue)** | 有(vite + 框架 + 类型 + dev proxy + dist 进 Docker 多阶段) | 高:monorepo 首条前端构建链,CI/Dockerfile/biome 配置全要扩 | 能力过剩;对「列表+详情+几张图」无质变收益 | ❌ MVP 否决,仅当 UI 演进出富交互(实时流、虚拟滚动、复杂联动)再评估 |

### 图表轻量方案(如需)

| 候选 | 版本(实查) | 体积 | 评价 |
|---|---|---|---|
| **uPlot** | 1.6.32(npm unpacked 545KB,min 约 50KB / gzip 约 12KB) | 最小 | 时间序列特化(评审次数/耗时/token 趋势正是这类),vendor 单文件即用;API 偏低阶但图就两三张,一次成本 |
| Chart.js | 4.5.1(npm unpacked 约 6MB,bundle gzip 约 70KB) | 中 | API 最友好、图型最全(柱/环形)、canvas 自适应;若指标面板要混合图型,选它换省心 |
| 纯 SVG 手写 | — | 0 | 仅适合 sparkline/小色条;一旦要坐标轴+tooltip,手写成本超过 vendor uPlot 的 12KB |

**结论**:**服务端 HTML + 原生 JS(可选 htmx),图表按需 vendor uPlot 单文件进 `static/vendor/`**(内网离线可用,无 CDN 依赖);指标面板若图型种类变多,Chart.js 是可接受的替换。Vite SPA 不进 MVP。

---

## 最终推荐组合

> **Hono(+`@hono/node-server`) + 内置 `node:sqlite`(WAL) + 无构建服务端 HTML/原生 JS(htmx、uPlot 按需 vendor)**
> ——一句话理由:三层合计仅 2 个零运行时依赖的 npm 包 + 0 个 native 模块 + 0 条前端构建链,在 `node:22-alpine`/ESM/TS-strict 下无任何兼容性工序,与 ops-bot「tsx watch / node dist/server.js / 自有 Dockerfile」常驻形态直接对齐,是该量级内网观测服务的零运维最优解。

退路矩阵(落地时按此预留):HTTP 层不想要任何框架 → 裸 `node:http`(ops-bot 同款);`node:sqlite` 踩缺口 → better-sqlite3(同步同范式,注意内网 CI 拉 GitHub prebuild 的网络面,备好 `apk add python3 make g++`);UI 交互膨胀 → 先 preact+htm 免构建,再考虑 Vite。

## Caveats / 待确认

- `node:sqlite` 在 Node 22 运行时会打一条 `ExperimentalWarning`(vitest/生产日志可见),可用 `--disable-warning=ExperimentalWarning` 压制;其在 22 文档标 1.1、24 文档标 1.2(RC)——若未来仓库升 Node 24 LTS(24.16.0 'Krypton'),此顾虑进一步消失。
- better-sqlite3 的 musl 预编译虽已覆盖 Node 22(ABI v127),但分发渠道是 GitHub release 资产,**未实测内网 GitLab CI 能否直连 github.com**;若选它需先验证或直接预装编译工具链。
- htmx/uPlot/Chart.js 的 gzip 体积为官方口径的约数(min 文件未逐一下载称重),不影响数量级结论。
- 「trace 回放」按 PRD 理解为按 seq 顺序渲染事件流(非动画播放);若后续 Q3 收敛出实时跟播(SSE)需求,Hono 与裸 http 均原生支持 SSE,不改变本结论。
