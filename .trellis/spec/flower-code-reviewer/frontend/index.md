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
   - 工具优先(评论必须经 GitLab 工具发出)/ 不重复评论 / 禁止 `^/<quick-action>` 行 / 评论前必须读取相关行窗 `gitlab_get_file_content(path, ref, startLine, endLine)` / 行内评论行号必须优先来自 `gitlab_get_mr_diff` 的 `add` / `ctx` 标记 / diff 截断时必须写 N/M 截断说明
   - 评审结束后必须先发代码评审 walkthrough,再单独发第二条「面向测试的变更说明」整体评论

---

## 关键设计点(2026-05-20 N2/N1/E1/E2/E3 沉淀)

### 1. 评论模板规范(Preset A · CodeRabbit-like,2026-05-20 中文化 + HTML 注释 marker 二次迭代)

- **行内评论 4 段式**:emoji + 加粗中文等级 + 标题 一行(紧凑形式)+ 解释段(讲 why)+ `<details>` 包 reasoning(可选)+ `suggestion` 块(可选)
  - 中文等级:🔴 **阻塞** / 🟠 **重要** / 🔵 **建议**(SEVERITY_META 在 `comments/render.ts`,2026-05-20 从英文 Blocker/Major/Minor 升级中文化)
  - 例:`🔴 **阻塞** · 硬编码 secret 存在凭据泄漏风险`
- **第一条整体评论 walkthrough**:整 body 包 `<details>` 默认折叠,内含「概要 / 文件变更表 / 行动建议」
  - 「文件变更表 / 关注等级」列只能使用稳定中文枚举:`🔴 阻塞`、`🟠 重要`、`🔵 建议`、`⚪ 仅说明`
  - 禁止在关注等级列使用 GitLab shortcode 或英文等级,例如 `:large_orange_circle: major`、`:white_circle: 已阅`
- **`> [!caution]` alert 块版本降级**:启动期 `detectGitlabVersion` 探测一次;GitLab ≥ 17.10 用 `> [!caution]`,< 17.10 / 探测失败 降级 `> ⚠️ **Caution**` blockquote
- **第二条整体评论:面向测试的变更说明**:必须单独发送,不能塞进 walkthrough;整 body 包 `<details>` 默认折叠(不得加 `open` 属性),固定包含「变更摘要 / 影响范围 / 测试关注点 / 需求/依据」四项
  - 受众是测试人员,优先写业务 / 行为 / 接口 / 数据变化,文件名和函数名只作为依据补充
  - harness 按需查询,触发条件是开放式业务依据判断;字段含义、权限规则、导入导出模板、业务状态机、跨端约定、版本需求等只是典型例子,不是封闭白名单
  - 如果依据来自 harness,在「需求/依据」中标注文件路径和 ref / commit;未找到时写「未找到权威需求依据」
  - 不硬性限制句数或条目数,但必须避免重复 walkthrough、复述完整 diff 或堆砌无关细节
- **无问题场景**:代码评审评论可保持简洁,但不能作为唯一评论;仍必须额外发送第二条「面向测试的变更说明」
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
| **E6 · 行内评论定位** | `gitlab_get_mr_diff` hunk 内标注 `add` / `ctx` / `del` 和行号;prompt 必须要求 `gitlab_post_line_comment.line` 优先取 `add` / `ctx` 对应的新文件行号,禁止直接使用 `gitlab_get_file_content` 的普通文件行号;工具层会对不可评论行做近邻重定位或降级整体评论 | `flower-tools-gitlab/src/client.ts` + `flower-tools-gitlab/src/index.ts` + `prompts.ts` |
| **E5 · 行窗读取 + size cap + 二进制跳过** | `safeReadFile` wrapper 在 `flower-tools-gitlab/src/safe-read.ts` 工具层,`gitlab_get_file_content` execute 内 wrap;默认只返回 500 行,显式 `startLine/endLine` 时单次最多 1000 行;env `FLOWER_MAX_FILE_SIZE`(默认 51200);二进制按后缀(18 类)跳过;LLM 默认拿不到整份大文件或二进制原始内容 | `flower-tools-gitlab/src/safe-read.ts` |
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
- 输出格式:`>>> 🤖 [turn N] start` / `>>> 🤖 第 N 轮结束 · 第 X 次尝试`(后接多行中文分组摘要)/ `💭 thinking: ...` / `💬 assistant: ...` / `🔧 [tool →] <name> args=...` / `🔧 [tool ←] <name> result=...` / `🔧 [tool ✗ error]`(compliance 拦截等)/ `>>> 🤖 [agent] session end`
- tool input / result 截断 400 / 300 字符,防 GitLab CI 日志爆 + 敏感内容泄漏(image 内 safeReadFile 已在工具层 size cap,observability 再加一层 echo 截断)
- 监听事件:`turn_start` / `turn_end` / `message_update`(assistantMessageEvent.type ∈ {`thinking_*` / `text_*` / `toolcall_end`})/ `tool_execution_end` / `after_provider_response`(仅 HTTP ≥ 400 提示)/ `agent_end`
- turn end 摘要使用多行中文分组格式,优先保证 CI 日志可读性;不要在面向人读的摘要里混入英文机器字段名。若未来要机器采集,单独增加结构化 JSON 输出开关,不要挤进默认日志。示例:
  ```text
  >>> 🤖 第 10 轮结束 · 第 1 次尝试
      总览: 本轮 4829ms · 模型请求 1 次 · 模型响应 1 次 · 工具 0 次 · 工具结果 0 个
      模型接口: 请求开始 4ms · 响应头 3643ms · 未返回等待 n/a · 状态 200
      流式输出: 首个事件 3650ms · 响应头到首个事件 3ms
      文本输出: 本轮首字 3723ms · 响应头到本轮首字 76ms
      工具调用: 首个工具就绪 n/a · 工具总耗时 0ms
  ```
- 首字相关字段语义:
  - `first_agent_message_event_ms`:从 `turn_start.timestamp` 到首个 `message_update` 的耗时;可能是 thinking / text / toolcall,**不是**首字。
  - `first_text_delta_ms`:从 `turn_start.timestamp` 到首个非空 `message_update.assistantMessageEvent.type === "text_delta"` 的耗时;空字符串 delta 不能记录。
  - `first_text_delta_after_provider_ms`:从最近一次 `after_provider_response` 响应头时间到首个非空 `text_delta` 的耗时。
  - 没有文本输出、只有 thinking / toolcall、或 provider 没有响应头时,对应首字字段输出 `n/a`,禁止把 thinking / toolcall 误记成首字。
- 新增或调整观测字段时必须同步更新 `observability.test.ts`,至少覆盖:非空 `text_delta` 首次记录、空 `text_delta` 不记录、无文本输出输出 `n/a`、中文分组说明存在且默认摘要不再出现英文机器字段名。

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
| 2026-05-28 pi 0.76 后续 | pi shrinkwrap 重复依赖去重 + runtime 只复制 dist/package.json/skills + `.dockerignore` 控制 build context | 216.61 → 80.1 MB(`CONTENT SIZE`) |

累计减重:Harbor compressed 149.3 → 82.8 MiB(**−45%**);本地 727 → 434 MB(**−40%**)。

pi 0.76.0 后的 Dockerfile 约束:
- `@earendil-works/pi-coding-agent` 发布包带 `npm-shrinkwrap.json`,npm workspaces 会在多个 `packages/*/node_modules` 下重复安装私有 pi 依赖。reviewer runtime 镜像必须只保留一份根级 `node_modules/@earendil-works/pi-coding-agent` / `pi-ai`,并删除 workspace 内重复副本。
- `@earendil-works/pi-ai` 运行 Bedrock provider 时需要 `@aws-sdk/client-bedrock-runtime`;若把 `pi-ai` 从 workspace 私有目录提升到根级,必须同时确保根级有这份依赖。
- runtime 层只复制各 workspace 的 `package.json` + `dist`;`flower-code-reviewer` 还需要复制 `skills`。禁止把 `src`、测试、`tsconfig.tsbuildinfo`、README 等开发文件带入 runtime。
- Docker builder 使用 `tsc --build --force`;否则 `.dockerignore` 排除本地 `dist` 后,增量构建可能误判为最新并导致容器内缺少 `dist/cli.js`。
- 清理 npm 发布包时只删明确非运行时文件(`*.map`、`*.d.ts`、Markdown、tests/docs/examples 目录)。不要使用过宽的 `CHANGELOG*` 规则:pi-coding-agent 存在运行期 import 的 `dist/utils/changelog.js`,误删会导致 CLI 启动失败。
- 根 `.dockerignore` 应排除本地 `node_modules`、workspace `node_modules`、`dist`、`*.tsbuildinfo`、`.git`、`.trellis/workspace` 等内容,避免 build context 被本地依赖放大。

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
| **main ↔ company 严格单向** | 在 company 上 commit src/spec/task 改动,反向 merge 回 main 会把 company 专属的 CI 历史(`.gitlab-ci.yml`)污染到 main | **铁律**:src / spec / task / docs 改动**必须**先 commit 到 main,再 `git checkout company && git merge main --no-ff` 进 company;**绝不** company → main。violation 修复:`git reset --soft HEAD~1` 撤回 company 上误 commit,`git stash` + `git checkout main` + `git stash pop` 重 commit,再 merge 回 company |
| **company 是公共分支,rebase 会改写历史** | 强 push 后他人 fetch 报 non-FF | 用 `git merge main --no-ff` 创建 merge commit,**不** rebase |
| **transient build 失败:`npm install` ECONNRESET** | image build job 跑到一半 npm registry 网络抖断(2-3min 后报 ECONNRESET) | 不是代码 bug,直接 `POST /projects/:id/pipelines/:id/retry` 重跑(无需新 push);只 retry 失败 job,不重建 pipeline |
| **GitLab 删评论 API 不分行内 / 整体** | 早期实现尝试 `DELETE /discussions/:disc_id/notes/:note_id` 多走一步拿 disc_id | 直接 `DELETE /merge_requests/:iid/notes/:note_id`,note_id 全局唯一 |
| **token 是用户自己的 PAT,删 note 会留下"已编辑" footprint** | 评论的 system note "<user> deleted comment" 仍在 MR timeline | 接受为预期行为;若需完全无痕,只能用与 bot 同账号的 token 删 |
| **pipeline retry vs 新建** | retry 只重跑 failed/canceled job,**reviewer success 后不会再跑** | 用 push 空 commit 或 API 新建 pipeline 而非 retry |
| **flower image tag 滚 `latest` 在 `pull_policy=IfNotPresent` 下不更新** | reviewer 跑的还是老镜像 → 改动无效果 | 业务方 `.gitlab-ci.yml` 临时锁 `FLOWER_IMAGE_TAG: <sha>`(前 7 位)强制拉新 |

#### 10.4 复用脚本(规划)

后续可把 §10.2 抽成 `scripts/reviewer-e2e-reset.sh <project> <mr_iid>`,封装 backup + delete + retry,减少 e2e 复测的重复操作。**当前未实现,sopt only**。

### 10.5 GitLab REST 查询速查 SOP(2026-06-09)

本节用于排查 reviewer、MR 评论、diff、pipeline 或业务方 GitLab 状态。用户明确说明“可以用我环境变量里的 GitLab token 访问 GitLab”时,优先用本 SOP 直接查真实 GitLab,不要凭记忆猜 MR 状态。

#### 10.5.1 范围 / 触发

- 触发:需要确认 MR diff、评论、reviewer 是否发过行内评论、pipeline 是否重跑、镜像 tag 是否生效、GitLab API 返回什么。
- 目标:用环境变量里的 token 进行只读查询或明确授权的维护动作,减少手工进 GitLab UI。
- 安全边界:默认只读;删除评论、创建 pipeline、retry job 等写操作必须有明确目的,并先备份相关数据。

#### 10.5.2 命令 / API 签名

- token 来源:
  - `GLAB_NEW_TOKEN`:开发者本地 PAT,优先使用。
  - `GITLAB_TOKEN`:reviewer / CI token,本地未配置 `GLAB_NEW_TOKEN` 时使用。
- host:
  - `GITLAB_HOST`:可选,未设置时企业内网默认 `http://gitlab.xhgjdev.com`。
- 常用变量:
  - `PROJECT_PATH`:项目 path,例如 `digital-biz-projects/iqs/xhgj-iqs-ui`。
  - `PROJECT`:URL encode 后的 project id/path。
  - `MR_IID`:MR IID,不是全局 MR id。

```bash
TOKEN="${GLAB_NEW_TOKEN:-${GITLAB_TOKEN:-}}"
HOST="${GITLAB_HOST:-http://gitlab.xhgjdev.com}"
PROJECT_PATH="digital-biz-projects/iqs/xhgj-iqs-ui"
PROJECT="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PROJECT_PATH")"
MR_IID="47"
test -n "$TOKEN" || { echo "缺少 GLAB_NEW_TOKEN / GITLAB_TOKEN" >&2; exit 1; }
```

#### 10.5.3 合同

- GitLab REST API 鉴权必须使用 header:`PRIVATE-TOKEN: $TOKEN`;不要把 token 拼到 URL、remote 或日志里。
- `PROJECT_PATH` 含 `/` 时必须整体 URL encode,例如 `a/b/c` → `a%2Fb%2Fc`;不要只 encode 最后一段。
- MR URL 末尾 `/-/merge_requests/47` 中的 `47` 是 `MR_IID`,API 路径使用 `/merge_requests/$MR_IID`。
- 响应需要筛字段时优先用 `python3 -c` 解析 JSON;不要用脆弱的 grep 截 JSON。
- 查询 comments 时 `GET /notes` 覆盖整体评论和行内评论;行内位置在 `position.new_path` / `position.new_line`。
- 查 diff / position 时优先 `GET /changes`,其中 `diff_refs` 是行内评论 position 的 sha 来源。
- 输出日志不得打印 `$TOKEN`,不得把完整评论 body 大段贴到默认日志;必要时截断。

#### 10.5.4 常用查询

**查 MR 基本信息**:

```bash
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "$HOST/api/v4/projects/$PROJECT/merge_requests/$MR_IID" \
  | python3 -c 'import sys,json; m=json.load(sys.stdin); print({k:m.get(k) for k in ["iid","title","state","source_branch","target_branch","sha","merge_status","web_url"]})'
```

**查 MR diff refs 和文件列表**:

```bash
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "$HOST/api/v4/projects/$PROJECT/merge_requests/$MR_IID/changes" \
  | python3 -c 'import sys,json; m=json.load(sys.stdin); print("diff_refs=",m.get("diff_refs")); [print(c.get("new_path"), "deleted=", c.get("deleted_file")) for c in m.get("changes", [])]'
```

**查 bot / reviewer 评论和行内位置**:

```bash
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "$HOST/api/v4/projects/$PROJECT/merge_requests/$MR_IID/notes?per_page=100&sort=asc" \
  | python3 -c 'import sys,json; notes=json.load(sys.stdin); [print(n["id"], n["author"]["username"], (n.get("position") or {}).get("new_path"), (n.get("position") or {}).get("new_line"), str(n.get("body",""))[:120].replace("\n"," ")) for n in notes if not n.get("system")]'
```

**查 MR pipelines**:

```bash
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "$HOST/api/v4/projects/$PROJECT/merge_requests/$MR_IID/pipelines?per_page=20" \
  | python3 -c 'import sys,json; [print(p.get("id"), p.get("status"), p.get("ref"), p.get("sha"), p.get("web_url")) for p in json.load(sys.stdin)]'
```

**查项目 pipelines**:

```bash
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "$HOST/api/v4/projects/$PROJECT/pipelines?per_page=20" \
  | python3 -c 'import sys,json; [print(p.get("id"), p.get("status"), p.get("ref"), p.get("sha"), p.get("web_url")) for p in json.load(sys.stdin)]'
```

#### 10.5.5 校验与错误矩阵

| 条件 | 处理 |
|---|---|
| `$TOKEN` 为空 | 立即停止,提示缺少 `GLAB_NEW_TOKEN / GITLAB_TOKEN` |
| HTTP 401 / 403 | token 无效或权限不足;不要重试刷接口,换 token 或确认 scope |
| HTTP 404 | 优先检查 `PROJECT_PATH` 是否整体 encode、host 是否正确、MR IID 是否来自 URL |
| JSON parse 失败 | 先打印 HTTP code 和响应前 200 字符,通常是鉴权、网关或 HTML 错误页 |
| 需要删评论 | 先按 §10.2 备份 notes;删除走 `/merge_requests/:iid/notes/:note_id` |
| 需要重跑 reviewer | 优先新建 MR pipeline 或推空 commit;不要 retry 已成功的旧 pipeline |

#### 10.5.6 正常 / 基线 / 错误用例

- 正常:用户给出 `http://gitlab.xhgjdev.com/.../-/merge_requests/47`,先从 URL 提取 `PROJECT_PATH` 和 `MR_IID=47`,用 `$GLAB_NEW_TOKEN` 查 `/changes` 与 `/notes`,确认行内评论为什么降级。
- 基线:只需要确认 reviewer 是否跑过,查 `/merge_requests/$MR_IID/pipelines` 和 `/notes`,无需 clone 项目。
- 错误:直接用浏览器 URL 里的未 encode project path 调 API,得到 404 后误判 MR 不存在。

#### 10.5.7 错误与正确示例

##### 错误

```bash
curl "$HOST/api/v4/projects/digital-biz-projects/iqs/xhgj-iqs-ui/merge_requests/47?private_token=$TOKEN"
```

##### 正确

```bash
PROJECT="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PROJECT_PATH")"
curl -s -H "PRIVATE-TOKEN: $TOKEN" "$HOST/api/v4/projects/$PROJECT/merge_requests/$MR_IID"
```

### 11. 跨项目上下文 prompt 约定(2026-05-27)

当业务事实可能不在当前 MR 项目内时,prompt 必须引导 reviewer 使用 `@flower-ai/flower-tools-gitlab` 的跨项目工具按需读取权威文档,而不是依赖当前项目里可能失修的 `doc/`。

#### 11.1 触发条件

- 需要查字段含义、权限规则、导入导出模板、业务状态机、跨端约定、版本需求时,才进入跨项目上下文流程。
- 普通代码风格、命名、局部 bug、单文件实现问题,不要准备跨项目仓库,避免不必要的 GitLab API 和 clone 成本。

#### 11.2 工具顺序

1. `gitlab_list_group_projects`:必要时发现同 group 下的 harness / UI / 服务仓库。
2. `gitlab_list_project_branches`:确认 harness 等仓库的目标 branch / tag / commit 是否存在。
3. `gitlab_prepare_project_workspace`:按需 shallow fetch 指定 ref 到本地临时目录。
4. `bash` + `rg`:只对返回的本地路径做文本搜索。

`gitlab_search_project_blobs` 不属于当前设计:跨项目搜索统一走 prepare workspace 后的本地 `rg`,这样能复用 `rg` 的速度、过滤能力和多文件上下文,也避免在工具层维护一套受限搜索语义。

#### 11.3 事实优先级

- 当前 MR 项目是代码事实来源。
- 业务 / 需求事实优先查配置的 harness 仓库。
- 当前 MR 项目的 `doc/`、`*.md`、`*.csv` 默认只作历史线索,不能作为权威业务依据。
- 如果依据来自 harness,评论中简短说明依据文件路径和 ref / commit。
- 如果 prepare 失败,不要退回当前项目旧 `doc/` 强行下业务结论;应放弃该依据或降低为不确定观察。

#### 11.4 prompt 强约束写法

- 必须写明「跨项目上下文(按需)」,不能让 LLM 每个 MR 都 clone harness。
- 必须写明工具顺序和 `bash + rg` 的后续搜索方式。
- 必须显式写「不使用 `gitlab_search_project_blobs`」,避免 LLM 猜测存在轻量 blob 搜索工具。
- 必须写明当前项目旧文档降权规则,否则 reviewer 容易把失修文档当权威依据。

### 12. 行内评论行号来源 prompt 约定(2026-06-09)

#### 12.1 触发条件

- 修改 `prompts.ts` 中的工作流程、工具使用说明、few-shot 示例时,必须检查本节。
- 修改 `flower-tools-gitlab` 的 diff 输出格式或 `gitlab_post_line_comment` 参数说明时,必须同步本节。

#### 12.2 硬约束

- `gitlab_get_mr_diff` 是行内评论位置的主来源。hunk 内 `add` / `ctx` 标记对应的新文件行号,才是 `gitlab_post_line_comment.line` 的优先来源。
- `del` 标记是旧文件行号,没有可用 `new_line`,不能传给 `gitlab_post_line_comment.line`。
- `gitlab_get_file_content` 返回的是完整文件行窗,用于理解上下文、确认函数和调用方;其中显示的普通文件行号不能直接当作 MR 可评论位置。
- 如果问题语义落在 hunk 外或未改动函数内部,应选择同一 hunk 中最贴近问题的 `add` / `ctx` 标记行;只有 diff 标记行确实不足以定位时,才依赖工具的重定位或降级。
- prompt 中不能写「任选相关文件行号」「使用读取文件内容中的行号」这类弱化约束。

#### 12.3 必需测试

- `prompts.test.ts`:断言工作流程中出现 `add` / `ctx` 行号来源要求。
- `prompts.test.ts`:断言 prompt 明确说明 `gitlab_get_file_content` 行窗行号只作上下文,不要直接用于行内评论。
- `prompts.test.ts`:断言 `del` 行没有可用 `new_line`。

#### 12.4 错误与正确示例

##### 错误

```text
读取 gitlab_get_file_content 后,对发现问题的行调用 gitlab_post_line_comment。
```

##### 正确

```text
先从 gitlab_get_mr_diff 的 add/ctx 标记选择可评论 new_line;gitlab_get_file_content 的行号只用于理解上下文。
```

---

**语言**:本目录文档用中文,代码示例 / 文件路径 / 工具名保持英文。
