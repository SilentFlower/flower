# Research: trace 观测工具 UI 信息架构 → flower-observer MVP 页面设计

- **Query**: 调研 Jaeger / Langfuse / LangSmith / Arize Phoenix 的 trace 列表页与详情页设计，映射到 @flower-ai/flower-telemetry 事件模型，产出 MVP 观测 UI 页面清单
- **Scope**: mixed（外部文档调研 + 内部事件模型 `packages/flower-telemetry/src/types.ts`）
- **Date**: 2026-06-10
- **可信度标注**: 文中 ✅=已抓取官方文档原文验证；🧠=基于对该产品 UI 的通用认知（未逐字验证，但属业界广为人知的形态）

---

## 一、业界四款工具的页面信息架构

### 1. Jaeger（通用分布式追踪，非 LLM 专用）

来源 ✅：https://www.jaegertracing.io/docs/2.0/frontend-ui/（Frontend/UI Configuration，含 Search Page / Trace Page 的 URL 参数清单）

**列表页（Search Page）**
- 搜索表单维度 ✅（embedded 模式 URL 参数即过滤器全集）：`service`、`start`/`end`（时间范围）、`lookback`（回看快捷项，如 "2 Days"，可配置上限）、`minDuration`/`maxDuration`、`limit`（结果上限，可配 `search.maxLimit`，默认示例 1500）；🧠 另有 operation 下拉与 tags 键值输入。
- 结果区上方有 **duration-vs-time 散点图** ✅（`uiSearchHideGraph=1` 可关闭，证明其存在），点散点可跳详情。
- 🧠 每条结果为卡片：trace 名（service+root operation）、短 traceID、总时长、span 数、**红色 error span 计数徽章**、涉及 service 的彩色 chips、相对时间；可按 Most Recent / Longest First 等排序。
- **linkPatterns** ✅：可配置从 tags/process/logs/trace 字段生成外链（模板 `#{field}` 替换），官方示例即"跳转 Kibana 看日志"——**这是「trace 字段 → 外部系统深链」的标准模式**（我们对应：MR 字段 → GitLab MR 页）。
- 全部过滤状态都在 URL query 上 ✅（embedded 模式文档证明）→ 列表页可分享、可书签。

**详情页（Trace Page）**
- 结构 ✅（由 `uiTimelineCollapseTitle` / `uiTimelineHideMinimap` / `uiTimelineHideSummary` 参数反推证实）：**trace 头部摘要**（service 数量等统计）+ **minimap（缩略时间轴，用于刷选区间）** + **主时间线**。
- 🧠 主时间线为 Gantt：每行一个 span，按父子缩进成树，色条长度=耗时、横向位置=开始时刻；行点击展开 span 详情（Tags / Process / Logs 三组键值）；error span 行带红色感叹标。
- 🧠 右上视图切换：Trace Timeline / Trace Graph / Trace Statistics / Trace Spans Table / Trace Flamegraph / Trace JSON。
- Archive ✅：归档的 trace 仅能按 ID 直达、不可搜索（与保留期清理策略相关的先例）。

### 2. Langfuse（LLM 观测，开源可自部署）

来源 ✅：
- https://langfuse.com/docs/observability/data-model（Core Concepts）
- https://langfuse.com/docs/observability/overview
- https://langfuse.com/docs/observability/features/sessions

**数据模型与列表页**
- 三层 ✅：Session（可选，跨 trace 分组）→ Trace（一次请求）→ Observation（步骤，**可嵌套**，类型化：generation、toolcall、RAG retrieval step 等）。
- trace 级属性 ✅（会传播到所有 observation，也是过滤维度）：`user_id`、`session_id`、`tags`、`metadata`、**Environments**（production/staging/dev）、**Releases & Versions**。
- 🧠 Traces 表典型列：Timestamp、Name、Input 预览、Output 预览、Latency、Tokens（in→out）、Cost、Tags、Session、User、Level（warning/error 计数）、Scores；支持**列显隐配置**与行高切换；顶部过滤器构造器（属性+operator）+ 时间范围选择器。
- 导航上 trace 详情有 "Fast Preview / Observations-First" 新形态 ✅（docs 导航可见，细节未抓取）。

**详情页**
- 🧠 左侧 observation **树**（类型图标 + 名称 + 右对齐耗时），可切换 **Timeline（瀑布）视图**；右侧为选中 observation 的详情面板：Input/Output（格式化 pretty ↔ 原始 JSON 切换、长内容折叠）、metadata、model 参数、token/cost。
- generation 类型的 Input/Output 按 **chat 消息形态**渲染（role 标签 + 气泡式分段）🧠。
- **Session 回放** ✅：把同一 `sessionId` 的多条 trace 按时间排成"对话回放"（session replay）——多轮对话的回放单位是 trace；**单条 trace 内部的回放单位是 observation 树**。

### 3. LangSmith（LLM 观测，SaaS；本次抓到的 UI 文档最细）

来源 ✅：
- https://docs.langchain.com/langsmith/observability-concepts（Project → Trace → Run（=span）→ Thread）
- https://docs.langchain.com/langsmith/view-traces（**三视图设计，本次调研最有参考价值的一页**）
- https://docs.langchain.com/langsmith/filter-traces-in-application
- https://docs.langchain.com/langsmith/run-data-format

**列表页**
- 表格顶部 **Threads / Traces / Runs 三个 tab** 切换粒度 ✅；点行打开**右侧侧栏**（side panel）而非整页跳转 ✅。
- 过滤体系 ✅：
  - 左上过滤栏：第一个下拉= 默认/**已保存视图**；Add filter 构造属性过滤。
  - 右侧 **Filter Shortcuts 栏**：按项目中最高频出现的属性自动生成快捷过滤项。
  - operator 集合：`is` / `is not` / `contains` / `does not contain` / `is one of` / `>` `<`（数值）。
  - **Full-Text Search**（input+output 全文，索引前 250 字符）与定向 **Input / Output** 过滤；**键值对过滤**支持点号嵌套路径（如 `generations.message.kwargs.tool_calls.name = Plan`，官方示例就是"按工具调用名找 trace"）。
  - 过滤器可**保存**（项目级）、可**复制为查询语言字符串**（`and(eq(is_root, true), ...)`）。
  - Advanced：Trace filters（按根 run 属性过滤子 run）与 Tree filters（按子 run 属性过滤整树）。
- run 数据字段 ✅（列/详情的数据来源）：`name`、`run_type`（chain/llm/embedding/prompt/tool/retriever/parser）、`status`（success/pending/error）、`error`、`inputs`/`outputs`、`total/prompt/completion_tokens`、`total_cost`、**`first_token_time`（流式 LLM 的首 token 时刻）**。

**详情侧栏：三视图（Messages / Turns / Details）** ✅
- **Messages 视图（对话回放层）**：整个 thread 渲染成对话流；每轮一个块=模型回复+触发的工具调用+工具结果；块的元数据行：token 用量、cost、模型名、跳到 Details 的链接；**Thought（思考）块内联、默认折叠**；子 agent 内联可下钻；**并行/重复工具调用折叠成一行分组**，展开见单次调用；可**下载整个 thread 为 Markdown**。快捷键 M/T/D 切视图。
- **Turns 视图（每轮卡片）**：每轮一张卡，显示该轮根 run 的 input/output，可展开/折叠；**Format 按钮可自选展示哪些 input/output 字段路径**（项目级持久化）。适用于"消息不可渲染"或只想看结构的场景。
- **Details 视图（调试层）**：下钻单个 run 看 inputs/outputs/timing/token/errors/metadata + 子 run 树；`run_type=llm` 自动渲染 token 与延迟，`run_type=tool` 的消息**自动展开**；详情内可继续套过滤器，匹配结果三种展示模式："Filtered Only / Show All / Most relevant" ✅。
- 推荐工作流 ✅：Messages 里扫全局找异常点 → 点进 Details 看具体 run → 回 Messages 继续扫。

### 4. Arize Phoenix（LLM 观测，开源）

来源 ✅：
- https://arize.com/docs/phoenix/tracing/llm-traces（Overview）
- https://arize.com/docs/phoenix/tracing/concepts-tracing/what-are-traces
- https://arize.com/docs/phoenix/tracing/llm-traces/projects
- llms.txt 索引（Sessions / Metrics / Span Replay 等页面摘要）

- 概念 ✅：Project（容器，可配描述与渐变色便于识别）→ Trace → Span；**Span Kind 枚举：CHAIN / RETRIEVER / RERANKER / LLM / EMBEDDING / TOOL / AGENT**（决定 UI 图标与类型化渲染）；span 属性走 OpenInference 语义约定（`llm.input_messages.0.message.role`、`llm.model_name`、`llm.invocation_parameters`、`output.value`、`status_code`）。
- 观测重点 ✅：Application Latency、Token Usage、**Runtime Exceptions**、LLM Parameters、Tool Descriptions、Function Calls。
- Sessions ✅：把多条 trace 按会话分组（多轮对话）；Metrics 页 ✅：latency / token / cost / error rate 监控；**Span Replay** ✅：用不同 prompt 重放某次 LLM 调用（属 prompt 工程功能，我们不需要）。
- 🧠 项目内 Traces/Spans 两个表 tab；trace 详情=左树+瀑布条+右侧 span 详情面板（Info/Attributes/Events tab）。

---

## 二、跨工具的共识模式（业界标准做法）

| # | 共识模式 | 出处 |
|---|---|---|
| C1 | **两页核心 IA**：列表（搜索/过滤）+ 详情（树/时间线 + 选中节点详情面板），master-detail | 四家皆是 |
| C2 | 列表标准列：**时间、名称/身份、状态(成功/错误)、时长、span/事件计数、token/cost、tags** | Jaeger/Langfuse/LangSmith/Phoenix |
| C3 | 过滤器第一公民：**时间范围（含 lookback 快捷项）**、状态/错误、名称/类型、tags/metadata 键值、min/max 时长 | Jaeger ✅ + LangSmith ✅ |
| C4 | **高频过滤快捷入口**（Filter Shortcuts / 保存的过滤视图） | LangSmith ✅ |
| C5 | 详情页 = **头部摘要 + 层级树（类型图标+右对齐耗时）+ 瀑布/时间线（可切换）+ 右侧详情面板** | 四家皆是 |
| C6 | **Input/Output 折叠展示**：长内容默认折叠/截断，pretty ↔ raw JSON 切换；LLM 调用按 chat 消息形态渲染、thinking 默认折叠、工具调用+结果配对成卡片 | Langfuse 🧠 + LangSmith ✅ |
| C7 | **错误状态沿树上浮**：span 级 error 标红 + trace 行级 error 计数徽章 | Jaeger 🧠 + LangSmith ✅(status) |
| C8 | **span 类型枚举 → 图标/配色/类型化渲染**（llm/tool/chain/retriever...） | LangSmith ✅ + Phoenix ✅ |
| C9 | **URL 即状态**：过滤条件、选中 span 都在 query 参数里，链接可分享 | Jaeger ✅ |
| C10 | **字段 → 外部系统深链**（linkPatterns 模板） | Jaeger ✅ |
| C11 | 对话回放（Messages/Session replay）作为**树视图之外的第二种阅读形态**，单位是"轮" | LangSmith ✅ + Langfuse ✅ |
| C12 | 指标页独立于列表/详情：latency、错误率、token/cost 的时序与聚合 | Phoenix ✅ + Jaeger(Monitor tab) ✅ |

---

## 三、映射到我们的事件模型（差异与定制点）

事件模型源：`packages/flower-telemetry/src/types.ts`（字段显式声明，UI 可直接依赖 schema）。

| 业界概念 | 我们的对应物 | 差异/定制 |
|---|---|---|
| project / service | `product`（code-reviewer/ops-bot）+ `correlation.project`（GitLab 项目） | 双层：product 是应用维度，project 是业务维度，都要可过滤 |
| trace | 一次评审 run（`trace_start`…`trace_end`） | 完整性可精确判定：**收到 trace_end=收齐，`seq` 单调递增可检测缺口**（业界无此机制，是我们的定制状态） |
| span 层级（parent_id 树） | **无 parent_id**！只有 `spanType` + `turnIndex` + `attempt` + `seq` | 树要靠 `attempt → turnIndex → seq` 重建（agent→turn→llm_call/tool_call/tool_result 三层）；`tool_call`/`tool_result` 用 `toolCallId` 配对 |
| span 开始/结束时间（Gantt 的基础） | span 在**完成时刻**发出，仅有 `ts`（完成时间）+ `durationMs` | 可用 `ts - durationMs` 推出 start 画简化瀑布；但 tool_call（意图，无结果）无耗时语义。**完整 Gantt 不是 MVP 刚需** |
| status (success/error) | `llm_call.status`（HTTP 码）、`tool_result.isError`、`run_summary.exitCode` | trace 级状态需推导：运行中(无 trace_end)/成功(exitCode=0)/失败(exitCode≠0)/不完整(seq 缺口) |
| token/cost 列 | 仅 `agent.usage`（最后一条 assistant 消息的 input/output/total），**无 cost、无 per-call usage** | 列表页只能展示 attempt 级 usage，cost 列砍掉 |
| first_token_time (TTFT) | `TurnTiming.firstTextDeltaMs` 及整套 timing 分解（providerResponseHeadersMs、toolTotalMs、providerPendingMs…） | **比业界更细**（业界单值，我们每轮十余项分解）→ turn 节点展开式 timing 明细是定制亮点 |
| Messages 对话回放 | **做不到完整对话回放**：thinking/text 增量是 `stream` 事件，**不入库不推送**（仅 consoleSink） | 回放退化为**行为回放**：每轮"调了什么工具(脱敏 input)→得到什么结果→发了什么评论"。无 assistant 正文。必须在设计上明示此边界 |
| feedback / scores / annotations | `outcome` 事件（line_comment/self_check/security_block/run_summary）——**业务真值随 trace 一起到达**，无需人工标注 | 业界没有"评审产出"一等公民；**outcome 区块是我们最大的定制页面元素** |
| 安全拦截 | `security_block`（tool/mode/reason/command，`toolCallId` 可挂回对应 tool_call 节点） | 业界无对应物；需要红色高亮 + 节点内联"被拦截"标记 |
| 外链 linkPatterns | `correlation` 四元组 → GitLab MR 页 / commit / pipeline 页；`line_comment.file+line` → MR diff 行锚点 | 直接套 Jaeger linkPatterns 思想，写死 GitLab URL 模板即可 |
| session / thread（多轮对话分组） | 不需要：一次评审=一条 trace，自包含；同一 MR 多次评审用列表页按 mrIid 过滤即可 | 可在详情页放"同 MR 历史评审"侧链接（轻量替代 thread） |

---

## 四、产出：flower-observer MVP 页面清单（2 页 + 1 可选页）

### 页面 1：评审列表页 `/traces`（默认首页）

**列（从左到右）**

| 列名 | 数据来源 | 模式标注 |
|---|---|---|
| 状态 | 推导：●运行中（有 trace_start 无 trace_end）/ ✓成功（run_summary.exitCode=0）/ ✗失败（exitCode≠0 或 agent.errorMessage）/ ⚠不完整（seq 缺口或超时未收尾） | C2 共识列；四态推导规则为**定制** |
| 时间 | trace_start.ts（相对时间，悬停绝对时间） | 共识 C2 |
| 项目 | correlation.project | **定制**（≈Jaeger service 维度） |
| MR | correlation.mrIid 渲染为 `!123`，外链 GitLab MR | **定制**，套 C10 linkPatterns |
| Commit / Pipeline | commitSha 前 8 位 + pipelineId，各自外链 | **定制**，C10 |
| Product | product 徽章（code-reviewer/ops-bot 不同色） | 共识（≈project 切换维度） |
| 时长 | trace_end.totals.durationMs（人性化格式 1m 23s） | 共识 C2 |
| 轮/工具 | totals.turns、totals.toolCalls（如 `6 turns · 14 tools`） | 半定制（≈span 计数列） |
| 评论 | line_comment 计数，blocker 级红色徽章单列或叠加 | **定制**（≈Langfuse scores 列的位置） |
| 拦截 | security_block 计数，>0 红色盾牌图标 | **定制**（≈错误徽章 C7 的位置） |

**过滤器（顶部一行）**
- 时间范围 + lookback 快捷项（1h / 24h / 7d / 30d）——共识 C3，默认 7d
- project 下拉（distinct 值）、MR IID 精确输入——定制
- 状态多选（运行中/成功/失败/不完整）、product 下拉——共识 C3
- 快捷开关（chips）："有拦截"、"有 blocker 评论"、"零评论"——借 LangSmith Filter Shortcuts（C4）思想，但**写死 3 个**而非动态生成（MVP 简化）
- min/max 时长（Jaeger 模式）→ 二期；全文搜索（input/output 250 字符索引那套）→ 二期

**交互**
- 默认按时间倒序，分页（每页 50）；行点击 → 详情页（MVP 用整页跳转即可；LangSmith 的侧栏模式二期再说）
- 过滤状态全部进 URL query（C9 共识）
- 列表顶部一条统计 bar：今日评审数 / 失败数 / 平均时长（若砍掉页面 3，这里是其残留形态）

### 页面 2：评审详情页（回放）`/traces/:traceId`

**区块 A：头部摘要**（共识 C5 之 trace header）
- 第一行：状态徽章 + `project !mrIid` 大标题（外链）+ commit/pipeline 小链接 + product 徽章 + reason
- 第二行指标条：总时长 | turns | toolCalls | attempt 数 | 评论数(按 severity 分色) | 拦截数 | exitCode | skillUsed（来自 run_summary）
- ⚠不完整时显著黄条提示："seq 缺口 12–15，事件可能丢失"（**定制**，依赖 seq 单调性）

**区块 B：执行流（主体左栏）**——树 + 简化瀑布
- 层级（由 attempt/turnIndex/seq 重建，**定制重建逻辑**）：
  - `agent` attempt 节点：attempt 序号、stopReason、usage(in/out/total)、errorMessage（有则红）
  - `turn` 节点：turn N、durationMs 横条（相对 trace 总时长，简化瀑布，共识 C5 的降级实现）；**展开显示 timing 分解表**（firstTextDeltaMs、providerResponseHeadersMs、toolTotalMs、providerPendingMs…，undefined 显示 n/a）——**定制亮点，业界无此粒度**
  - 叶子节点（带类型图标，C8 共识）：
    - `llm_call`：图标 ⚡，`#request 序号 · HTTP status · durationMs`，非 2xx 标红
    - `tool_call + tool_result` 按 toolCallId **配对渲染为单节点**（C6 共识的工具卡片形态）：工具名 + inputKeys 摘要 + 执行耗时；isError 红；**被 security_block 关联的节点内联红色"已拦截：reason"条**（定制）
    - `line_comment` outcome 按 seq **内联**在流中：💬 `file:line [severity] title`（定制——这是"回放感"的来源：能看到第几轮发的哪条评论）
- 顶部小开关：「树状」↔「时间顺序平铺」（按 seq 线性流，最接近回放语义；实现成本低，建议 MVP 两种都给——本质同一数据两种排序/缩进）
- **明确边界**：无 assistant 正文/thinking（stream 事件不入库），节点行不承诺消息内容——区别于 LangSmith Messages 视图，我们是**行为回放**不是对话回放

**区块 C：选中节点详情面板（右栏）**（共识 C5/C6）
- tool_call：input 完整 JSON（pretty ↔ raw 切换，默认折叠超过 ~20 行的内容）+ inputKeys + "已脱敏/可能截断(单字段≤4000字符)"灰字标注（**定制提示**）
- tool_result：result 同上 + isError
- turn：timing 全表；agent：usage/stopReason/errorMessage；llm_call：status/request/durationMs
- 面板内显示该事件原始 JSON 的入口（≈Jaeger Trace JSON，调试兜底）

**区块 D：产出汇总 tab（与区块 B 平级的第二个 tab：「执行流」/「产出」）**（**整体定制**，业界最接近物是 feedback/scores 区）
- 评论表：file / line / severity（徽章色：blocker 红、major 橙、minor 灰）/ title，行点击外链 GitLab MR diff 对应行
- 拦截表：tool / mode / reason / command（等宽字体），点击可跳回执行流中对应节点（toolCallId 锚点）
- self_check 卡片：unsupportedFiles 列表、blockerCount、workspacePrepareCount
- run_summary 卡片：exitCode、skillUsed、blockerCount、unsupportedFileCount

### 页面 3（可选，对应 PRD Q3 的"+指标面板"）：概览页 `/metrics`

共识 C12（Phoenix Metrics / Jaeger Monitor），全部由已存事件聚合可得：
- 卡片行：近 7 天评审次数、成功率、P50/P95 时长、平均评论数/评审、拦截总数
- 图：按天评审次数柱状图（product 分组）、时长分布直方图、severity 分布饼/条
- 表：最慢评审 Top 10（链接详情页）、按 project 聚合的评审次数
- **取舍建议**：若 MVP 砍此页，将"今日评审数/失败数/平均时长"并入列表页顶部统计条即可，不损核心场景（按 MR 找评审 + 回放）

### 导航骨架
顶栏：Logo + 「评审」(/traces) + 「概览」(/metrics，可选) + product 全局切换下拉（≈Langfuse/Phoenix 的 project 切换位）+ 时间范围全局选择器。无登录页（共享 token 走反代/前端注入，PRD 假设无多租户）。

---

## 五、关键结论（给设计/实现的提要）

1. MVP = **列表 + 详情两页**即可覆盖 PRD 的三个核心问题（按 MR/项目找评审、回放过程、看拦截与瓶颈）；指标页第三页可选。
2. 详情页不要追求 Jaeger 式完整 Gantt：我们的 span 无 parent_id、完成时刻打点，**树靠 attempt/turnIndex/seq 重建 + 耗时横条**即够用；这是对共识 C5 的合理降级。
3. **对话回放做不到**（stream 不入库），定位成**行为回放**：执行流中内联 line_comment、tool_call/result 配对卡片、security_block 锚点关联——这三个内联是我们与业界差异最大的定制点。
4. timing 分解（TurnTiming 十余字段）是超出业界粒度的资产，用 turn 节点"展开见明细表"承载，回答"卡在哪"。
5. 外链策略照抄 Jaeger linkPatterns 思想：correlation 四元组 + line_comment.file/line 全部模板化拼 GitLab URL。
6. trace 四态状态（运行中/成功/失败/不完整）是列表页第一列，推导规则要在 server 端物化（列表查询不能每行扫事件）。

## 六、来源清单

| 来源 | 验证方式 |
|---|---|
| `packages/flower-telemetry/src/types.ts`（事件模型真值） | ✅ 全文已读 |
| `.trellis/tasks/06-10-flower-observer/prd.md`（量级/契约/开放问题） | ✅ 全文已读 |
| Jaeger Frontend/UI Configuration: https://www.jaegertracing.io/docs/2.0/frontend-ui/ | ✅ 抓取全文 |
| Langfuse Core Concepts: https://langfuse.com/docs/observability/data-model | ✅ 抓取全文 |
| Langfuse Observability Overview: https://langfuse.com/docs/observability/overview | ✅ 抓取全文 |
| Langfuse Sessions: https://langfuse.com/docs/observability/features/sessions | ✅ 抓取全文 |
| LangSmith Observability concepts: https://docs.langchain.com/langsmith/observability-concepts | ✅ 抓取全文 |
| LangSmith View traces（Messages/Turns/Details 三视图）: https://docs.langchain.com/langsmith/view-traces | ✅ 抓取全文 |
| LangSmith Filter traces: https://docs.langchain.com/langsmith/filter-traces-in-application | ✅ 抓取全文 |
| LangSmith Run data format: https://docs.langchain.com/langsmith/run-data-format | ✅ 抓取全文 |
| Phoenix What are Traces（Span Kind 枚举）: https://arize.com/docs/phoenix/tracing/concepts-tracing/what-are-traces | ✅ 抓取全文 |
| Phoenix Tracing Overview / Projects: https://arize.com/docs/phoenix/tracing/llm-traces | ✅ 抓取全文 |
| Jaeger Gantt 细节、Langfuse 表格列与详情布局、Phoenix 表格布局 | 🧠 通用认知，文中已逐处标注 |

## Caveats / Not Found

- Langfuse「Fast Preview（Observations-First）」新版详情页只确认存在（docs 导航），具体布局未抓到原文。
- Langfuse trace 列表的精确列名集合、Phoenix 表格精确列名为 🧠 认知，未逐字验证（不影响结论：我们的列以自有字段为准，仅借共识位次）。
- 本文未调研技术选型（表格/图表组件库），那是 `research/tech-stack.md` 的范围。
