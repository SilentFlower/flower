# Research: 6 个 package 5 字段卡片资料(不含 flower-code-reviewer)

- **Query**: 读 6 个 package 源码,抽取 5 字段卡片资料,产出供 intro.html B2 节使用
- **Scope**: internal(本仓库 `packages/*` 源码)
- **Date**: 2026-05-22

支撑 PRD R13(5 字段统一模板)+ design.md §3.2(B2.2-B2.7)。
顺序:flower-providers / flower-tools-gitlab / flower-tools-common / flower-tools-arms / flower-compliance / flower-ops-bot。

---

## flower-providers

### 一句话定位

把目标 LLM 网关(自部署 vLLM / 内部 AI Gateway / 任意 OpenAI 兼容代理)统一接入 pi 系列 agent,集中管理 `baseUrl` / API key / 模型清单 / `X-App-Source` header(来源:`packages/flower-providers/src/index.ts:3-7`、`README.md` "职责"节)。

### 职责(做什么)

- 注册 4 个 `havefun-*` provider 到 pi-coding-agent(`havefun-openai` / `havefun-openai-responses` / `havefun-anthropic` / `havefun-gemini`),每个 provider 自动按 `nativeApi` 挂载内置模型子集(`src/register.ts:registerHavefunProviders` / `src/catalog.ts:BUILTIN_MODELS`)
- 维护 8 条内置模型清单:Claude 3 条 / Gemini 3 条 / GPT-5.x 2 条(`src/catalog.ts:BUILTIN_MODELS`)
- 把 `LLM_*` env(`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_PROVIDER` / `LLM_MODEL` / `LLM_REASONING_EFFORT` / `LLM_EXTRA_MODELS_JSON`)集中校验、缺失 / 非法值 fail-fast(`src/env.ts`)
- 对 CLI 路径(`buildPiCliArgs`)与 SDK 路径(`buildHavefunModel` + `getDefaultReasoningEffort`)对称暴露:前者给 code-reviewer 用,后者给 ops-bot 用(`src/runtime.ts`)
- 处理 4 套 LLM SDK 的 `baseUrl` 后缀差异:openai-* 拼 `/v1`,gemini 拼 `/v1beta`,anthropic 不拼(`src/catalog.ts:PROVIDER_PATH_SUFFIX`)
- 处理 `thinkingLevelMap` 与 `thinkingBudgets` 等家族特性(如 Opus 4.7 `xhigh → "max"`)的桥接(`src/catalog.ts:150-171`)

### 边界(不做什么)

- **不发 LLM 请求**:本包只负责"注册"与"argv 翻译",真正发请求由 pi-ai SDK / pi-coding-agent / pi-agent-core 完成
- **不存 API key**:`apiKey` 字段传字符串字面量 `"LLM_API_KEY"`,由 pi 自己 resolve;明文 key 不经过本包代码(`src/env.ts:getLLMApiKeyEnvName:106-125`)
- **不参与 prompt / tool dispatch**:不读 MR / 不发评论 / 不调监控 API,这些由 `flower-tools-*` + 各产品自身负责
- **不持有 model 合法性的全部知识**:`getLLMModelOrDefault()` 只做"非空字符串透传",model 与 provider 协议是否匹配由 `getDefaultModel()` / `buildHavefunModel()` 校验(`src/env.ts:181-192`)

### 对外契约

| 导出 | 类型 | 用途 |
|---|---|---|
| `registerHavefunProviders(pi, { appSource })` | function | 给 pi-coding-agent 形态(code-reviewer)注册 4 个 provider(`src/register.ts:57`) |
| `getDefaultModel()` | function | 读 `LLM_PROVIDER` + `LLM_MODEL`,返回 `{ provider, modelId }`,缺失 fail-fast(`src/runtime.ts:99`) |
| `buildHavefunModel(provider, modelId)` | function | 构造 pi-ai `Model<Api>` 对象,给 pi-agent-core 形态(ops-bot)用(`src/runtime.ts:135`) |
| `getDefaultReasoningEffort(modelId?)` | function | 返回当前调用应使用的 effort:env > per-model 默认 > 全局 `"high"`(`src/runtime.ts:73`) |
| `buildPiCliArgs({ prompt })` | function | 把 env 翻译成 pi CLI argv `["-p", prompt, "--provider", X, "--model", Y, "--thinking", Z]`(`src/runtime.ts:209`) |
| `ProviderName` | type | 4 个 provider 名联合类型(`src/catalog.ts:23`) |
| `BuildPiCliArgsInput` | type | `buildPiCliArgs` 入参类型(`src/runtime.ts:24`) |
| `ModelThinkingLevel` / `ThinkingLevelMap` | type re-export | 来自 `@earendil-works/pi-ai`(`src/index.ts:9`) |

### 关键模块

| 文件 | 做什么 |
|---|---|
| `src/index.ts` | 公开 API barrel(re-export catalog / register / runtime 中给外部用的部分) |
| `src/catalog.ts` | 4 个 provider 名 ↔ pi-ai api 双向映射;`BUILTIN_MODELS` 8 条;`PROVIDER_PATH_SUFFIX` 4 套 baseUrl 后缀策略 |
| `src/env.ts` | 集中 env 读取与校验(`LLM_*` 全套);`get*OrDefault` 系列供 CLI 路径缺省 fallback;`getMergedModels()` 合并 builtin + `LLM_EXTRA_MODELS_JSON` |
| `src/register.ts` | `registerHavefunProviders`:遍历 4 个 provider 名,按 `nativeApi` 过滤 model,一次性注册到 pi |
| `src/runtime.ts` | SDK 路径:`getDefaultModel` / `buildHavefunModel` / `getDefaultReasoningEffort`;CLI 路径:`buildPiCliArgs`(把 env 翻译成 pi argv) |

### 与兄弟包关系

- **依赖**:`@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent`(上游 pi 系列);**无任何 flower-* 依赖**(底层基础包)
- **被谁依赖**:
  - `flower-code-reviewer`:通过 `extension.ts:25` 调 `registerHavefunProviders({ appSource: "code-reviewer" })`;通过 `run.ts` 调 `buildPiCliArgs` 翻译 env → pi argv
  - `flower-ops-bot`:通过 `agent-factory.ts:10` 调 `getDefaultModel + buildHavefunModel + getDefaultReasoningEffort`,在 `streamFn` 中拿 reasoning effort

---

## flower-tools-gitlab

### 一句话定位

GitLab REST API 的 6 个工具集合 + 一个轻量 client(自实现,故意不引 `@gitbeaker/rest`),**仅供 code-reviewer 使用**,ops-bot 不应有写 GitLab 能力(职责隔离;来源:`packages/flower-tools-gitlab/src/index.ts:1-5`、`README.md` 第一行)。

### 职责(做什么)

- 暴露 6 个 pi `defineTool` 工具:`gitlab_get_mr_diff` / `gitlab_get_mr_files` / `gitlab_get_file_content` / `gitlab_post_comment` / `gitlab_post_line_comment` / `gitlab_get_previous_review`(`src/index.ts:34-209`)
- 提供 `gitlabClient()` 工厂(单例缓存),内部封装 `PRIVATE-TOKEN` 鉴权 / 10s 超时 / 5xx 重试 1 次 / `encodeURIComponent(projectId)` / diff_refs per-MR 缓存 / bot username 自查缓存(`src/client.ts:gitlabClient/createRealClient`)
- 给行内评论拼 `position` 字段(`base_sha` / `start_sha` / `head_sha` / `new_path` / `new_line`)— GitLab discussions API 必填(`src/client.ts:postMrLineComment:387-406`)
- 在评论 body 前 sanitize quick action(走 `flower-tools-common` 的 `sanitizeQuickActions`)+ 给 blocker 评论加 HTML 注释 marker `<!-- severity: blocker -->`,供 reviewer `run.ts:scanForBlockers` regex 识别(`src/client.ts:postMrComment:380` / `src/index.ts:84,110`)
- `safe-read.ts` 给 `gitlab_get_file_content` 加业务层防护:二进制后缀直接跳过(返回 placeholder 占位)+ 50KB size cap(`FLOWER_MAX_FILE_SIZE` env 可调),超出截断 + 追加 ⚠️ 注释(`src/safe-read.ts:safeReadFile`)
- `normalizeRef`:LLM 传 `""` / `"HEAD"` / `undefined` 时兜底到 `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`,无 CI env 时抛中文错(`src/index.ts:normalizeRef:228-247`)
- 错误分类(可选 `classifyError=true`):`AuthError`(401/403) / `FileNotFoundError`(404) / `RetryableError`(5xx 重试仍失败),其它走通用 `Error`(`src/client.ts:gitlabFetch:262-273`)
- `countDiffChurn`:从 unified diff 数 `+`/`-` 行,排除 `---`/`+++` 文件头,供 reviewer 的 E2 cap 排序使用(`src/client.ts:countDiffChurn:298-308`)

### 边界(不做什么)

- **不做评审决策**:本包只是 GitLab REST 桥;判断"该不该 blocker"、"评论质量是否合格" 是 `flower-code-reviewer` 的 `run.ts:scanForBlockers` / prompts 的事
- **不拦截 / 不审计**:工具就是工具,合规拦截由 `flower-compliance` `tool_call` hook 做;审计也由 `flower-compliance` 做
- **不发 LLM 请求**:本包不管模型 / api key / provider — 那是 `flower-providers` 的事
- **不在容器内做 git checkout**:本包不复用本地 git,只通过 GitLab REST `/raw` endpoint 拉文件(便于在最小镜像里运行)
- **不读 ARMS / 不发钉钉**:任何运维 / 监控相关由 `flower-tools-arms` / `flower-ops-bot` 负责

### 对外契约

| 导出 | 类型 | 用途 |
|---|---|---|
| `gitlabGetMrDiffTool` | pi tool (`defineTool`) | 拿 MR 完整 unified diff(`src/index.ts:34`) |
| `gitlabGetMrFilesTool` | pi tool | 列 MR 修改的文件路径(`src/index.ts:52`) |
| `gitlabGetFileContentTool` | pi tool | 拉任意 ref 的文件原始内容(支持 ref 兜底 + 二进制跳过 + 50KB cap)(`src/index.ts:155`) |
| `gitlabPostCommentTool` | pi tool | 发整体评论(带 `severity` + quick action sanitize)(`src/index.ts:74`) |
| `gitlabPostLineCommentTool` | pi tool | 发行内评论(`file` + `line` + `body` + `severity`,带 sanitize)(`src/index.ts:98`) |
| `gitlabGetPreviousReviewTool` | pi tool | 查 bot 在本 MR 历史评论(用于增量评审避免重复)(`src/index.ts:122`) |
| `registerGitlabTools(pi)` | function | 一次性注册全部 6 个工具(`src/index.ts:269`) |
| `normalizeRef(rawRef)` | function | ref 归一化(空/HEAD → source branch),供单测 + 工具自用(`src/index.ts:228`) |
| `gitlabClient()` | function | 单例 GitLab client(`src/client.ts:178`) |
| `safeReadFile(input)` | function | 内部 wrapper:`gitlab_get_file_content` 走它做 size cap + 二进制跳过(`src/safe-read.ts:99`) |
| `countDiffChurn(diff)` | function | 数 unified diff 的 `+`/`-` 行(`src/client.ts:298`) |
| `AuthError` / `FileNotFoundError` / `RetryableError` | class | 错误分类(用 `classifyError=true` 才抛)(`src/client.ts:99/108/117`) |
| `Severity` / `LineCommentInput` / `MrFileChange` / `BotComment` / `GitlabClient` | type | client 公开类型(`src/client.ts:28-92`) |

### 关键模块

| 文件 | 做什么 |
|---|---|
| `src/index.ts` | 6 个 pi tool 定义 + `registerGitlabTools` 一次性注册 + `normalizeRef` ref 兜底逻辑 + `readEnv()` 从 `CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID` 取 MR 标识 |
| `src/client.ts` | GitLab REST 轻量客户端:`PRIVATE-TOKEN` 鉴权 / 10s 超时 / 5xx 重试 / diff_refs 缓存 / bot username 自查;错误分类(401/403/404/5xx);`countDiffChurn`;给 blocker 评论加 `<!-- severity: blocker -->` HTML 注释 marker |
| `src/safe-read.ts` | `safeReadFile` wrapper:二进制后缀跳过(`BINARY_EXT`,18 种常见后缀)+ `FLOWER_MAX_FILE_SIZE` size cap(默认 50KB),失败透传给 caller |

### 与兄弟包关系

- **依赖**:
  - `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent`(上游 pi 系列;`Type` schema + `defineTool` 工厂)
  - `@flower-ai/flower-tools-common`(用 `sanitizeQuickActions` 防 quick action 误触发;`src/index.ts:15`)
- **被谁依赖**:
  - `flower-code-reviewer`:通过 `extension.ts:28` 调 `registerGitlabTools(pi)`;`review-trace.ts` 监听 `gitlab_get_file_content` / `gitlab_post_line_comment` 累积 trace
  - 故意**未被** `flower-ops-bot` 依赖(职责隔离:ops-bot 不发 GitLab 评论)

---

## flower-tools-common

### 一句话定位

跨产品共享的"通用工具"集合 + GitLab 评论 sanitize helper,**当前面向使用禅道 + 钉钉的团队配置**(若团队用 Jira / Confluence,README 建议 fork 替换实现;来源:`packages/flower-tools-common/src/index.ts:1-9`、`README.md` 第一行)。

### 职责(做什么)

- 暴露 2 个 pi tool:`zentao_search`(禅道 bug / 任务 / 需求 / 用例 / 全局搜索) + `dingtalk_doc_search`(钉钉知识库搜索)— **当前实现都是 Stub**,返回 `[Stub] ...` 字符串,带"实际接入后会返回 ..." 占位说明(`src/zentao.ts:46-60` / `src/dingtalk-doc.ts:34-48`)
- `sanitizeQuickActions(body)`:行级转义,把以 `^/<quick_action>(\s|$)` 起头的行首字符 `/` 替换为 HTML 实体 `&#47;`,**post-time 防御纵深**避免 GitLab 把评论解读为 quick action 误执行 `/approve` 等(`src/sanitize.ts:140-145`)
- 维护一个 50+ 项的 `QUICK_ACTIONS` 词表,覆盖 approve / close / assign / label / milestone / merge / lock / subscribe / title / description / zoom / promote 等(`src/sanitize.ts:44-108`)
- 提供 `registerCommonTools(pi)` 一次性注册 2 个 stub 工具(`src/index.ts:22`)

### 边界(不做什么)

- **不真调禅道 / 钉钉 API**:Stub 注 `// TODO: 接入禅道 REST API` / `// TODO: 接入钉钉文档 OpenAPI`,真实接入是 TODO(`src/zentao.ts:47` / `src/dingtalk-doc.ts:36`)
- **不管 LLM**:不调 LLM、不读 env 里的 LLM key
- **不发 GitLab 评论**:只提供"评论 body 怎么 sanitize"的纯字符串函数;真实 post 由 `flower-tools-gitlab` 客户端做
- **不做 access token 缓存**:虽然 README 提到"accessToken 要缓存(2 小时有效),否则会触发限流",但当前 Stub 还没接到真实 API,缓存逻辑也未实现
- **不做 IM 推送**(钉钉群消息发 / @ 通知)— 那是 `flower-ops-bot/dingtalk/push.ts` 的事

### 对外契约

| 导出 | 类型 | 用途 |
|---|---|---|
| `zentaoSearchTool` | pi tool (Stub) | 禅道搜索 — `query` + 可选 `type` (`bug`/`task`/`story`/`case`) + `product` + `status` + `limit`(`src/zentao.ts:31`) |
| `dingtalkDocSearchTool` | pi tool (Stub) | 钉钉知识库 / 文档搜索 — `query` + 可选 `spaceId` + `limit`(`src/dingtalk-doc.ts:26`) |
| `sanitizeQuickActions(body)` | function | 转义评论 body 中以 GitLab quick action 关键字起头的整行(`src/sanitize.ts:140`) |
| `registerCommonTools(pi)` | function | 一次性注册 2 个工具(`src/index.ts:22`) |

### 关键模块

| 文件 | 做什么 |
|---|---|
| `src/index.ts` | barrel:re-export 2 个 tool + `sanitizeQuickActions` + `registerCommonTools` 一次性注册 |
| `src/zentao.ts` | `zentaoSearchTool` Stub:支持 4 种 entity type + 产品 ID + 状态过滤,带"实际实现 TODO"说明 |
| `src/dingtalk-doc.ts` | `dingtalkDocSearchTool` Stub:支持空间 ID + limit,带"实际接入流程 TODO"说明 |
| `src/sanitize.ts` | `QUICK_ACTIONS` 词表(50+ 项)+ `QUICK_ACTION_REGEX` 行首匹配 + `sanitizeQuickActions` 行级转义(纯字符串,无 IO) |

### 与兄弟包关系

- **依赖**:`@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent`(上游;`Type` schema + `defineTool`)— **无任何 flower-* 依赖**
- **被谁依赖**:
  - `flower-tools-gitlab`:在 `package.json:48` 声明依赖,`src/index.ts:15` 引入 `sanitizeQuickActions`,`postMrComment` / `postMrLineComment` 在 post 前调用做防御纵深(`src/index.ts:84,110`)
  - `flower-code-reviewer`:通过 `extension.ts:27` 调 `registerCommonTools(pi)` 暴露 2 个 stub 工具给 LLM(评审场景可查关联工单 / 文档)
  - `flower-ops-bot`:通过 `tools.ts:19` 引入 `zentaoSearchTool` + `dingtalkDocSearchTool`,经 `buildToolList` 装配给 `Agent`

---

## flower-tools-arms

### 一句话定位

阿里云 ARMS / SLS 工具集(日志 / 指标 / 告警 / 调用链 4 个 Stub tool)+ 工具结果脱敏 helper,**仅供 ops-bot 使用,code-reviewer 不应该看监控**(来源:`packages/flower-tools-arms/src/index.ts:1-10`、`README.md` 第一行)。

### 职责(做什么)

- 暴露 4 个 pi tool:`arms_query_logs`(SLS 日志,支持 SLS 查询语法 / `from`/`to` 时间) / `arms_query_metrics`(QPS / RT / 错误率 / 慢调用) / `arms_list_alerts`(活跃告警,可按 severity 过滤) / `arms_get_trace`(按 traceId 查调用链)— **当前实现都是 Stub**,返回 `[Stub] ...` 字符串(`src/index.ts:23-122`)
- `maskSensitive(text)`:在工具结果返回 LLM 之前做脱敏(手机号 / 身份证号 / 邮箱 / IPv4 / `sk-*`/`pk-*`/`token-*`/`bearer-*` 密钥)(`src/mask.ts:11-32`)
- 提供 `registerArmsTools(pi)` 一次性注册 4 个 stub 工具(`src/index.ts:129`)
- 设计原则三条声明在 README:① 全部只读(不暴露写 / 删 / 改) ② 结果脱敏 ③ 所有调用经 pi-compliance 上报审计(`README.md` "设计原则" 节)

### 边界(不做什么)

- **不真调阿里云 OpenAPI**:Stub 注 `// TODO: 接入阿里云 SLS SDK` / `// TODO: 接入 ARMS OpenAPI`,真实接入是 TODO(`src/index.ts:38,68,93,118`)
- **不暴露写操作**:绝不有删日志 / 改告警 / 修配置类 API — 设计原则第 1 条
- **不上报审计**:审计由 `flower-compliance` 通过 `pi.on("tool_call" / "tool_result")` hook 做;ARMS 包只调用工具(`src/index.ts:7` 注释 "可观测——每次工具调用都通过 pi-compliance 上报到审计")
- **不发 GitLab 评论 / 不读 MR**:那是 `flower-tools-gitlab` 的事
- **不做 logstore 权限白名单**:README TODO 提到"增加针对 logstore 的权限白名单",当前未实现

### 对外契约

| 导出 | 类型 | 用途 |
|---|---|---|
| `armsQueryLogsTool` | pi tool (Stub) | SLS 日志查询(支持 SLS 查询语法 + 时间窗口 + limit)(`src/index.ts:23`) |
| `armsQueryMetricsTool` | pi tool (Stub) | ARMS APM 指标查询(`qps`/`rt`/`error_rate`/`slow_call_count`)(`src/index.ts:52`) |
| `armsListAlertsTool` | pi tool (Stub) | 列出活跃告警(可按 `critical`/`warning`/`info` + app 过滤)(`src/index.ts:84`) |
| `armsGetTraceTool` | pi tool (Stub) | 按 traceId 查完整调用链(`src/index.ts:109`) |
| `registerArmsTools(pi)` | function | 一次性注册 4 个工具(`src/index.ts:129`) |
| `maskSensitive(text)` | function | 脱敏:手机 / 身份证 / 邮箱 / IPv4 / `sk-*` 类密钥 → `***PHONE***` 等占位符(`src/mask.ts:26`) |

### 关键模块

| 文件 | 做什么 |
|---|---|
| `src/index.ts` | 4 个 pi tool 定义 + `registerArmsTools` 一次性注册;`armsQueryLogsTool` 的 Stub 结果在返回 LLM 前先过 `maskSensitive` |
| `src/mask.ts` | 5 条 regex 脱敏规则;纯字符串处理,无 IO;返回新字符串不改原值 |

### 与兄弟包关系

- **依赖**:`@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent`(上游;`Type` schema + `defineTool`)— **无任何 flower-* 依赖**
- **被谁依赖**:
  - `flower-ops-bot`:通过 `tools.ts:14-18` 引入 4 个 tool,经 `buildToolList` 装配给 `Agent`(`src/tools.ts:35-38`)
  - 故意**未被** `flower-code-reviewer` 依赖(职责隔离:reviewer 不看监控)

---

## flower-compliance

### 一句话定位

合规拦截 + 全量审计的 pi 扩展,两个产品都加载,只是模式不同:code-reviewer 用 `ci-readonly` 模式(禁写工具 + bash 白名单),ops-bot 用 `production-readonly` 模式(工具本身只读,本扩展只做审计;来源:`packages/flower-compliance/src/index.ts:1-10`、`README.md` "提供的能力" 节)。

### 职责(做什么)

- 暴露 `registerCompliance(pi, { mode, product })` 总入口:CI 模式装拦截 + 不分模式都装审计(`src/index.ts:33-43`)
- **CI 只读拦截**(`ci-readonly` 模式):通过 `pi.on("tool_call")` hook,`write` / `edit` 工具直接 block;`bash` 工具走白名单(`src/index.ts:registerCiReadOnlyGuards:192-216`)
- `BASH_ALLOW_LIST` 正则白名单:`git|grep|rg|find|ls|cat|head|tail|nl|wc|file|sed|awk|sort|uniq|tr|column|diff|comm|printf|echo|basename|dirname|realpath|pwd|date|which|type|command`(纯只读,无副作用,不泄漏 secret)(`src/index.ts:63-64`)
- `SUGGESTION_BY_CMD` 替代建议表:拦截高危命令时附带"该用什么工具代替"提示给 LLM,减少反复试错(`src/index.ts:71-92`)
- `splitCommandChain(cmd)`:quote-aware 拆 bash 命令链(`;` / `&&` / `||` / `|`),让 `git status; env` 中的 `env` 也被白名单 check;quoted `|`(如 `rg "a|b"`)不拆分(`src/index.ts:124-176`)
- **审计**(`registerAudit`):`pi.on("session_start" / "tool_call" / "tool_result")` 三个 hook,异步推送审计记录到 `SIEM_INGEST_URL`(`src/index.ts:224-256`)
- `sendAudit(record)`:HTTP POST 到 `SIEM_INGEST_URL`(2s 超时,**fail-open**,失败默认静默不刷屏 CI 日志,`DEBUG_AUDIT=1` 时才打 warn);未配 `SIEM_INGEST_URL` 时也支持 `DEBUG_AUDIT=1` 本地打印(`src/audit.ts:25-57`)
- **故意不上报工具入参全量**(可能含敏感数据),只上报 `inputKeys`(字段名列表)(`src/index.ts:241`)

### 边界(不做什么)

- **不做业务规则**(如"ARMS project 白名单"):本扩展只做"事件级别"的合规与审计,业务规则在各产品自己的扩展里实现(`src/index.ts:8` 注释)
- **不阻塞 audit**:`sendAudit` 失败 swallow(fail-open),不影响主流程
- **不读 / 不发 LLM 请求**:不涉及 model / api key
- **不调 GitLab / ARMS 等业务 API**:只 hook pi 的 tool_call 事件
- **不解析 bash 命令到 AST**:`splitCommandChain` 只做 separator 级拆分,接受 `$(...)` / 反引号子命令的盲点(注释明示这是有意的取舍,`src/index.ts:189-191`)

### 对外契约

| 导出 | 类型 | 用途 |
|---|---|---|
| `registerCompliance(pi, { mode, product })` | function | 总入口:按 mode 装 CI 拦截 + 不分模式装审计(`src/index.ts:33`) |
| `ComplianceMode` | type | `"ci-readonly" \| "production-readonly"`(`src/index.ts:23`) |
| `sendAudit(record)` | function | 直接推送一条审计记录到 `SIEM_INGEST_URL`(供需要主动审计的代码用)(`src/audit.ts:25`) |
| `AuditRecord` | type | 审计记录开放结构:`kind` + `product` + `ts` + 任意字段(`src/audit.ts:13`) |
| `splitCommandChain(cmd)` | function | quote-aware 拆 bash 命令链(导出供单测 / 复用)(`src/index.ts:124`) |

### 关键模块

| 文件 | 做什么 |
|---|---|
| `src/index.ts` | `registerCompliance` 总入口;`registerCiReadOnlyGuards` 装 CI 拦截;`registerAudit` 装审计 hooks;`BASH_ALLOW_LIST` 正则白名单;`SUGGESTION_BY_CMD` 拦截建议表;`splitCommandChain` quote-aware 拆分 |
| `src/audit.ts` | `sendAudit`:HTTP POST + 2s 超时 + fail-open;无 SIEM 时支持 `DEBUG_AUDIT=1` 本地打印;失败默认静默(`DEBUG_AUDIT=1` 才 warn) |

### 与兄弟包关系

- **依赖**:`@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent`(上游;只用 `ExtensionAPI` 类型与 `pi.on(...)` hook)— **无任何 flower-* 依赖**
- **被谁依赖**:
  - `flower-code-reviewer`:通过 `extension.ts:26` 调 `registerCompliance(pi, { mode: "ci-readonly", product: "code-reviewer" })`,拦截 write/edit + bash 白名单
  - **设计上也应被 `flower-ops-bot` 依赖**(模式为 `production-readonly`,只做审计),但 `flower-ops-bot/package.json` 当前**未声明对 `flower-compliance` 的 dependency**,需 sub-agent 自查是否后续会接入

---

## flower-ops-bot

### 一句话定位

钉钉运维机器人 HTTP 服务,常驻部署形态(与 reviewer CI Job 形态不同),基于 `pi-agent-core` 的 `Agent` 类 + ARMS / 通用工具,在钉钉群被 @ 后跑 agent loop 自主调用工具诊断问题、流式回复(来源:`packages/flower-ops-bot/src/server.ts:1-12`、`README.md` "工作流程" 节)。

### 职责(做什么)

- 启 HTTP 服务(Node 内置 `http` 模块,无 express / koa):2 个 endpoint —— `GET /healthz`(健康检查)+ `POST /dingtalk/webhook`(钉钉消息回调)(`src/server.ts:13-64`)
- 钉钉 webhook 鉴权:`timestamp + sign` HMAC-SHA256 签名校验,防伪 + 防重放(`Math.abs(Date.now() - ts) > 1h` 拒绝)(`src/dingtalk/signature.ts:18-30`)
- 钉钉 5s 超时约束:`handleDingTalkWebhook` 立即应答 200,真实处理放 `queueMicrotask` 后台,通过 `sessionWebhook` 流式推回(`src/dingtalk/webhook.ts:64-86`)
- 流式推送 + 节流:`pushToSession` 把累积全文 POST 回 `sessionWebhook`,非 final 强制 500ms 间隔,final 一定推(`src/dingtalk/push.ts:17-42`)
- 按 `conversationId` 维度构造 `Agent` 实例:从 Redis 拉历史 messages → 跑 `agent.prompt(text)` → 持久化最新 messages 回 Redis;无 `REDIS_URL` 时降级为进程内 Map(仅本地开发)(`src/agent-factory.ts:52-99` / `src/session-store.ts`)
- Agent 装配 6 个工具:4 个 ARMS Stub(logs / metrics / alerts / trace) + 2 个通用 Stub(zentao_search / dingtalk_doc_search),经 `buildToolList` → `toAgentTool` 转换(`src/tools.ts:34-58`)
- `streamFn` 内桥接 `flower-providers`:`getDefaultReasoningEffort(model.id)` + Gemini xhigh → high clamp + `streamSimple(model, ctx, { apiKey, reasoning, thinkingBudgets })`(`src/agent-factory.ts:65-90`)
- Gemini 系列 hardcode `thinkingBudgets` 阶梯(`gemini-2.5-pro` / `gemini-2.5-flash`:minimal=1024/low=4096/medium=16384/high=24576)(`src/agent-factory.ts:23-26`)
- System prompt 强约束运维助手身份:只读 / 简洁 / 不复述敏感信息 / 不承诺执行任何变更操作(`src/prompts.ts:10-37`)
- 优雅关闭:`SIGINT` / `SIGTERM` 关 HTTP server + 关 Redis 连接(`src/server.ts:36-43` / `src/session-store.ts:62-67`)

### 边界(不做什么)

- **不发 GitLab 评论**:ops-bot 不依赖 `flower-tools-gitlab`(职责隔离,见 gitlab 包 `src/index.ts:1-5` 注释)
- **不做 CI 评审**:跟 reviewer 形态不同(reviewer 是 CI Job,跑完即退;ops-bot 是常驻 service)
- **不写监控数据**:ARMS 工具全部只读(`flower-tools-arms/README.md` 设计原则第 1 条)
- **不持有 LLM 调用细节**:`streamFn` 把 model / effort / budget 等都委托给 `flower-providers` + `pi-ai streamSimple`,自身不知道具体 baseUrl / key
- **未配 `flower-compliance`**(当前):`package.json` 依赖列表中没有 `@flower-ai/flower-compliance`,虽然 compliance README 列出 `production-readonly` 模式给 ops-bot,实际**未接入**,需 sub-agent 自查或后续补
- **不实现告警驱动 / 巡检 / 用户 Watcher** 等 P1+ 能力(README "未来规划:进阶能力" 列了 6 项,当前全是 OOS)

### 对外契约

| 导出 | 类型 | 用途 |
|---|---|---|
| `flower-ops-bot` | bin / CLI (`bin/server.js`) | npm script 入口,启 HTTP service(`package.json:31-33`,`dist/server.js`) |
| `OPS_SYSTEM_PROMPT` | exported const | ops-bot 的 system prompt 模板(运维助手身份)(`src/prompts.ts:10`) |
| `handleMessage(input)` | function | 处理一条钉钉消息的主流程:订阅 agent 事件 → 累积流式输出 → 持久化(`src/handler.ts:32`) |
| `getOrCreateAgent(input)` | function | 按 conversationId 构造 Agent(从 Redis 恢复 + 装 6 个工具 + 装 streamFn)(`src/agent-factory.ts:52`) |
| `persistAgent(conversationId, agent)` | function | 把 agent.state.messages 写回 Redis(`src/agent-factory.ts:105`) |
| `handleDingTalkWebhook(req, res)` | function | webhook handler:签名校验 + 5s 立即应答 + 后台跑 agent + 流式推回(`src/dingtalk/webhook.ts:41`) |
| `verifySignature(timestamp, sign, secret)` | function | 钉钉 HMAC-SHA256 签名校验(constant-time compare)(`src/dingtalk/signature.ts:18`) |
| `pushToSession(sessionWebhook, text, isFinal)` | function | 推消息回钉钉 sessionWebhook(500ms 节流;final 强制推)(`src/dingtalk/push.ts:17`) |
| `getSession(id)` / `saveSession(id, session)` / `closeSessionStore()` | function | Redis 会话存储(24h TTL;无 Redis 时降级 Map,仅本地)(`src/session-store.ts:48/55/62`) |
| `buildToolList({ userId })` | function | 把 ARMS + 通用 6 个工具转成 pi-agent-core `AgentTool[]`(`src/tools.ts:27`) |

### 关键模块

| 文件 | 做什么 |
|---|---|
| `src/server.ts` | HTTP 入口:`createServer` + 路由表手写 + 优雅关闭(`SIGINT` / `SIGTERM`) |
| `src/handler.ts` | `handleMessage` 主流程:订阅 `message_update` / `message_end` / `agent_end` 事件,累积 delta → 节流推钉钉;`extractDelta` 从事件提取 text_delta |
| `src/agent-factory.ts` | `getOrCreateAgent` + `persistAgent`;`streamFn` 桥接 `flower-providers`(`getDefaultReasoningEffort` + Gemini xhigh→high clamp + `thinkingBudgets`);`GEMINI_BUDGETS_BY_MODEL` hardcode 阶梯 |
| `src/session-store.ts` | Redis / Map 双后端(`createRedisBackend` / `createInMemoryBackend`);24h TTL;key 格式 `flower:ops-bot:session:<conversationId>` |
| `src/prompts.ts` | `OPS_SYSTEM_PROMPT`:运维助手身份 + 能力(4 个 ARMS 查询)+ 边界(只读)+ 工作风格(简洁、Markdown 表格、不复述敏感)+ 语气(简洁、不"亲""哈" emoji) |
| `src/tools.ts` | `buildToolList`:引 ARMS 4 个 + 通用 2 个 → 经 `toAgentTool` 转 pi-coding-agent ToolDefinition 到 pi-agent-core AgentTool |
| `src/dingtalk/webhook.ts` | webhook handler:鉴权 + 立即应答 + 后台跑 + 流式推回;`readBody` 限 1MB |
| `src/dingtalk/signature.ts` | `verifySignature`:HMAC-SHA256 + 1h 防重放窗口 + constantTimeEqual 防计时攻击 |
| `src/dingtalk/push.ts` | `pushToSession`:5s 超时 + 500ms 节流 + 失败 warn 不抛 |

### 与兄弟包关系

- **依赖**:
  - `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`(上游 SDK,`Agent` + `streamSimple`)
  - `@flower-ai/flower-providers`(`agent-factory.ts:10` 调 `buildHavefunModel` + `getDefaultModel` + `getDefaultReasoningEffort`)
  - `@flower-ai/flower-tools-arms`(`tools.ts:14-18` 用 4 个 ARMS Stub)
  - `@flower-ai/flower-tools-common`(`tools.ts:19` 用 zentao_search + dingtalk_doc_search Stub)
  - `ioredis`(session 持久化;无 REDIS_URL 时不实例化)
  - **当前未声明** `@flower-ai/flower-compliance` 依赖(`package.json:44-51`),与 compliance README 提到的 `production-readonly` 模式相比,实际**未接入审计**;~待 sub-agent 自查源码~ 是否后续会补
- **被谁依赖**:**无 flower-* 包依赖它**(它是终端产品 bin)— 直接被运维 / 业务方部署运行
- **形态对照**:与 `flower-code-reviewer`(CLI / CI Job 形态)是同一 monorepo 内两个并列终端产品,共享 `flower-providers` + `flower-tools-common` 这两条共用基础包

---

## Caveats / Not Found

1. **`flower-ops-bot` 未声明 `flower-compliance` 依赖**:design.md §3.2 表格暗示 ops-bot 走 compliance 的 `production-readonly` 模式,但 `packages/flower-ops-bot/package.json:44-51` 当前 dependencies 不含 `@flower-ai/flower-compliance`;`agent-factory.ts` 也无 `registerCompliance` 调用。是当前阶段尚未接入(README 在 `production-readonly` 模式描述上属"设计意图")。本卡片在"边界 / 不做什么"标明,sub-agent 写 HTML 时应据此谨慎措辞,**不要写成"ops-bot 已接入 compliance"**。
2. **flower-tools-* 工具大多是 Stub**:`tools-gitlab` 的 6 个工具是**真实实现**(走 GitLab REST);`tools-common` 的 2 个 + `tools-arms` 的 4 个都是 Stub(`// TODO: 接入 ...`)。写 HTML 时应明示状态,与各包 README 「Stub」标记一致。
3. **`flower-providers` builtin 模型 cost 全填 0**:占位状态(`src/catalog.ts:160-260`),接通计费系统后再补真实数据。该信息已在 PRD 提及,写 HTML 时可一笔带过即可。
4. **本文档不覆盖 flower-code-reviewer**:它由 PRD §4 R12 的 S1-S12 模板独立深度展开(B2.1 节),非本研究范围。
