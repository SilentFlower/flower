# flower-code-reviewer · walkthrough blocker 列表与 line_comment 一致化

## 0. 触发场景

2026-05-21 在 `xhgj003027/xhgj-iqs-ui` MR-2 跑 stress test(pipeline 2127 / job 7552,`gpt-5.5 + high effort`)时实测发现:

- LLM 实际通过 `gitlab_post_line_comment` 发了 **4 条 severity=blocker 的行内评论**。
- 但同一次评审里 LLM 发的整体 walkthrough 评论(`gitlab_post_comment`)顶部 `> [!caution]` alert 块写的是「本次评审发现 **3 个 blocker 级问题**」并只列了 3 条 `Blocker 列表`。
- 数量 + 列表 **与实际行内评论不一致**,漏列 `src/utils/exportHelper.ts:18`(token 进 URL query 那条)。

CI exitCode 由 `run.ts:scanForBlockers` 基于 line_comment 的 `<!-- severity: blocker -->` marker 计算,**仍然正确 fail close**;但 MR 作者打开 MR 第一眼看到的 walkthrough 顶部数字 / 列表是 LLM 自由概括的,会**漏修被 LLM 漏列的 blocker**,push 后 CI 再次 fail 才意识到,信任崩塌。

## 1. Goal

walkthrough 整体评论顶部 alert 块里的 **blocker 数量 + 列表** 由 flower-code-reviewer 代码 **post-process 改写**(不再让 LLM 自由概括),保证与本轮实际 post 的 blocker line_comment **完全一致**(数量、文件:行号、问题标题)。

## 2. Requirements

### R1 · 计数与列表绑定 line_comment 真值

walkthrough 顶部 alert 块的 N(blocker 数)与 blocker 列表,**必须**等于本轮 `getBotComments` 新增 + 携带 blocker marker 的 line_comment 集合,**不依赖 LLM 自由概括**。

### R2 · 兼容 alert 块降级

当前 `prompts.ts` 已经按 GitLab 版本输出两种 alert 块语法:
- GitLab ≥ 17.10:`> [!caution]`
- GitLab < 17.10:`> ⚠️ **Caution**` blockquote 降级

post-process **两种语法都要识别 + 重写**。

### R3 · 仅在本轮真的发了 walkthrough 时改

如果 LLM 本轮没发整体评论(只发了 line_comment 就结束 / 完全没问题走 `:white_check_mark:` 模板),**不**触发改写,避免空操作发请求。

### R4 · 0 blocker 情况

如果本轮 line_comment 中 blocker = 0:
- 若 walkthrough 含 alert 块 → **删除整个 alert 块**(无 blocker 不应再吓人)
- 若 walkthrough 无 alert 块 → 不动

### R5 · 改写失败不影响主链路

post-process 调 GitLab API `PUT note` 失败时:
- 仅 `console.warn`,**不抛错**
- 不影响 `scanForBlockers` 的 exitCode 决策(那部分已经独立)
- 不重试(单次 best-effort,避免 GitLab API 偶发故障把整个评审流程拖垮)

### R6 · 不破坏现有 walkthrough body 其他段落

post-process 只改 alert 块那一段,**不**碰下方的 `## 概要` / `## 文件变更` / `## 行动建议` 等正文部分。

### R7 · blocker 列表条目格式与 prompt few-shot 一致

```
- `<path>:<line>` — <一句话标题>
```

标题取自对应 line_comment body 的 **第 1 行去掉前面的 severity emoji + 加粗等级 marker**(如 `🔴 **阻塞** ` 前缀)后剩余文本。规则在 prompts.ts §「评论 markdown 样式」中已固化:行内评论第 1 行是 `<emoji> **<等级中文>** <一句话问题标题>`,直接抽取尾段即可。

### R8 · 不引入新的 LLM tool

post-process 是 `run.ts` 完成阶段的代码逻辑,**不**给 LLM 新增工具,**不**修改 prompts.ts 的工作流。LLM 仍然按现有约定写 walkthrough,但顶部 alert 块在落地前会被静默改写。

## 3. Out of Scope

- ❌ 重设计 walkthrough 整体结构(本任务只动 alert 块那一段)
- ❌ 让 LLM 在生成 walkthrough 之前看到自己的 line_comment 列表(prompt 工程方案 B,被本 PRD 弃用)
- ❌ 整体评论改为程序化生成 / 不让 LLM 写(方案 C,信息密度太低被弃用)
- ❌ 修复 reviewer 其他 known gap(漏识别 blocker / 漏识别 minor 等)— 本任务只解 walkthrough 不一致

## 4. Acceptance Criteria

### AC1 · 单元测试

- [ ] `run.ts` 新增 post-process 函数纯函数单测覆盖:
  - **AC1.1** 输入 4 blocker line_comments + walkthrough 顶部 alert 块写 3 个 → 输出 walkthrough alert 块改写为 4 个,列表 4 条,**其余正文不变**
  - **AC1.2** GitLab ≥ 17.10 alert 语法(`> [!caution]`)正确识别 + 重写
  - **AC1.3** GitLab < 17.10 alert 语法(`> ⚠️ **Caution**`)正确识别 + 重写
  - **AC1.4** 0 blocker line_comment + walkthrough 含 alert 块 → 删除 alert 块,正文保留
  - **AC1.5** 没有 walkthrough(只有 line_comments)→ 返回 `undefined` / 不调编辑 API
  - **AC1.6** walkthrough body 标题抽取:`🔴 **阻塞** 硬编码生产 API Key 会泄漏凭据\n\n...` → 抽出标题字符串 `硬编码生产 API Key 会泄漏凭据`

### AC2 · 集成测试 / e2e

- [ ] 复跑 `xhgj003027/xhgj-iqs-ui` MR-2 现有 commit(`7ac36c00`,本次 stress test 的 5 文件 6 issue 版本)或新构造一个 commit,触发 reviewer,**人工验收**:
  - walkthrough 顶部 alert 块 N 与新增 blocker line_comment 数一致
  - blocker 列表 path:line 与实际 line_comment 一一对应

### AC3 · 旧行为兼容

- [ ] 现有 149 单元测试(`vitest`)全过
- [ ] `biome check`、`tsc --build` 干净
- [ ] 现有 `scanForBlockers` 行为不变(blocker exitCode 仍走 line_comment marker)
- [ ] LLM 发评论的工作流不变(prompts.ts 不动 / 不删 few-shot)

### AC4 · 错误处理

- [ ] 改写阶段调 GitLab PUT 失败 → 进程不 crash,job exit code 仍由 blocker 扫描决定;日志含 `[code-reviewer] walkthrough 一致化改写失败,跳过` 的 warn

## 5. Risks / Open Questions

- ⚠️ **walkthrough 识别 false positive**:LLM 也可能用 `gitlab_post_comment` 发非 walkthrough 整体评论(如「无问题」轻量评论模板)。识别条件必须**收紧**:同时满足 (a) position 为空(整体评论)、(b) id 不在跑前 `beforeIds` 中(本轮新增)、(c) body 含 `:robot:` + `<b>代码评审报告</b>` 关键字(walkthrough 模板特征)。
- ⚠️ **多个 walkthrough 兼容**:理论上 LLM 不应发两条 walkthrough(prompts.ts 工作流第 7 步),但实测出现过乱发的边界。若识别到多条匹配 walkthrough → 取最后 1 条(最新)改写,**前面的不动**(prompt 失控行为本身已经是另一个 bug,本任务不解)。
- ⚠️ **GitLab note PUT 权限**:`REVIEWER_BOT_TOKEN` 需要有改自己 note 的权限(GitLab 默认允许 note 作者改自己的 note,scope = `api`)。文档里加一句"token scope = api"。
