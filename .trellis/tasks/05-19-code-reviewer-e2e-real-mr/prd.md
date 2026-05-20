# flower-code-reviewer:端到端跑通真实 MR 评审链路

## Goal

承接 flower-providers 在 ops-bot 上端到端验过 5 个模型的工作,把另一个产品 `flower-code-reviewer` 的链路也拉到「拿真实 MR 走过一遍」的水平,验证 GitLab CI → `flower-review --mr-iid` → pi-coding-agent → flower-tools-gitlab → 行内评论 这整条链路在真实环境下可用。

## Background / Known Context

### 代码现状(已通过 auto-context 探查)

**链路骨架(packages/flower-code-reviewer):**
- `src/cli.ts` — CLI 入口,bin 名 `flower-review`(已实现)
- `src/args.ts` — 支持 `--mr-iid` / `--skill` / `--dry-run`(已实现)
- `src/skill-selector.ts` — 按文件后缀自动选 general/backend/frontend/security(已实现,逻辑见 L30-39)
- `src/prompts.ts` — 构造 prompt 注入 skill 内容 + 严格工具使用约束(已实现)
- `src/extension.ts` — 注册顺序:providers → compliance → common tools → gitlab tools(已实现)
- `src/run.ts` — 主控,调 pi-coding-agent print 模式(已实现,但 **L46-48 blocker 扫描 TODO**)
- `skills/{general,backend,frontend,security}.md` — 4 个 skill 文件齐
- `.gitlab-ci.example.yml` — CI 接入示例齐
- `Dockerfile` 存在

**周边扩展:**
- `flower-providers` — ✅ 真实可用,已端到端验过 5 模型
- `flower-compliance/src/index.ts` — ✅ 真实现,`ci-readonly` 模式拦截 write/edit + bash 白名单(`/^(git|grep|find|ls|cat|head|tail|wc|file|sed|awk)\b/`),审计事件异步推 SIEM
- `flower-tools-common` — ⚠️ zentao / dingtalk-doc 是 stub(但与 code-reviewer e2e 无关)

**关键缺口(决定本任务范围):**
- ❌ **`flower-tools-gitlab/src/client.ts` 整体是 stub**:5 个 endpoint(getMrDiff / getMrFiles / postMrComment / postMrLineComment / getBotComments)全是占位实现,console.log + 假数据,代码内 5 处 `// TODO: GET/POST /api/v4/...` 标注
- ❌ `run.ts:46-48` — `// TODO: pi 退出后,从 GitLab 拉本次发的评论,扫描 severity=blocker`,目前直接返回 exitCode=0

**含义**:不实装 GitLab REST 客户端,链路不可能真跑通——任何对真实 GitLab 的调用都会落到 stub。所以「e2e 跑通真实 MR」**至少包含**:实装 5 个 endpoint + 实装 blocker 扫描 + 真实跑一次。

### 已知约束

- pi-coding-agent 0.75.x 接口已稳定(flower-providers 端到端验过)
- ops-bot 已沉淀的 LLM_PROVIDER / LLM_MODEL / LLM_REASONING_EFFORT env 抽象可复用
- 合规拦截工具名 `write` / `edit` / `bash` 是 pi-coding-agent 内置工具名,真实跑时会触发拦截路径,可在本任务顺便验

### 测试资源(Q2 答复 + 实测确认)

- **GitLab host**:`http://gitlab.xhgjdev.com`(用户确认有意 HTTP,curl 实测 200)
- **Fork 源仓库**:`http://gitlab.xhgjdev.com/digital-independent-projects/srm-esign`(电子签名 SRM 系统,真实业务代码)
- **Fork 目标 namespace**:**`xhgj003027`**(用户个人 namespace,通过 `GET /api/v4/user` 自查得到,姓名"赵维豪")
- **Bot Token**:已落到 `/root/.config/secrets/credentials.env` 的 `GLAB_NEW_TOKEN`,实测有效;实装阶段通过 `source` 这个文件 + 把 `GLAB_NEW_TOKEN` 映射到 `GITLAB_TOKEN` env 使用
- **部署/运行形态(D2 已记录)**:CI Job 一次性触发,k3s 是 Rancher 集群环境(`https://rancher.k3s.xhgjdev.com`),Runner 可能跑在 k3s 上但对 code-reviewer 透明
- **预期 fork 后仓库**:`http://gitlab.xhgjdev.com/xhgj003027/srm-esign`

### ⚠️ 风险与边界条件

- **GitLab 走 HTTP**:`http://gitlab.xhgjdev.com` 无 TLS,token 在网络上明文传输。如果是内网完全可控环境可接受;否则需要核实
- **业务代码作为 sandbox**:srm-esign 是真实业务系统,fork 后跑 LLM 评审需确认合规边界——不要把代码内容/diff 通过公网 LLM 网关发出去(用户已有 LLM 网关在 ops-bot 验过的 5 模型基线,需确认是否走公司内网代理)

## Assumptions (待用户确认)

- A1. 测试需要一个真实 GitLab 实例 + 测试仓库 + 至少一个测试 MR + 一个有评论权限的 bot token
- A2. 实装 GitLab REST 客户端是本任务必经步骤(没法绕过)
- A3. 评论质量验收以「人工抽检 + 数量阈值」为主,自动判分本期不做

## Decision (ADR-lite)

### D1 · 任务范围(Approach A · 一次性闭环)

- **Context**:auto-context 发现 `flower-tools-gitlab/src/client.ts` 5 endpoint 全为 stub + `run.ts:46-48` blocker 扫描 TODO,「e2e 跑通真实 MR」不可能跳过实装步骤
- **Decision**:本任务一次性闭环——(1) 实装 5 个 GitLab REST endpoint + (2) 实装 blocker 扫描 + (3) 真实 MR 跑通 e2e,作为同一个 Trellis 任务交付
- **Consequences**:任务规模偏大(预计 1-2 天);需用户提前到位 GitLab 资源(实例 + 仓库 + bot token + 测试 MR),否则会卡在 (3);收益是避免「实装完缺真实反馈」的二次成本,以及发现 GitLab discussions API 异常时能立刻闭环修

### D2 · 部署形态(K1 · GitLab Pipeline 一次性 Job)

- **Context**:用户明确「只是在跑 Pipelines 的时候触发的一个流程,跑完就没必要留着」,且现有 `Dockerfile` + `.gitlab-ci.example.yml` 已按 CI Job 形态设计
- **Decision**:code-reviewer 维持 CI-Native 形态,通过 GitLab Pipeline 在 MR event 上触发一次性 Job,跑完即退;**本任务不引入 k8s manifest / 常驻 service / webhook 监听**
- **Consequences**:
  - 完整保留现有「CLI 单次跑、按 env 读 CI_PROJECT_ID/CI_MERGE_REQUEST_IID」的简洁设计
  - Token 注入走 GitLab CI/CD masked variable(`REVIEWER_BOT_TOKEN` → 在 job 内映射为 `GITLAB_TOKEN`),与 `.gitlab-ci.example.yml` 现有写法一致
  - 若未来真要做「集中调度 / webhook 触发」形态,作为另一个产品演进任务,不在本期范围
  - GitLab Runner 是否跑在 k3s 上对本任务无关紧要——Runner 形态对 code-reviewer 透明

### D3 · 模型选择(GPT-5.5 + reasoning effort=xhigh · 单模型)

- **Context**:用户推荐用 GPT-5.5 + xhigh 作为本期 e2e 验证模型
- **Decision**:本任务以 **gpt-5.5 + xhigh** 为唯一目标模型走 e2e
- **Consequences**:
  - flower-providers 端 GPT-5.5 已注册到 `havefun-openai-responses`(catalog.ts:244-255),per-model default effort 已是 `xhigh`(runtime.ts:31),无需 catalog 变更
  - **新增工作 R4**(见 Requirements):code-reviewer 当前 print 模式没把 `LLM_MODEL` / `LLM_REASONING_EFFORT` env 翻译到 pi CLI argv,需要补上,否则 xhigh 不生效
  - 单模型省去多模型评论堆叠问题;OpenAI / Anthropic / Gemini 三套协议路径在 ops-bot 上已分别验过,code-reviewer 这边只验 OpenAI Responses 这一条足以验证 flower-providers 在新消费者上的可用性
  - 若 e2e 跑通后想验其他模型,改一个 env 重跑即可(R4 实装后)

### D6 · 合规拦截验证(CP1 被动 e2e + CP3 单测补强)

- **Context**:用户接受推荐
- **Decision**:
  - **CP1**:e2e 跑动开启 `DEBUG_AUDIT=1`,自然观察是否有 `[audit]` 事件 / 拦截 reason,过即为 AC11
  - **CP3**:为 flower-compliance 补单元测试覆盖拦截规则(`write`/`edit` 必拦、`bash` 白名单 / 非白名单分支),作为「定理证明」级验证
  - 不做 CP2(主动诱导 LLM),避免污染 prompts.ts 或测试 MR 内容
- **Consequences**:
  - flower-compliance 当前**无任何单元测试**,本任务顺带把测试基线建起来(test 文件 + ci script 接入)
  - 单测 mock `pi.on("tool_call", ...)` 的事件处理器,触发 fake `event.toolName = "write"` 等场景,断言返回 `{ block: true, reason: ... }`
  - 在 brainstorm 阶段我曾把「flower-compliance 加固」列为方向 2,现在通过这个 sub-step 收割部分价值(单测层面),不在本任务做拦截规则的扩展

### D7 · 测试资源 sub-decisions(全部确认)

- **HTTP 协议**:用户确认 `http://gitlab.xhgjdev.com` 是有意(公司内网无 TLS),curl 实测 200 通过;客户端实装原样接受 HTTP scheme,不做协议升级
- **Fork 目标 namespace**:用户选 option a 个人 namespace,实测 username = `xhgj003027`,fork 目标 = `http://gitlab.xhgjdev.com/xhgj003027/srm-esign`
- **Token 注入**:本任务运行时 `source /root/.config/secrets/credentials.env` 然后 `export GITLAB_TOKEN=$GLAB_NEW_TOKEN`(因 credentials.env 里 key 名是 GLAB_NEW_TOKEN,而 client.ts 读 GITLAB_TOKEN,需要别名一次)

### D5 · 验收阈值(V1 + V2 + V3 + V4a · 推荐配置全收)

- **Context**:用户接受推荐
- **Decision**:验收 4 个维度全部纳入本期 AC:
  - **V1 · 链路完整性**:两个 MR 跑完无 uncaught exception,exitCode 符合预期
  - **V2 · 评论真发出去了**:每个 MR ≥ 1 条真实评论在 GitLab UI 可见,二次跑 `gitlab_get_previous_review` 能查到
  - **V3 · LLM 真在干活**:MR-security 上 LLM 必须**指出我们埋的种子问题**(SQL 拼接 / 硬编码 secret 至少识别 1 个)
  - **V4 · 增量评审(不重复评)**:同一 MR 二次跑,LLM 不重复评同样问题(人工对比评论 list)
- **Consequences**:
  - V3 需要在 MR-security 的种子文件里**故意**埋一两个明显的 security 问题作为「LLM ground truth」,这是测试用例的一部分,需在 R3.b 里说明
  - V4 触发 `getBotComments` 实装的细节:GitLab API 过滤「author.username === bot」需要知道 bot 账户的 username,token 创建时要记录,实装时硬编码进 env(`GITLAB_BOT_USERNAME`)或从 `/api/v4/user` 自查
  - 合规审计端点(`SIEM_INGEST_URL`)即使不配置也不会阻塞跑通(audit.ts 设计 fail-safe),无需在本任务到位

### D4 · skill 覆盖(S2 · general + security 两条路径)

- **Context**:srm-esign 是真实业务代码(电子签名 SRM 系统,推测以 Java/Spring 为主),fork 后可任意添加测试文件;skill-selector 按路径关键词 + 文件后缀决策,需要分别构造能触发 general / security 的 MR
- **Decision**:本任务通过**两个独立测试 MR** 分别触发 general 与 security skill:
  - **MR-general**:diff 仅包含 `.md` / `.json` / 配置类文件(skill-selector 走到末位 fallback)
  - **MR-security**:diff 包含路径形如 `src/auth/sign-verify.ts` / `auth/token.go` 的文件(触发 L30 安全关键词分支),并在文件内**故意埋一个 SQL 拼接 / 硬编码 secret** 作为「LLM 应该指出」的种子问题,用于人工验证 LLM 实际在做事
- **Consequences**:
  - 不验 backend / frontend skill,但这两个 skill 与 general 在 prompt 结构上仅清单内容不同,跑通 general 即覆盖该模板路径
  - `--skill <name>` 参数(args.ts:35-39)作为兜底:任意一个 MR 上额外手动跑 `--skill backend` / `--skill frontend` 各一次,验证强制覆盖路径,不强制要求行内评论数下限
  - 构造 MR-security 时需注意 srm-esign 仓库可能没有现成的 auth 类目录,本任务允许 fork 后在 sandbox branch 上**新增**测试文件用于 diff
  - 评论是发到 fork 仓库(我们控制的 sandbox)上,不会污染原始 srm-esign

## Open Questions

**全部 Q1-Q6 已答完,Q1-Q6 决策见 D1-D6,尾巴推断见 D7。**

Phase 1 收尾前请用户审一遍:
- prd.md(本文件)
- design.md(技术设计)
- implement.md(执行计划)

发现问题在 review 阶段修;无问题再 `task.py start` 进 Phase 2。

## Approaches(对 Q1 的候选方案)

### Approach A:一次性闭环(实装 + e2e 同任务)【推荐】

- 怎么做:本任务包含 (1) 实装 flower-tools-gitlab 5 endpoint + (2) 实装 run.ts blocker 扫描 + (3) 拿真实 MR 跑端到端
- 优点:闭环交付,实装时能马上用真实 API 反馈调整(stub 改完直接 e2e 跑就行);避免「实装完没真实数据,又来一个验证任务」的二次成本
- 缺点:单任务规模偏大,1-2 天工作量;若 GitLab 实例/账号还没到位,会卡在 (3) 阶段

### Approach B:拆两个任务(先实装 client,再 e2e 验证)

- 怎么做:本任务只做 (1) + (2),用单元测试 + dry-run 验证;e2e 真跑作为下一个独立任务
- 优点:任务粒度更小,每个能更快闭环;实装与 e2e 验收解耦,GitLab 资源不到位也能先推进实装
- 缺点:实装时缺真实 API 反馈,可能 stub 改完后真跑还是有偏差(GitLab discussions API 的 position 字段在不同 GitLab 版本下行为不一致是已知坑);二次任务有额外仪式开销

### Approach C:Stub 容忍 e2e(仅本期不实装 client)

- 怎么做:仅做 (2) blocker 扫描 + `--dry-run` 模式下的全链路检查(LLM → 工具调用 → 「应当发评论」的日志输出),不真实接 GitLab
- 优点:无需 GitLab 实例;最快产出
- 缺点:严格说不算「跑通真实 MR」——绕开了产品价值最关键的写评论路径;**与 Goal 直接冲突**,不建议

## Requirements

基于 D1(Approach A)初步定义,Q2-Q6 答完后会细化:

### R1 · 实装 flower-tools-gitlab REST 客户端

- 替换 `packages/flower-tools-gitlab/src/client.ts` 中的 stub 为真实 GitLab REST API 调用
- 5 个 endpoint:
  - `getMrDiff` → `GET /api/v4/projects/{projectId}/merge_requests/{mrIid}/changes`
  - `getMrFiles` → 从 changes 接口提取 `new_path` 字段
  - `postMrComment` → `POST /api/v4/projects/{projectId}/merge_requests/{mrIid}/notes`
  - `postMrLineComment` → `POST /api/v4/projects/{projectId}/merge_requests/{mrIid}/discussions`(含 `position` 参数:base_sha / start_sha / head_sha / new_path / new_line)
  - `getBotComments` → `GET notes` + 过滤 `author.username === <bot user>`
- 错误处理:401/403/404/429/5xx 给出可读错误,避免吞错

### R2 · 实装 run.ts blocker 扫描

- `runReview` 跑完 pi-coding-agent 后调 `gitlab_get_previous_review` 等价路径拉本次新发评论,若有 `severity=blocker` 则 `exitCode=1`,否则 `0`
- 需要区分「本次跑发的评论」vs「历史评论」(基于时间戳或评论 id 边界)

### R3 · 真实 MR 端到端跑通

- 在 Q2 确定的 GitLab 实例(`http://gitlab.xhgjdev.com`)+ fork 自 srm-esign 的 sandbox 仓库上跑两次完整流程:
  - **R3.a · MR-general**:配置文件类 diff,自动选 skill 应落到 `general`
  - **R3.b · MR-security**:路径含 `auth|login|crypto|secret|password|token` 的文件 diff(允许 fork 上新建测试文件),并埋一个种子问题(SQL 拼接 / 硬编码 secret),自动选 skill 应落到 `security`
- 模型固定为 `gpt-5.5` + `LLM_REASONING_EFFORT=xhigh`(见 D3 / R4)
- 兜底:在任一 MR 上额外手动跑 `flower-review --skill backend --mr-iid X`,确认 `--skill` 参数路径可强制覆盖
- 验证项见 Acceptance Criteria

### R4 · 在 flower-providers 公开 `buildPiCliArgs()` 统一接口(选 B)

- **背景**:flower-providers/runtime.ts:50-54 注释明确「code-reviewer 形态由 pi CLI 自己管 thinking level,不调 `getDefaultReasoningEffort`」;而 code-reviewer/run.ts 当前 `piMain(["-p", prompt], ...)` 没传 `--thinking` / `--model`,导致 env 配置在 print 模式下被忽略
- **设计决策**:用户选 B(统一接口),不选 A(内联实现);理由:与 flower-providers 「env 解析集中在本包」的现有设计哲学对齐,避免 code-reviewer 又开一套 env 读取
- **要做**:
  - 在 `packages/flower-providers/src/runtime.ts` 新增公开函数 `buildPiCliArgs(input: { prompt: string }): string[]`,内部读 `LLM_MODEL` + `LLM_REASONING_EFFORT`,翻译成 argv
  - 在 `packages/flower-providers/src/index.ts` re-export
  - code-reviewer/run.ts import `buildPiCliArgs` 调用即可
- **约束**:
  - env 缺省时不传对应 argv,让 pi CLI 走自己的默认
  - `LLM_MODEL` 复用 `env.ts/getLLMModel()` 的校验(确保模型 id 在合并清单内)
  - `LLM_REASONING_EFFORT` 复用 `env.ts/getLLMReasoningEffort()` 的 6 级合法值校验
  - **不**复用 `getDefaultReasoningEffort`(那是 ops-bot 形态接 SDK 用的,接口语义不同)
- **接口对称性**:
  | 消费者 | flower-providers 提供 | 输出类型 | 用途 |
  |--|--|--|--|
  | ops-bot | `buildHavefunModel` + `getDefaultReasoningEffort` | SDK 对象 + 枚举 | 传给 `new Agent({ ..., streamFn })` |
  | code-reviewer | **`buildPiCliArgs`**(R4 新增) | `string[]` | 传给 `piMain(argv, ...)` |

### R5 · flower-compliance 补单元测试基线

- **背景**:flower-compliance 当前 `src/{index.ts,audit.ts}` 共 160 行,**零单测覆盖**;它是两个产品的「只读防线」,本任务依赖它跑 ci-readonly 模式,顺带建测试基线
- **要做**:
  - 新建 `packages/flower-compliance/src/__tests__/index.test.ts`,覆盖:
    - `ci-readonly` 模式下 `write` / `edit` 工具触发 → `block: true`,reason 可读
    - `ci-readonly` 模式下 `bash` 命令首词在白名单(如 `git status`)→ 通过
    - `ci-readonly` 模式下 `bash` 命令首词非白名单(如 `curl http://x`)→ `block: true`,reason 含命令首词
    - `production-readonly` 模式下不注册拦截 hook(纯审计)
  - 新建 `audit.test.ts`,覆盖:`SIEM_INGEST_URL` 不配时不发请求;`DEBUG_AUDIT=1` 时 console.log;失败不抛
- **约束**:测试用 vitest(与项目其他单测一致);mock `fetch` 与 `pi.on`,不发真请求

## Acceptance Criteria

### 单元测试层(实装质量)

- [ ] **AC1**:flower-tools-gitlab 5 个 endpoint(getMrDiff / getMrFiles / postMrComment / postMrLineComment / getBotComments)单元测试覆盖 happy path
- [ ] **AC2**:flower-tools-gitlab 至少 1 个错误路径(401 或 404)单元测试,确认错误信息可读
- [ ] **AC3**:`run.ts` blocker 扫描单元测试:有 blocker → exitCode=1;无 blocker → 0;无新增评论 → 0
- [ ] **AC4**:`run.ts` argv 翻译单元测试:`LLM_MODEL=gpt-5.5` + `LLM_REASONING_EFFORT=xhigh` 时 piMain 收到的 argv 含 `--model gpt-5.5 --thinking xhigh`;env 不配时 argv 不含对应 flag

### e2e 真跑层(产品价值)

- [ ] **AC5 (V1 · 链路完整性)**:MR-general + MR-security 各跑一次 `flower-review --mr-iid <N>`,无 uncaught exception,exitCode 符合预期
- [ ] **AC6 (V2 · 评论真发出去了)**:两个 MR 在 GitLab UI 上各 ≥ 1 条评论(行内或整体);二次跑时 `gitlab_get_previous_review` 能返回上一轮评论
- [ ] **AC7 (V3 · LLM 真在干活)**:MR-security 内 LLM 至少识别 1 个埋好的种子问题(SQL 拼接 / 硬编码 secret 中至少一类)
- [ ] **AC8 (V4 · 不重复评)**:同一 MR 二次跑后,人工对比两轮评论 list,**无重复评论**(同问题同位置不重复出现)
- [ ] **AC9 (skill 选型路径)**:MR-general 自动选 skill 落到 `general`(stdout 可见 `[code-reviewer] 使用 skill: general`);MR-security 落到 `security`
- [ ] **AC10 (--skill 兜底)**:任一 MR 上额外手动跑 `--skill backend`,确认 skill 强制覆盖路径可用(不要求评论质量)

### 合规拦截层(被动 e2e + 单测补强)

- [ ] **AC11 (CP1 · 被动 e2e)**:e2e 跑动中开启 `DEBUG_AUDIT=1`,stdout 至少能看到 1 条 `[audit]` 事件(session_start / tool_call / tool_result 任一),证明审计 hook 真实触发
- [ ] **AC12 (CP1 · 可选证据)**:若 LLM 自然尝试调 `write`/`edit` 工具,被合规拦截,stdout 能看到 block reason(可遇不可求,不强制必触发,但出现就记录到 journal)
- [ ] **AC13 (CP3 · 拦截规则单测)**:flower-compliance `__tests__/index.test.ts` 覆盖 ci-readonly 下 write/edit 必拦、bash 白名单分支、bash 非白名单分支、production-readonly 不注册拦截 hook;全部 pass
- [ ] **AC14 (CP3 · 审计上报单测)**:`__tests__/audit.test.ts` 覆盖 SIEM_INGEST_URL 缺省静默、DEBUG_AUDIT=1 console.log、fetch 失败 console.warn 不抛;全部 pass

## Out of Scope (explicit)

- 自动评分评论质量(人工抽检替代)
- 多 GitLab 版本兼容性矩阵(只验目标实例)
- flower-tools-common 的 zentao/dingtalk-doc stub(与本任务无关,留给 ops-bot 后续任务)

## Research References

- 暂无外部 research,后续若涉及 GitLab discussions API position 字段细节会补一份 `research/gitlab-discussions-api.md`

## Notes

- 本 PRD 是 brainstorm 中间产物,Q1-Q6 未答完不算定稿
- 复杂任务,后续需补 design.md + implement.md 再 `task.py start`
