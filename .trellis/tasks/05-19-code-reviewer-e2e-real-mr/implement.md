# implement.md — flower-code-reviewer:端到端跑通真实 MR 评审链路

> 基于 prd.md(R1-R5)与 design.md(§2-§5)。每个 step 落到具体文件 + 验证命令。完成顺序按依赖关系排,前序步骤先完成才动后续。

---

## Step 0 · 进入 in_progress(用户审完三件套后)

- [ ] `python3 ./.trellis/scripts/task.py start .trellis/tasks/05-19-code-reviewer-e2e-real-mr`
- [ ] 通过 trellis-route 选择 inline / subagent 模式

> 注:Step 0 是 review gate,**用户在 review prd.md + design.md + implement.md 后再执行**。

---

## Step 1 · flower-tools-gitlab REST 客户端实装(R1)

**目标**:把 `client.ts` 的 stub 替换为真实 REST 调用,保留 `GitlabClient` interface 不变。

### Step 1.1 设计 fetch helper

- [ ] 在 `packages/flower-tools-gitlab/src/client.ts` 顶部加内部 `gitlabFetch(host, token, path, init)` helper,统一:
  - `Authorization: Bearer <token>` header(GitLab 也支持 `PRIVATE-TOKEN`,但 Bearer 更通用)
  - 响应处理:200/201 解 JSON,其他状态码按 design §2.4 抛错(含 endpoint / status / 简短 body 摘要)
  - 重试逻辑:5xx + 网络错误重试 1 次(sleep 2s)
- [ ] 单测:mock fetch,覆盖 200 / 401 / 404 / 429 / 500(后者重试一次后再 500 仍抛)

### Step 1.2 实装 5 个 endpoint

按 design §2.2 表格,在 `createRealClient` 内一次实装:
- [ ] `getMrDiff` → GET changes,拼接每个 file 的 diff(带 `--- a/path` / `+++ b/path` 头便于 LLM 区分文件)
- [ ] `getMrFiles` → GET changes,提取 `new_path`(deleted 取 `old_path`)
- [ ] `postMrComment` → POST notes,body 前缀 `[severity:<level>] `
- [ ] `postMrLineComment` → POST discussions + position(见 Step 1.3)
- [ ] `getBotComments` → GET notes 列表分页 + 过滤 `author.username === botUsername`(`botUsername` 由 Step 1.4 拿)

### Step 1.3 实装 diff_refs 缓存

- [ ] 在 `createRealClient` 闭包内维护 `Map<string, DiffRefs>`
- [ ] `getMrDiff` 调用一次记录 refs;`postMrLineComment` 调用时若缓存缺则补拉(只取 `diff_refs` 字段)
- [ ] position 构造:`position_type: "text"`,5 个 sha/path/line 字段按 design §2.3

### Step 1.4 实装 bot username 自查

- [ ] 新增 internal `fetchBotUsername(host, token)` → `GET /api/v4/user`,返回 `body.username`
- [ ] 用 module-level Map 缓存,key = token 前 8 位(避免日志泄漏全 token)
- [ ] `getBotComments` 调用前先确保 username 已 fetch

### Step 1.5 单元测试

- [ ] 新建 `packages/flower-tools-gitlab/src/__tests__/client.test.ts`,vitest mock fetch,覆盖:
  - 5 个 endpoint happy path(AC1)
  - 401 错误信息含 endpoint 路径(AC2)
  - 404 错误信息含 projectId/mrIid
  - postMrLineComment 自动拉 diff_refs 后再发(验证缓存逻辑)
  - getBotComments 过滤 author.username 不命中的 note

**验证命令**:
```bash
cd packages/flower-tools-gitlab && pnpm vitest run
```

**Review gate**:Step 1 跑完手动 grep 确认无 `[Stub]` 字符串残留:
```bash
grep -rn "Stub" packages/flower-tools-gitlab/src/
```

---

## Step 2 · `buildPiCliArgs` 实装(R4 · 落在 flower-providers)

### Step 2.1 在 flower-providers 加公开函数

- [ ] 在 `packages/flower-providers/src/runtime.ts` 文件末尾追加 `buildPiCliArgs` 函数(按 design §3.3)
- [ ] 复用 `env.ts` 已有的 `getLLMModel` / `getLLMReasoningEffort`(注意:`getLLMModel` 缺省会 throw,需 try-catch 让 CLI 路径透传给 pi 默认)
- [ ] 在 `packages/flower-providers/src/index.ts` re-export `buildPiCliArgs`

### Step 2.2 单元测试(在 flower-providers 包内)

- [ ] `packages/flower-providers/src/__tests__/runtime.test.ts`(若已存在则扩展)新增一组 `describe("buildPiCliArgs")` 测试,vitest stubEnv:
  - env 全缺省(LLM_MODEL 也缺省)→ `argv = ["-p", prompt]`(AC4 反向)
  - `LLM_MODEL=gpt-5.5` + `LLM_PROVIDER=havefun-openai-responses` → argv 含 `"--model", "gpt-5.5"`
  - `LLM_REASONING_EFFORT=xhigh` → argv 含 `"--thinking", "xhigh"`
  - 两个都设(LLM_BASE_URL/LLM_API_KEY 也得 stub,因 getLLMModel 校验链路)→ 两个 flag 都在(AC4)
  - 非法 LLM_REASONING_EFFORT(如 `"super-high"`)→ 直接 throw(沿用 env.ts 校验)

### Step 2.3 code-reviewer 消费

- [ ] `packages/flower-code-reviewer/src/run.ts` 顶部 import `buildPiCliArgs` from `@flower-ai/flower-providers`
- [ ] `piMain` 调用从 `piMain(["-p", prompt], ...)` 改为 `piMain(buildPiCliArgs({ prompt }), ...)`

**验证命令**:
```bash
cd packages/flower-providers && pnpm vitest run __tests__/runtime
```

---

## Step 3 · run.ts blocker 扫描实装(R2)

### Step 3.1 改造 run.ts

- [ ] 导入 `gitlabClient`(已在 Step 1 实装)和 `buildPiCliArgs`(已在 Step 2 实装)
- [ ] 在 `piMain` 前 snapshot bot 已发评论 id 集合
- [ ] piMain 调用使用 `buildPiCliArgs({ prompt })`(已在 Step 2.3 接通)
- [ ] piMain 完成后拉新评论 list,diff 出 newComments
- [ ] regex `^\[severity:blocker\]` 扫描;命中 → `exitCode = 1`

### Step 3.2 边界处理

- [ ] CI_PROJECT_ID / CI_MERGE_REQUEST_IID 缺失但有 `--mr-iid` 时,blocker 扫描需要 projectId,**fallback 用 env 或抛错**(此场景仅本地调试,允许 console.warn 跳过扫描返回 0)
- [ ] getBotComments 失败时不阻塞 piMain 已经完成的事实,降级:console.warn + exitCode=0(评论已发,扫描失败不能反向定罪)

### Step 3.3 单元测试

- [ ] `packages/flower-code-reviewer/src/__tests__/run.test.ts`,mock `gitlabClient` 与 `piMain`:
  - 跑前 0 条,跑后新增 1 条 `[severity:blocker]` → exitCode=1(AC3)
  - 跑前 1 条 blocker,跑后还是同一条 → exitCode=0(snapshot 生效)
  - 跑前后都无 blocker → 0
  - getBotComments 抛 → exitCode=0 + console.warn

**验证命令**:
```bash
cd packages/flower-code-reviewer && pnpm vitest run __tests__/run
```

---

## Step 4 · flower-compliance 单测基线(R5 / CP3)

### Step 4.1 ci-readonly 拦截规则单测

- [ ] `packages/flower-compliance/src/__tests__/index.test.ts`,按 design §4.2 模板:
  - write 被拦 / edit 被拦
  - bash 白名单 `git status` 通过 / `git diff HEAD` 通过
  - bash 非白名单 `curl http://x` 被拦,reason 含 `curl`
  - production-readonly 模式不注册拦截 hook,只注册审计 hook

### Step 4.2 audit 单测

- [ ] `__tests__/audit.test.ts`,vi.stubEnv + vi.stubGlobal("fetch", ...):
  - SIEM_INGEST_URL 空字符串 → fetch 未调
  - SIEM_INGEST_URL 配置 + DEBUG_AUDIT 未设 → fetch 调 1 次,body 含 record 字段
  - DEBUG_AUDIT=1 + URL 空 → console.log 1 次,fetch 未调
  - fetch reject → console.warn 1 次,不抛

**验证命令**:
```bash
cd packages/flower-compliance && pnpm vitest run
```

---

## Step 5 · 全量单测 + lint

- [ ] `pnpm -r build`(所有 package)
- [ ] `pnpm -r test`(根目录 turbo / pnpm 跑所有单测)
- [ ] `pnpm -r lint`(biome 或现有 lint 链)

**Review gate**:Step 5 全绿后,可以进 Step 6 e2e。

---

## Step 6 · Fork sandbox 准备(我代劳,通过 GitLab API)

> Token 已就绪(`/root/.config/secrets/credentials.env` → `GLAB_NEW_TOKEN`,实测有效 / `GET /api/v4/user` 返回 200,username=`xhgj003027`),无需用户额外操作。

### Step 6.1 准备 token 注入

- [ ] 在跑任何 GitLab API 前,在每条命令前 `source /root/.config/secrets/credentials.env && export GITLAB_TOKEN=$GLAB_NEW_TOKEN GITLAB_HOST=http://gitlab.xhgjdev.com`
- [ ] 单测层不需要这步(全 mock)

### Step 6.2 通过 API fork 仓库

- [ ] 查询源仓库 ID:`GET /api/v4/projects/digital-independent-projects%2Fsrm-esign`(URL encode)
- [ ] 调 `POST /api/v4/projects/<id>/fork`(默认 fork 到 token owner namespace = `xhgj003027`)
- [ ] 若 fork 已存在(409),跳过
- [ ] 拉取 fork project id(后续 `CI_PROJECT_ID`)

### Step 6.3 准备 MR-general 和 MR-security 的种子分支

- [ ] 在本地或临时目录 `git clone http://oauth2:$GITLAB_TOKEN@gitlab.xhgjdev.com/xhgj003027/srm-esign.git`
- [ ] 拉分支 `e2e/test-general`,改 `README.md` 加几行 → commit + push
- [ ] 拉分支 `e2e/test-security`,新增文件 `src/auth/login-helper.ts`(或 `.java`,先看 srm-esign 是什么语言)含 design §5.3 种子问题 → commit + push

### Step 6.4 通过 API 创建两个 MR

- [ ] `POST /api/v4/projects/<fork id>/merge_requests` 各创建一次,记录 IID
- [ ] 把 fork project id + 两个 MR IID 记录到 task 工作目录(`.trellis/tasks/.../e2e-resources.local.md`,gitignore)

---

## Step 7 · e2e 第一跑:MR-general

### Step 7.1 准备 MR

- [ ] 在 fork 上拉分支 `e2e/test-general`,改 `README.md` 加 2-3 行
- [ ] 推上去,在 GitLab UI 上点 Create MR(目标 = fork 的默认分支)
- [ ] 记下 MR IID

### Step 7.2 跑 review

```bash
source /root/.config/secrets/credentials.env
export GITLAB_TOKEN=$GLAB_NEW_TOKEN
export GITLAB_HOST=http://gitlab.xhgjdev.com
export CI_PROJECT_ID=<Step 6.2 拿到的 fork project id>     # 实测 125
export CI_MERGE_REQUEST_IID=<Step 6.4 拿到的 MR-general IID> # 实测 1
# LLM 网关凭据:来源 /root/.config/opencode/opencode.json 的 myprovider.options
# baseURL 字段去掉 /v1 后缀(flower-providers 内部按 provider 拼正确后缀,见 spec error-handling.md)
export LLM_BASE_URL=https://jp-ai.havefun.eu.cc
export LLM_API_KEY=<同 opencode.json myprovider.options.apiKey>
export LLM_PROVIDER=havefun-openai-responses
export LLM_MODEL=gpt-5.5
export LLM_REASONING_EFFORT=xhigh
export DEBUG_AUDIT=1
cd packages/flower-code-reviewer
npm run dev -- --mr-iid $CI_MERGE_REQUEST_IID 2>&1 | tee /tmp/e2e-general.log
```

> **注**:本仓库是 npm workspaces 不是 pnpm,用 `npm run dev`(原模板 `pnpm dev` 不可用)。

### Step 7.3 验证

- [ ] stdout 含 `[code-reviewer] 使用 skill: general`(AC9)
- [ ] exitCode 是 0 或 1(AC5)
- [ ] GitLab UI 上 MR 至少 1 条评论(AC6)
- [ ] stdout 含至少 1 条 `[audit]` 行(AC11)

### Step 7.4 二次跑(AC8 准备)

重复 Step 7.2 一次,human-eye diff `/tmp/e2e-general.log` 与上一轮评论列表,确认无重复评论(AC8)

---

## Step 8 · e2e 第二跑:MR-security

### Step 8.1 准备 MR

- [ ] 在 fork 上拉分支 `e2e/test-security`,**新增**文件 `src/auth/login-helper.ts`(或 .java,看 srm-esign 实际语言),内含 design §5.3 模板的两个种子问题
- [ ] 推上去,Create MR
- [ ] 记下 MR IID

### Step 8.2 跑 review

同 Step 7.2,改 `CI_MERGE_REQUEST_IID`。

### Step 8.3 验证

- [ ] stdout 含 `[code-reviewer] 使用 skill: security`(AC9)
- [ ] exitCode 符合预期(种子问题被 LLM 打 blocker 时为 1,info/warning 时为 0,**不强行要求 1**)
- [ ] GitLab UI 上 MR 至少 1 条评论(AC6)
- [ ] **AC7 关键**:人工查看 LLM 评论内容,确认至少 1 个种子问题被识别(SQL 拼接 / 硬编码 secret)
- [ ] stdout 含至少 1 条 `[audit]` 行(AC11)
- [ ] 二次跑同 MR,确认无重复评论(AC8)

---

## Step 9 · --skill 兜底跑(AC10)

- [ ] 在 MR-security 上额外跑一次 `--skill backend`,确认 stdout 含 `[code-reviewer] 使用 skill: backend`,链路无报错(评论可有可无,本步只验 args 路径)

---

## Step 10 · 整理交付物 + 更新 spec

### Step 10.1 trellis-update-spec

- [ ] 把以下「实装过程中发现的事实」写进 spec:
  - GitLab discussions `position` 字段坑(diff_refs 来源、5 字段必填)→ `flower-tools-gitlab/backend/<相关 spec>.md` 或新增 `gitlab-discussions-api.md`
  - severity 前缀约定(`[severity:<level>] ` 写进 body)→ `flower-tools-gitlab/backend/spec` 加一段
  - pi CLI argv 翻译策略(LLM_MODEL / LLM_REASONING_EFFORT → --model/--thinking)→ `flower-code-reviewer/backend/spec` 加一段
  - flower-compliance 单测策略(mock pi.on)→ `flower-compliance/backend/spec` 加一段

### Step 10.2 PR / push 准备

- [ ] `trellis-check-all`(全面检查)
- [ ] 若 ok,`/trellis:finish-work` 走 commit + push

---

## Validation Commands(汇总)

```bash
# 单测层(Step 1-5)
pnpm -r build && pnpm -r test && pnpm -r lint

# e2e 层(Step 7-9)
# 见各 step 的命令块
```

## Review Gates

| Gate | 何时 | 校验 |
|--|--|--|
| **G1** | Step 0 前 | 用户审 prd.md + design.md + implement.md |
| **G2** | Step 5 完成 | 所有单测 + lint 绿;实装层完成 |
| **G3** | Step 6 完成 | fork 仓库已存在 / 两个 MR 已创建 / project id + MR IID 已记录 |
| **G4** | Step 9 完成 | e2e 全部 AC 通过(AC5-AC12) |
| **G5** | Step 10.1 完成 | spec 更新到位 |

## Rollback Points

- 任一 Step 失败 → git stash + 回到上一个 commit
- Step 1-5 单测层失败 → 不影响线上,只是本任务延期
- Step 7-9 e2e 层失败 → 不影响线上(改的是 fork 仓库 + 本任务分支),回滚 = 删 fork 分支 + 删本任务分支
- 无任何生产 state / DB / 不可逆操作
