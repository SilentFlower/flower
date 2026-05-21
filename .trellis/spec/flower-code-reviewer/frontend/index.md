# Frontend Development Guidelines

> `@flower-ai/flower-code-reviewer` 的对外接口/入口层(CLI、prompt、skill 装配)开发规范。

---

## Overview

本项目是 Node.js / TypeScript 后端项目,**没有浏览器前端**。
本目录(`frontend/`)在本项目里重新解读为"**面向用户/调用方的入口层**":

| 通用前端概念 | 本项目对应物 |
|--------------|---------------|
| 页面 / 路由 | CLI 子命令、`process.argv` 解析(`src/args.ts`) |
| 组件 | 入口模块(`cli.ts`、`run.ts`、`extension.ts`) |
| Hook | pi 扩展工厂、`pi.on()` 事件订阅、`pi.registerTool()` |
| State Management | CLI 参数对象(`CliArgs`)、运行期上下文 |
| Accessibility | CLI 输出可读性、错误信息可操作性、`--help` 完整度 |
| Type Safety | TypeScript strict、`Type.Object` schema、参数 parse 校验 |

### 包定位

- 形态:**CLI 应用**,运行在 GitLab CI 容器内,跑完即退出
- 入口:`packages/flower-code-reviewer/src/cli.ts` → `dist/cli.js`(可执行 `flower-review`)
- 依赖:`@earendil-works/pi-coding-agent`(以 print 模式调 `piMain`)
- 触发:CI 注入 `CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID`,bot 评审 MR 并发评论

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | `src/` 目录布局与文件职责 |
| [Component Guidelines](./component-guidelines.md) | 入口模块(cli/run/extension)的拆分与签名约定 |
| [Hook Guidelines](./hook-guidelines.md) | pi 扩展工厂的注册顺序、`pi.on` 钩子用法 |
| [State Management](./state-management.md) | CLI 参数、环境变量、运行期上下文如何流转 |
| [Quality Guidelines](./quality-guidelines.md) | Biome 风格、强制要求与禁止模式 |
| [Type Safety](./type-safety.md) | TypeScript strict、`Type.Object` schema、`any` 的边界 |

---

## 写作目标

子 agent(`trellis-implement` / `trellis-check`)读完这些 spec 后应当能:

1. 知道 `cli.ts` → `run.ts` → `extension.ts` 的职责边界,不会把业务逻辑塞进 `cli.ts`
2. 写新工具时按 `defineTool({ name, label, description, parameters, execute })` 的标准结构
3. 不在 `cli.ts` / `run.ts` 里直接 console.log 评审意见(必须走 GitLab 工具;dry-run `--dry-run` 是例外)
4. 改 prompt 时知道必要的硬约束:
   - **severity 词表 = `blocker | major | minor`**(对齐 flower-tools-gitlab `severitySchema` 与 `comments/render.ts`,**禁止**残留旧词表 `info | warning | blocker`)
   - 工具优先(评论必须经 GitLab 工具发出)/ 不重复评论 / 第 4 条「禁止 `^/<quick-action>` 行」/ 第 7 条「每变更文件必读 `gitlab_get_file_content`」/ 第 8 条「diff 截断时必须写 N/M 截断说明」

---

## 关键设计点(2026-05-20 N2/N1/E1/E2/E3 沉淀)

### 1. 评论模板规范(Preset A · CodeRabbit-like,2026-05-20 中文化 + HTML 注释 marker 二次迭代)

- **行内评论 4 段式**:emoji + 加粗中文等级 + 标题 一行(紧凑形式)+ 解释段(讲 why)+ `<details>` 包 reasoning(可选)+ `suggestion` 块(可选)
  - 中文等级:🔴 **阻塞** / 🟠 **重要** / 🔵 **建议**(SEVERITY_META 在 `comments/render.ts`,2026-05-20 从英文 Blocker/Major/Minor 升级中文化)
  - 例:`🔴 **阻塞** · 硬编码 secret 存在凭据泄漏风险`
- **整体评论 walkthrough**:整 body 包 `<details>` 默认折叠,内含「概要 / 文件变更表 / 行动建议」
- **`> [!caution]` alert 块版本降级**:启动期 `detectGitlabVersion` 探测一次;GitLab ≥ 17.10 用 `> [!caution]`,< 17.10 / 探测失败 降级 `> ⚠️ **Caution**` blockquote
- **「无问题」轻量模板**:MR 干净时只发 2 行(`:white_check_mark:` 前缀)
- **severity marker 语义**(2026-05-20 二次迭代):
  - **不在 body 写** `[severity:<level>]` 字面文本(原 v1 设计已废)
  - 仅 blocker 评论由 `flower-tools-gitlab/postMrComment` / `postMrLineComment` wrapper **自动以 HTML 注释 marker 注入**:`<!-- severity: blocker -->` 作为 body 首行;GitLab markdown 渲染时 HTML 注释不显示,用户视图完全干净
  - `run.ts:scanForBlockers` regex 同时匹配新 HTML 注释 marker + 旧 `^\[severity:blocker\]` 字面前缀(向后兼容历史评论)
  - major/minor 评论 body 完全无任何 severity marker
- **模板样例**:5 个完整中文样例存于 `.trellis/tasks/archive/2026-05/05-20-code-reviewer-quality-and-pipeline/research/comment-style.md` §6.1-§6.6;`prompts.ts` few-shot 同步中文化(标题 = `🔴 **阻塞** · ...`,严禁 LLM 在 body 写 `[severity:*]`)

### 2. GitLab 版本探测(`comments/gitlab-version.ts`)

- `detectGitlabVersion(client)`:`GET /api/v4/version` → 解析 `major.minor`,**module-level 三态缓存**(`undefined` 未探测 / `null` 探测失败 / `{major, minor}` 成功)
- 失败 fail-tolerant:无 token / HTTP 非 200 / 网络错 / 字段缺失全部归 null,**不抛错不阻塞主流程**
- `supportsAlertBlock(null) === false`(默认降级路径)
- `run.ts` 启动期 `await detectGitlabVersion()` 一次 + 传给 `buildPrompt({gitlabVersion})`,§6.6 alert 块模板根据版本动态切换(LLM few-shot 学到的就是正确版本写法)

### 3. Edge case 防御(E1/E2/E3/E5)

| Edge | 实现 | 文件 |
|------|------|------|
| **E1 · LLM 网关 fail open** | `isLlmFailure(err)` 5 级判定(AuthError 黑名单 / LLM 关键字 / 网络关键字 / HTTP 5xx 429 / 默认 fail close);LLM 失败 → `buildLlmFailureNotice` warning 评论 + `return exitCode: 0` 不阻塞 pipeline;**非 LLM 错误(AuthError / FileNotFoundError)正常抛**;但 `scanForBlockers` 触发的 blocker(已成功评出的)仍 fail close | `run.ts` |
| **E2 · MR diff size cap** | env `FLOWER_MAX_FILES`(默认 50);`applyDiffCap` 按 churn(additions + deletions)降序稳定排序取 top N;截断时 prompt 注入 `truncation: {shown, total}` → LLM 在 walkthrough 必须写「⚠️ 本次仅评 N/M 个最大变更文件,其余请手工 review」 | `run.ts` + `prompts.ts` |
| **E3 · quick action sanitize** | `sanitizeQuickActions(body)`(在 `@flower-ai/flower-tools-common`),50+ quick action 关键字 + 大小写不敏感;首字符 `/` → `&#47;`;flower-tools-gitlab 的 post 评论工具 execute 内 wrap;与 prompt 第 4 条硬约束形成**双层防御** | `flower-tools-common/src/sanitize.ts` + `flower-tools-gitlab/src/index.ts` |
| **E5 · 单文件 size cap + 二进制跳过** | `safeReadFile` wrapper 在 `flower-tools-gitlab/src/safe-read.ts` 工具层,`gitlab_get_file_content` execute 内 wrap;env `FLOWER_MAX_FILE_SIZE`(默认 51200);二进制按后缀(18 类)跳过;LLM 永远拿不到超 50KB 或二进制原始内容 | `flower-tools-gitlab/src/safe-read.ts` |
| **E4 · markdown 校验** | **延后**(remark 依赖较重);mitigation 暂留 prompt 5 个完整模板样例引导 LLM 复制 |

### 4. 评审 trace 单例 + 「无依据评论」blocker 拦截

- **`review-trace.ts` module-level 单例** `ReviewTrace`:`recordFileRead` / `recordLineComment` / `resetTrace` / `getTrace` / `findUnsupportedComments`
- `extension.ts` `pi.on('tool_call', ...)` 监听:`gitlab_get_file_content` 调用 → `recordFileRead` 累计 readFiles;`gitlab_post_line_comment` → `recordLineComment` 累计已发评论
- `run.ts` finalize 阶段(LLM 全部 tool call 完成后)调 `findUnsupportedComments(readFiles, lineComments)` → 若 line_comment 的 `path` ∉ `readFiles` → 拼 `[severity:blocker] 无依据评论:对 ${path} 发出评论但未读完整文件` 整体评论 post 一次 → `scanForBlockers({unsupportedCommentFiles})` 触发 exit 1
- **`scanForBlockers` 重载**:旧位置参数 `(beforeIds, after)` 兼容,新对象签名 `({beforeIds, after, unsupportedCommentFiles?})` 扩展;渐进迁移

### 5. 注册顺序(extension.ts)

`provider → compliance → tools(含 gitlab) → review-trace 监听 → observability 监听`;review-trace 与 observability 的 `pi.on(tool_call)` 必须挂在 gitlab tools `pi.registerTool` 之后才能拿到 tool_call event。

### 6. observability extension(`observability.ts`,2026-05-20 加)

- 监听 pi-coding-agent 生命周期事件,把 LLM 的「思考 / 文本输出 / 工具调用 / 工具结果」流式打印到 stdout(GitLab CI job log),让业务方在 pipeline trace 里直接看到完整评审轨迹
- **默认开**(business 零配置即可看);`FLOWER_VERBOSE=0` / `false` / `off` / `no` 显式关
- 输出格式:`>>> 🤖 [turn N] start/end` / `💭 thinking: ...` / `💬 assistant: ...` / `🔧 [tool →] <name> args=...` / `🔧 [tool ←] <name> result=...` / `🔧 [tool ✗ error]`(compliance 拦截等)/ `>>> 🤖 [agent] session end`
- tool input / result 截断 400 / 300 字符,防 GitLab CI 日志爆 + 敏感内容泄漏(image 内 safeReadFile 已在工具层 size cap,observability 再加一层 echo 截断)
- 监听事件:`turn_start` / `turn_end` / `message_update`(assistantMessageEvent.type ∈ {`thinking_*` / `text_*` / `toolcall_end`})/ `tool_execution_end` / `after_provider_response`(仅 HTTP ≥ 400 提示)/ `agent_end`

### 7. audit 默认静默(`flower-compliance/audit.ts`,2026-05-20 加)

- audit 失败(SIEM 不可达等)默认**完全不打 warn**(audit 是 fail-open 设计,失败不影响主流程,不该刷屏 GitLab CI 日志)
- 调试场景:`DEBUG_AUDIT=1` 打单行 `[audit] 上报失败: <msg> (<error.cause.code>)`;不再打多层 stack(原 11 行 ECONNREFUSED stack → 0 行)

### 8. 镜像版本管理 + Dockerfile 优化(2026-05-20 演进链)

flower 仓 Dockerfile 优化(`packages/flower-code-reviewer/Dockerfile`)产出 image 路径 `192.168.27.236/base/flower-code-reviewer:<tag>`:

| commit | 优化点 | image 大小变化 |
|---|---|---|
| `ba58509` | tsc --build 指定 reviewer + transitive deps,避免顶层 tsconfig refs 未 COPY package 触发 TS5083 | — |
| `e089aed` | `npm prune --omit=dev` 砍 devDeps(biome / typescript / vitest 等)| 727 → 466 MB(本地)/ 149.3 → 90.1 MiB(Harbor)|
| `d12b7b5` | koffi multi-arch 18 个砍到 musl_x64 1 个 | 466 → 434 MB / 90.1 → 82.8 MiB |
| `5252e2e` | 加 `/usr/local/bin/flower-review` PATH wrapper(GitLab CI script 模式可调,不依赖 ENTRYPOINT) | — |
| `839236d` | observability extension 集成 | — |
| `54641cb` | audit 失败改单行 warn | — |
| `7e847ea` | audit 默认静默 + 中文等级 + HTML 注释 marker | — |

累计减重:Harbor compressed 149.3 → 82.8 MiB(**−45%**);本地 727 → 434 MB(**−40%**)。

业务方接入侧 image tag 管理:
- 默认 `latest`(浮动跟 flower 仓 main HEAD)
- 锁版本场景:Runner `pull_policy=IfNotPresent` 限制下,**必须用 sha tag 才能强制拉新**(latest cache 命中不会自动更新)— 推荐业务方 `code-review: variables: { FLOWER_IMAGE_TAG: '<sha>' }`

### 9. agent 自审工具范式 + `reviewer_*` 命名空间(2026-05-21 walkthrough 一致化任务沉淀)

#### 9.1 Convention · `reviewer_*` 命名空间

新命名空间 `reviewer_*` 用于**评审专用元工具**,与 `gitlab_*` 工具区分:

| 命名空间 | 语义 | 是否发外部 API |
|---|---|---|
| `gitlab_*` | GitLab REST API 包装 | ✅ 发 GitLab API |
| `reviewer_*` | 评审专用元工具,只读评审本地 trace / 状态 | ❌ 不发任何外部 API |

**当前 `reviewer_*` 工具**:
- `reviewer_list_my_blockers`:返回本轮 LLM 已发的 blocker 级 line_comment 列表(`{count, blockers:[{path,line,title}]}`)— 数据源 `review-trace.ts` 单例

**何时加 `reviewer_*` 工具**:LLM 需要查询"评审过程本地状态"(本轮已读哪些文件 / 已发什么评论 / trace 元数据)时,优先 `reviewer_*` 而非新 `gitlab_*` API 调用 — 因为本地 trace **快、严格"本轮"语义、无 API 配额消耗**。

**注册位置**:`packages/flower-code-reviewer/src/reviewer-self-tools.ts`(与 `extension.ts` 同级);在 `extension.ts` 注册序列中位于 `registerGitlabTools` 之后、`registerReviewTrace` 之前。

#### 9.2 Design Decision · agent 自审 vs 代码 post-process(v1 弃用记录)

**Context**:LLM 在长上下文里"自我概括类任务"(数量统计 / 列表照抄 / 多步骤同步)易出错。2026-05-21 stress test 实测:LLM 发了 4 条 blocker line_comment,但 walkthrough 顶部 alert 块写「3 个 blocker」并漏列 1 条。

**Options Considered**:
1. **v1 · 代码 post-process 强改 walkthrough body**:`run.ts` 在 `scanForBlockers` 之后用 line_comment 真值重写 walkthrough 顶部 alert 块,通过 `editMrNote` PUT 改 GitLab note
2. **v2 · agent 自审工具 + prompt 强约束**:新增 `reviewer_list_my_blockers` 工具给 LLM,prompt 工作流强制 LLM 在写 walkthrough 前调工具拿真值并照抄

**Decision**:**v2(已采用)**

**Why**:
- v1 把 LLM 当不可靠零件然后用代码兜底,违反 agent 独立完成的产品方向
- v1 后续会形成路径依赖:每次发现 LLM 概括出错的新维度都加一层 post-process,拼出越来越大的"代码强改 LLM 输出"层
- v2 给 LLM **确定性工具拿真值**,LLM 学会"先调工具再写"的模式可迁移到其他自审场景

**Trigger 回归 v1 的硬条件**(明确写下,避免误判):
- e2e 实测加强 prompt 后 LLM **仍然 ≥30% 概率不调工具或不照抄**,且**已经穷尽** prompt 工程方案(包括 hard-inject system message)。
- 当前**不**采取 v1,即使未来真触发回归,也应该是有充分实测数据后的明确决策。

#### 9.3 Convention · 自审工具实现要点

```typescript
// reviewer-self-tools.ts
export const reviewerListMyBlockersTool = defineTool({
  name: "reviewer_list_my_blockers",         // snake_case + reviewer_ 前缀
  label: "列出本轮已发的 blocker",            // 中文 label
  description: [                              // 多行 description 必须含:
    "返回...",                                // - "做什么"
    "数据从评审本地 trace 内存中读,**不发 GitLab API 请求**。",  // - "数据源约束"
    "用法:在写 walkthrough 整体评论之前调用,...",              // - "何时用 + 怎么用"
    "返回结构:`{ count: number, blockers: [...] }`(JSON 文本)",  // - "返回结构"
  ].join("\n"),
  parameters: Type.Object({}),                // 无参 → 空对象
  async execute(_id) {
    const trace = getTrace();
    const blockers = trace.lineComments.filter(...).map(...);
    const payload = { count: blockers.length, blockers };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: { count: blockers.length },
    };
  },
});
```

**关键点**:
- `description` 必须告诉 LLM **不发 API**(避免 LLM 误以为可能延迟或失败)
- 返回 JSON 文本到 `content[0].text`(LLM 直接读到结构化字符串),`details` 仅供 trace 显示
- `execute` 内**不抛错**(LLM 自审工具不应阻断主流程;空数据返回 `count:0` 即可)

#### 9.4 prompt 强约束写法

`prompts.ts` 工作流加 step 时,**必须**用以下措辞强度:
- `**必须**调` / `**严禁**靠对话历史记忆` / `**逐条照抄**` / `**不允许**摘要 / 漏列 / 增列 / 改字面值`
- 加 **正例 few-shot**(展示"工具返回 → walkthrough 照抄"对照)
- 加 **反例 few-shot**(展示"靠记忆 → 漏列"的真实失败用例,**用真实 stress test 数据**最有教育价值)
- 不加"如果不方便"" 可选"等软化词(违反 quality-guidelines.md 的"prompt 不软化硬约束")

### 10. e2e reviewer 真跑验证 SOP(GitLab REST API 操作 · 2026-05-21 沉淀)

业务方 MR 上跑完 reviewer 后,常见需求:**清空旧评论 + 触发 retry + 监控镜像 build**。本节固化通过 GitLab REST API 操作的步骤,**避免每次手工进 GitLab UI 反复点**。

#### 10.1 必备:GitLab 个人 token

token 来源(优先级):
1. env `GLAB_NEW_TOKEN`(开发者本地 token,所有 `xhgj***` 命名空间项目通用)
2. env `GITLAB_TOKEN`(reviewer 容器内 CI 注入,本地 e2e 操作不一定有)

scope 要求:`api`(读写 notes / pipelines / branches);`PRIVATE-TOKEN` header 鉴权(非 `Authorization: Bearer`)。

`GITLAB_HOST = http://gitlab.xhgjdev.com`(企业内网实例)。项目 path 含 `/` 必须 `encodeURIComponent`(`xhgj003027/xhgj-iqs-ui` → `xhgj003027%2Fxhgj-iqs-ui`)。

#### 10.2 SOP 步骤(凭 GLAB_NEW_TOKEN curl 直接调,不进 GitLab UI)

**Step 1 · 备份要删的 bot 评论**(删除不可逆,先 dump 到 task `research/`):

```bash
curl -s -H "PRIVATE-TOKEN: $GLAB_NEW_TOKEN" \
  "$HOST/api/v4/projects/$PROJECT/merge_requests/$MR_IID/notes?per_page=100&sort=asc" \
  | python3 -c "import sys,json; notes=[n for n in json.load(sys.stdin) if n['author']['username']=='$BOT_USER' and not n.get('system')]; print(json.dumps(notes,ensure_ascii=False,indent=2))" \
  > .trellis/tasks/<task>/research/mr-notes-backup-$(date +%Y%m%d-%H%M%S).json
```

**Step 2 · 批量删除 bot 评论**(行内 + 整体走同一接口):

```bash
# 关键:DELETE /merge_requests/:iid/notes/:note_id 既能删行内也能删整体
#       不需要先拿 discussion_id(GitLab note_id 全局唯一)
for id in $NOTE_IDS; do
  curl -s -o /dev/null -w "DELETE note $id → HTTP %{http_code}\n" \
    -X DELETE -H "PRIVATE-TOKEN: $GLAB_NEW_TOKEN" \
    "$HOST/api/v4/projects/$PROJECT/merge_requests/$MR_IID/notes/$id"
done
# 期望 HTTP 204(No Content);403 通常意味 token 不是 note 作者且无 Maintainer 权限
```

**Step 3 · 触发 reviewer 重跑**:不要 retry 旧 pipeline(失败 job 复用旧 image),用以下任一:

- 推空 commit 到 source branch → 自动触发新 MR pipeline
- POST `/projects/:id/merge_requests/:iid/pipelines` 直接创建 MR pipeline(需要 token 有 developer+ 权限)

**Step 4 · 监控**:flower 仓 image build pipeline + pineapple MR pipeline 都走 `GET /projects/:id/pipelines`,filter `ref` 和 `status`。

#### 10.3 关键陷阱 + 防御

| 陷阱 | 实际现象 | 防御 |
|---|---|---|
| **flower 仓 `.gitlab-ci.yml` 在 `company` 分支专属** | push 到 main 不触发 image build,什么都没发生 | push 必须到 `company` 分支;main 改动需 `git merge main` 进 company 再 push |
| **company 是公共分支,rebase 会改写历史** | 强 push 后他人 fetch 报 non-FF | 用 `git merge main --no-ff` 创建 merge commit,**不** rebase |
| **GitLab 删评论 API 不分行内 / 整体** | 早期实现尝试 `DELETE /discussions/:disc_id/notes/:note_id` 多走一步拿 disc_id | 直接 `DELETE /merge_requests/:iid/notes/:note_id`,note_id 全局唯一 |
| **token 是用户自己的 PAT,删 note 会留下"已编辑" footprint** | 评论的 system note "<user> deleted comment" 仍在 MR timeline | 接受为预期行为;若需完全无痕,只能用与 bot 同账号的 token 删 |
| **pipeline retry vs 新建** | retry 只重跑 failed/canceled job,**reviewer success 后不会再跑** | 用 push 空 commit 或 API 新建 pipeline 而非 retry |
| **flower image tag 滚 `latest` 在 `pull_policy=IfNotPresent` 下不更新** | reviewer 跑的还是老镜像 → 改动无效果 | 业务方 `.gitlab-ci.yml` 临时锁 `FLOWER_IMAGE_TAG: <sha>`(前 7 位)强制拉新 |

#### 10.4 复用脚本(规划)

后续可把 §10.2 抽成 `scripts/reviewer-e2e-reset.sh <project> <mr_iid>`,封装 backup + delete + retry,减少 e2e 复测的重复操作。**当前未实现,sopt only**。

---

**语言**:本目录文档用中文,代码示例 / 文件路径 / 工具名保持英文。
