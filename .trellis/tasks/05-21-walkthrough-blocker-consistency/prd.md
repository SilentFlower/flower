# flower-code-reviewer · walkthrough blocker 一致化(agent 自审方案)

## 0. 触发场景

2026-05-21 在 `xhgj003027/xhgj-iqs-ui` MR-2 跑 stress test(pipeline 2127 / job 7552,`gpt-5.5 + high effort`)时实测发现:

- LLM 实际通过 `gitlab_post_line_comment` 发了 **4 条 severity=blocker 的行内评论**。
- 但同一次评审里 LLM 发的整体 walkthrough 评论(`gitlab_post_comment`)顶部 `> [!caution]` alert 块写的是「本次评审发现 **3 个 blocker 级问题**」并只列了 3 条 `Blocker 列表`。
- 数量 + 列表 **与实际行内评论不一致**,漏列 `src/utils/exportHelper.ts:18`(token 进 URL query 那条)。

CI exitCode 由 `run.ts:scanForBlockers` 基于 line_comment 的 `<!-- severity: blocker -->` marker 计算,**仍然正确 fail close**;但 MR 作者打开 MR 第一眼看到的 walkthrough 顶部数字 / 列表是 LLM 自由概括的,会**漏修被 LLM 漏列的 blocker**,push 后 CI 再次 fail 才意识到,信任崩塌。

## 1. Goal

让 walkthrough 顶部 alert 块的 blocker 数量 + 列表与本轮实际发出的 blocker line_comment 完全一致。

**核心哲学**:agent 自己应该能数清自己刚做的事 — **通过给 LLM 一个确定性「自审工具」**`reviewer_list_my_blockers`,让它在写 walkthrough 前先调工具拿到本轮 blocker 真值,然后照抄到 alert 块。

**反方向**(本任务**明确弃用**):由代码 post-process 强改 walkthrough body — 这是把 agent 当成不可靠零件然后绕过去,违反产品方向(agent 独立完成);弃用记录见 `design.md` §0.3。

## 2. Requirements

### R1 · 新增 `reviewer_list_my_blockers` 工具(LLM 可见)

- 工具名:`reviewer_list_my_blockers`
  - `reviewer_` 前缀:表明是评审专用元工具,**不是** GitLab API 包装(不进 `gitlab_*` namespace,避免误以为会发 API 请求)
  - `_my_`:强调"我本轮自己发的",避免 LLM 误以为是查询历史评论
- 入参:无
- 出参:
  ```typescript
  {
    count: number;
    blockers: Array<{ path: string; line: number; title: string }>;
  }
  ```
- 数据源:`review-trace.ts` 本地单例(不发 GitLab API roundtrip,**只看本轮 LLM 已通过 `gitlab_post_line_comment` 发出的 blocker**)
- 描述向 LLM 表达清楚:
  > 返回本轮你已通过 `gitlab_post_line_comment` 发出的 blocker 级行内评论列表(从评审 trace 内存中读,不发 API 请求)。在写 walkthrough 整体评论前调用,拿到本轮 blocker 真值,避免靠记忆概括出错。

### R2 · `review-trace.ts` 扩展记录 severity + title

- `PostedLineComment` 接口扩展:
  ```typescript
  export interface PostedLineComment {
    file: string;
    line: number;
    severity: "blocker" | "major" | "minor";  // ← 新增
    title: string;                              // ← 新增(从 body 第一行抽,去 emoji + 加粗等级前缀)
  }
  ```
- `recordLineComment` 签名扩展为对象形式:
  ```typescript
  recordLineComment({ file, line, severity, body }: { file, line, severity, body }): void
  ```
- title 抽取规则:
  - 取 body 第 1 行(`body.split("\n", 1)[0]`)
  - 去前缀 `^[🔴🟠🔵]\s*\*\*\S+\*\*\s*[·•]?\s*`(对齐 spec `flower-code-reviewer/frontend/index.md` §1 中文等级格式 `🔴 **阻塞** · ...`)
  - 若空 fallback 为 `"(无标题)"`
- 现有 `findUnsupportedComments(readFiles, lineComments)` 行为不变(只看 file)

### R3 · `extension.ts` 的 tool_call 监听补提取 severity + body

- 在 `pi.on("tool_call", ...)` 中处理 `gitlab_post_line_comment` 时,**额外提取** `event.input.severity` 和 `event.input.body`,传给新版 `recordLineComment`
- 类型守卫:`severity` 必须 ∈ `{"blocker","major","minor"}`,`body` 必须为 string,否则跳过本次记录(`return undefined`)
- 与现有 compliance / observability hook 顺序不冲突(只是丰富 input 提取)

### R4 · 新工具的注册

- 在 `extension.ts` 的 `registerReviewTrace`(或新增一个 `registerReviewerTools`)中通过 `pi.registerTool` 注册 `reviewer_list_my_blockers`
- 工具 execute 内部:`getTrace().lineComments.filter(c => c.severity === "blocker").map(...)`
- 注册顺序:在 `registerGitlabTools(pi)` 之后(顺序与 review-trace 监听并列即可),确保 compliance / observability 都能正确观察到该工具调用

### R5 · `prompts.ts` 工作流新增校对步骤 + 强约束 + 反例 few-shot

工作流加 step(在「发 walkthrough」之前):

```
步骤 X · 校对 blocker 真值(强制)
- 发完所有 line_comment 后,**必须调** `reviewer_list_my_blockers` 一次
- 工具会返回 `{ count, blockers: [{path, line, title}] }`,代表本轮你刚通过 `gitlab_post_line_comment` 发出的 blocker 级行内评论
- 写 walkthrough 顶部 alert 块时:
  - alert 块中的 **N 数字** = `count`,不允许靠记忆数
  - **Blocker 列表** = `blockers` 中每一条,**逐条照抄** `<path>:<line> — <title>`,不允许摘要、不允许漏、不允许增
- 严禁不调工具直接靠对话历史概括;严禁修改工具返回的 path / line / title 字面值
```

加 1 个正例 few-shot(展示先调工具再写 walkthrough)+ 1 个反例 few-shot(展示「靠记忆漏列」的错误,用本次 stress test 的 4 vs 3 案例)。

### R6 · 不引入代码 post-process(决定性 anti-requirement)

- ❌ **不**改 walkthrough body(LLM 写啥落地就是啥)
- ❌ **不**新增 `editMrNote` 类工具
- ❌ **不**在 `run.ts` 加任何 walkthrough 后处理逻辑
- ✅ `scanForBlockers` 的 exitCode 决策不变(基于 line_comment marker,与 walkthrough 顶部数字无关)— 即使 LLM 在 walkthrough 数字写错,CI 仍然正确 fail close

这条是本任务的**核心约束**:agent 自己做对才算解决问题,代码兜底是绕过去,**v1 post-process 方案在 brainstorm 阶段已被明确弃用**(见 `design.md` §0.3)。

### R7 · 不破坏现有契约

- `recordLineComment` 旧签名(`(file, line)` 位置参数)直接替换为新签名;extension.ts 是唯一 caller,同步改完即可,**不**保留旧重载
- `PostedLineComment` 扩展字段是**新增**,`findUnsupportedComments` 不读这些字段所以零影响
- 现有 149 单测(只调用 `findUnsupportedComments` 等)继续过

## 3. Out of Scope

- ❌ **代码 post-process 改写 walkthrough body**(v1 弃用方案,违反 agent 独立完成的产品方向)
- ❌ 把 walkthrough 改成结构化字段工具(方案 B,损失 LLM 自由表达)
- ❌ LLM 发完 walkthrough 后自校验闭环(方案 C,复杂度高且 LLM 易死循环)
- ❌ 重设计 walkthrough 整体结构(本任务只新增「自审工具 + 工作流校对步」)
- ❌ 修改 `scanForBlockers` 行为(它已经正确,与本任务正交)
- ❌ 修 reviewer 其他 known gap(漏识别 blocker / 漏识别 minor 等)

## 4. Acceptance Criteria

### AC1 · `reviewer_list_my_blockers` 工具单测

- [ ] **AC1.1** trace 含 2 blocker + 1 major line_comment → 工具返回 `count=2`,blockers 数组长度 2,**不**含 major
- [ ] **AC1.2** trace 空 → `count=0`,`blockers=[]`
- [ ] **AC1.3** trace 含 1 blocker(body 含 `🔴 **阻塞** · 硬编码 secret\n详情...`)→ `blockers[0].title === "硬编码 secret"`
- [ ] **AC1.4** trace 含 1 blocker(body 含 `🔴 **阻塞**  硬编码 secret`,等级与标题之间无 `·` 分隔)→ title 抽取仍然正确(regex 兼容空格分隔)
- [ ] **AC1.5** 工具 schema 合法(name / description / 入参 empty object)

### AC2 · `review-trace.ts` 扩展单测

- [ ] **AC2.1** `recordLineComment({file, line, severity: "blocker", body})` → trace.lineComments 末尾追加完整对象,severity / title 正确
- [ ] **AC2.2** `recordLineComment({severity: "major"})` 也能正确记录(不只 blocker)
- [ ] **AC2.3** 现有 `findUnsupportedComments` case 全过(扩展字段不影响 file 集合判定)

### AC3 · `extension.ts` 集成测试

- [ ] **AC3.1** mock 一次 `pi.on("tool_call")` event(`toolName="gitlab_post_line_comment"`,input 含 file/line/severity/body)→ trace.lineComments 含完整对象
- [ ] **AC3.2** mock event input 缺 severity → 不记录该 line_comment(类型守卫拦截),trace 保持空

### AC4 · `prompts.ts` 测试

- [ ] **AC4.1** prompt 含 `reviewer_list_my_blockers` 字串(对 LLM 提及工具名)
- [ ] **AC4.2** prompt 含 `必须调` + `逐条照抄` 字串(强约束)
- [ ] **AC4.3** prompt 含反例 few-shot(本次 stress test 4 vs 3 案例)

### AC5 · e2e 真跑 MR-2 验收

- [ ] 在 `xhgj003027/xhgj-iqs-ui` MR-2 push 一个新 commit(可基于 stress test 同样的多 issue 文件),跑 reviewer:
  - **observability trace 中可见** LLM 调了 `reviewer_list_my_blockers` 工具,返回了 N 条 blockers
  - walkthrough 顶部 alert 块的 N 与 line_comment 实际 blocker 数一致
  - alert 块 Blocker 列表的 path:line 与 line_comment 一一对应,title 与对应 line_comment 第一行去前缀后一致

### AC6 · 旧行为兼容

- [ ] 现有 149 单测全过(`pnpm -r test`)
- [ ] `biome check` + `tsc --build` 干净
- [ ] `scanForBlockers` 行为完全不变(与本任务正交)
- [ ] 现有 `gitlab_post_line_comment` LLM 调用契约不变(input schema 不动)

## 5. Risks

- ⚠️ **LLM 不调工具**:依赖 prompt 强约束 + few-shot 教育。**回退路径**:若 e2e 实测仍不调,二次迭代加 hard inject(在 piMain 调用前用 trace 真值拼一段 system message 末尾强插)— 但仍**不**走代码 post-process。
- ⚠️ **LLM 调了不抄 / 摘要式改写**:few-shot 反例直接展示「漏列」的错误用例;e2e 验证。同上回退路径。
- ⚠️ **不再有代码兜底**:若 LLM 完全不调或完全不抄,walkthrough 数字仍会错;但 **CI exitCode 仍然正确 fail close**(`scanForBlockers` 不变),用户从 CI 状态仍能感知有 blocker — 只是 MR 第一眼数字不漂亮。本任务接受这个 risk,因为 agent 独立完成的产品方向比"100% 不出错的 alert 块"重要。
- ⚠️ **`reviewer_*` 命名空间是本仓首次引入**:未来可能再加 `reviewer_*` 工具(如 `reviewer_list_my_reads` / `reviewer_get_trace`),命名空间需要在 spec 中沉淀约定(本任务作为首例)。

## 6. 关联任务

- 姊妹任务:
  - `05-21-reviewer-trace-noise-cleanup`(reviewer trace 5 类错误信号清理,与本任务正交)
- 同源诱因:同一次 stress test(MR-2 pipeline 2127 / job 7552)暴露的 reviewer 缺陷,本任务专攻 walkthrough 一致性,采用 **agent 自审** 路线。
