# Implementation Plan · walkthrough blocker 一致化(agent 自审方案)

> 三件套之 implement.md。基于 `prd.md` R1-R7 + `design.md` §1-§6,展开 ordered checklist + 验证命令 + review gate。

## 总体顺序

```
Phase 1 · review-trace.ts 扩展(数据底座)            (~30 min)
Phase 2 · extension.ts tool_call 补提取 + 新工具注册   (~45 min)
Phase 3 · prompts.ts 工作流改造 + 正反例 few-shot      (~30 min)
Phase 4 · 整套质量门(typecheck + lint + 全 vitest)   (~10 min)
Phase 5 · e2e 真跑 MR-2 验收 + LLM 行为观察            (~15 min)
Phase 6 · spec 沉淀 + commit                          (~15 min)
```

工作量预估:**≈ 2-2.5 小时**(纯代码,无外部依赖,改动量比 v1 方案略小)。

---

## Phase 1 · `review-trace.ts` 扩展

**目的**:落地 design.md §1。先把数据底座扩展好,后续 Phase 2/3 才能正确使用。

**Checklist**:
- [ ] 1.1 `packages/flower-code-reviewer/src/review-trace.ts` 扩展 `PostedLineComment` 接口加 `severity` + `title` 字段(design.md §1.1)
- [ ] 1.2 同文件加纯函数 `extractBlockerTitle(body: string): string`(design.md §1.2),含 marker 剥离 + 第一行抽取 + 等级前缀正则
- [ ] 1.3 `recordLineComment` 改为对象签名 `({file, line, severity, body})`:
  - 内部调 `extractBlockerTitle(body)` 抽 title
  - push 到 `trace.lineComments` 时存 4 个字段(file/line/severity/title)
- [ ] 1.4 `packages/flower-code-reviewer/src/__tests__/review-trace.test.ts` 加 case:
  - **AC2.1**:`recordLineComment({file:"a.ts", line:1, severity:"blocker", body:"🔴 **阻塞** · X\n..."})` → `lineComments[0]` 含全字段且 `title === "X"`
  - **AC2.2**:`severity:"major"` 也正确记录
  - **AC2.3**(向后兼容):跑现有 `findUnsupportedComments` case 全过
  - 新增 `extractBlockerTitle` 4 case(`·` / 空格分隔 / marker / 空 body)

**验证**:
```bash
cd packages/flower-code-reviewer && pnpm vitest run review-trace
```

**Review gate**:title 抽取在 4 种 body 格式下都正确;现有 `findUnsupportedComments` 单测零修改全过(只需更新调用处的 `recordLineComment` 参数为对象形式)。

---

## Phase 2 · `extension.ts` tool_call 补提取 + 新工具注册

**目的**:落地 design.md §2。把 LLM 实际调用 `gitlab_post_line_comment` 的 severity / body 入参传到 trace;新增 `reviewer_list_my_blockers` 工具。

**Checklist**:
- [ ] 2.1 `packages/flower-code-reviewer/src/extension.ts` 的 `registerReviewTrace` 中 `gitlab_post_line_comment` 分支补提取 `severity` + `body`,加 4 字段类型守卫,调新版 `recordLineComment({...})`(design.md §2.1)
- [ ] 2.2 同文件新增函数 `registerReviewerSelfTools(pi)`(design.md §2.2),用 `pi.registerTool` 注册 `reviewer_list_my_blockers`:
  - name / label / description(完整文案见 design.md §2.2)
  - parameters: `{type: "object", properties: {}, additionalProperties: false}`(无参)
  - execute: 读 trace,过滤 blocker,map 出 `{path, line, title}` 数组,返回 `{count, blockers}`
- [ ] 2.3 default export 注册序列加 `registerReviewerSelfTools(pi)`,位置:`registerReviewTrace` 之后、`registerObservability` 之前(design.md §2.3)
- [ ] 2.4 新建 `packages/flower-code-reviewer/src/__tests__/extension.test.ts`:
  - **AC3.1**:mock 一个简易 `ExtensionAPI`(只需 `on` / `registerTool` 两个方法),调 `extensionFactory(mockPi)`;然后触发一个 `gitlab_post_line_comment` event,断言 trace 记录完整
  - **AC3.2**:event input 缺 severity → 不记录
  - **AC1.1**:trace 有 2 blocker + 1 major → 直接调注册到 mock 的 execute → 返回 count=2 + 2 条
  - **AC1.2**:trace 空 → count=0, blockers=[]
  - **AC1.3**:1 blocker body 含 `🔴 **阻塞** · 硬编码 secret` → blockers[0].title === "硬编码 secret"
  - **AC1.4**:body 用空格分隔 → title 抽取仍正确(通过 extractBlockerTitle 单测覆盖,这里集成 case 1 个即可)
  - **AC1.5**:断言注册时传入的 schema `parameters.properties` 为空 object,`additionalProperties: false`

**验证**:
```bash
cd packages/flower-code-reviewer && pnpm vitest run extension
```

**Review gate**:工具 execute 在 mock 环境跑通;返回结构与 design.md §0.1 时序图一致(`{count, blockers:[{path,line,title}]}`)。

---

## Phase 3 · `prompts.ts` 工作流改造 + 正反例 few-shot

**目的**:落地 design.md §3。教 LLM 学会"先调 reviewer_list_my_blockers 再写 walkthrough alert 块"。

**Checklist**:
- [ ] 3.1 找到 `prompts.ts` 现有工作流步骤序列(grep `步骤` / `工作流`),确定插入位置(发完 line_comment 后、发 walkthrough 前)
- [ ] 3.2 插入新 step「校对本轮 blocker 真值」,文案见 design.md §3.1:
  - 强约束:`**必须**调`、`不允许靠对话历史记忆数`、`**逐条照抄**`、`严禁修改 path / line / title 字面值`
  - 0 blocker 情况:`不要插入 alert 块`
- [ ] 3.3 在「示例」段加正例 few-shot(design.md §3.2),展示工具返回 → walkthrough alert 块的对应关系(4 blocker 4 列表)
- [ ] 3.4 在「示例」段加反例 few-shot(design.md §3.3),引用本次 stress test 4 vs 3 案例 + 说明"靠记忆会丢"
- [ ] 3.5 同步更新 `__tests__/prompts.test.ts`:
  - **AC4.1**:`expect(prompt).toContain("reviewer_list_my_blockers")`
  - **AC4.2**:`expect(prompt).toContain("必须调")` + `toContain("逐条照抄")`
  - **AC4.3**:`expect(prompt).toContain("反例")`(或反例中的特征字串)
  - 同时确保现有 AC(`> [!caution]` 降级测试 / 严格要求段 / few-shot 等)全过

**验证**:
```bash
cd packages/flower-code-reviewer && pnpm vitest run prompts
```

**Review gate**:工作流新 step 在 LLM 视角逻辑通顺(发完 line_comment → 校对 → 发 walkthrough);反例 few-shot 直接复用本次 stress test 案例,有教育价值。

---

## Phase 4 · 整套质量门

**目的**:确保整个 monorepo 编译 / lint / 测试干净。

**Checklist**:
- [ ] 4.1 `pnpm -r typecheck`(或 `npx tsc --build`)全过
- [ ] 4.2 `pnpm -r lint`(biome check)全过 — 重点关注 `recordLineComment` 旧位置参数已全部更新(extension.ts 是唯一 caller)
- [ ] 4.3 `pnpm -r test`(vitest)全过(149 → 149+N,N = 本任务新增 case 数)
- [ ] 4.4 `git diff --stat` 确认改动只在 design.md §0.1 列出的文件范围:
  - `packages/flower-code-reviewer/src/{review-trace.ts, extension.ts, prompts.ts}`
  - `packages/flower-code-reviewer/src/__tests__/{review-trace.test.ts, extension.test.ts(new), prompts.test.ts}`
  - 任务三件套(自动跟踪)

---

## Phase 5 · e2e 真跑 MR-2 验收 + LLM 行为观察

**目的**:落地 AC5。本任务的核心 risk(LLM 是否真的调工具 + 照抄)只能 e2e 验证。

**Checklist**:
- [ ] 5.1 flower 仓 commit + push 本任务改动到 main(或新建分支 push)→ 触发镜像 build pipeline
- [ ] 5.2 等 Harbor 上新 image tag 出来(查 `192.168.27.236/base/flower-code-reviewer:<sha>`),记录 sha
- [ ] 5.3 在 pineapple `xhgj003027/xhgj-iqs-ui` MR-2 `.gitlab-ci.yml` 加 `FLOWER_IMAGE_TAG: <new-sha>`(或回滚 latest)
- [ ] 5.4 push 一个空 commit 或 retry pipeline,触发新一轮评审
- [ ] 5.5 抓 job trace,**重点核对**:
  - observability 输出中是否出现 `🔧 [tool →] reviewer_list_my_blockers` + `🔧 [tool ←] reviewer_list_my_blockers result={...}` 一对(LLM 真的调了)
  - 工具返回的 blockers 数组 vs 后续 walkthrough body 顶部 alert 块的 N + 列表 → 是否一致
- [ ] 5.6 walkthrough 内容 vs line_comment 实际情况比对(MR UI 上看):
  - 数量一致(N === 真实 blocker line_comment 数)
  - path:line 一一对应(无漏 / 无增 / 无错)
  - title 与 line_comment 第一行去前缀后一致

**Review gate**:LLM 确实调了 `reviewer_list_my_blockers` 工具,且 walkthrough 顶部内容与工具返回逐条一致。

**如果 e2e 失败**:
- LLM 没调工具 → 加强 prompt 强约束措辞 + 重跑;若仍不调,考虑在 prompt 中加 "thinking" hint 段
- LLM 调了不抄 → 反例 few-shot 加更显眼的 "错误" 标记 + 重跑
- 极端情况:LLM 调用方式持续不对(≥ 2 次迭代仍不行)→ 退到 design.md §0.3 描述的"回归 v1 的触发条件"评估,但**当前任务不切回 v1**

---

## Phase 6 · spec 沉淀 + commit

**目的**:把本任务引入的两个模式(`reviewer_*` 命名空间 + agent 自审工具范式)沉淀到 spec。

**Checklist**:
- [ ] 6.1 在 `.trellis/spec/flower-code-reviewer/frontend/index.md` 「关键设计点」段加一节:
  - **`reviewer_*` 命名空间**:语义 = 评审专用元工具(只读评审 trace,不发外部 API);现有工具 `reviewer_list_my_blockers`;后续若加 `reviewer_get_trace` 等,沿用前缀
  - **agent 自审工具范式**:对"LLM 易出错的自我概括类任务"(数量统计 / 列表照抄等),优先**给确定性工具 + prompt 强约束**,而非代码 post-process;明确写出 walkthrough 一致化任务的 v1 post-process 弃用记录,避免后续误回潮
- [ ] 6.2 同 spec 文件「评论模板规范」段如有 walkthrough 顶部 alert 块描述,补一行:"alert 块的 N + 列表通过 `reviewer_list_my_blockers` 工具传递真值,LLM 照抄"
- [ ] 6.3 `git add -A && git commit`,commit message:
  ```
  feat(flower-code-reviewer): walkthrough alert 块一致化(agent 自审工具方案)

  - review-trace 扩展记录 severity + title
  - 新增 reviewer_list_my_blockers 工具(本地 trace 读,不发 API)
  - prompts.ts 工作流强制 LLM 写 walkthrough 前调工具拿真值并照抄
  - 不引入代码 post-process(v1 弃用方案,见 design.md §0.3)
  ```
- [ ] 6.4 `python3 ./.trellis/scripts/task.py archive`
- [ ] 6.5 在 journal `.trellis/workspace/silentflower/journal-1.md` 加 1 行小结(任务完成 + 关键决策点:agent 自审 vs 代码强改)

---

## Rollback 点

| 阶段 | 失败如何回滚 |
|---|---|
| Phase 1 单测红 | 改 `recordLineComment` / `extractBlockerTitle` 直到绿;`findUnsupportedComments` 不应被影响 |
| Phase 2 单测红 | 工具 execute 返回结构错 → 对齐 design.md §0.1 时序图 `{count, blockers:[{path,line,title}]}`;mock pi event 抽不到字段 → 检查类型守卫 |
| Phase 3 prompts.test 现有 case 破坏 | 新加内容可能与现有 caution / few-shot 数顺序冲突 → 检查测试是否硬编码 step 编号(若是则同步更新) |
| Phase 4 typecheck 报 `recordLineComment` 旧调用 | extension.ts 是唯一 caller;若有其他地方调,补全(本任务前已 grep 确认,理论上没有) |
| Phase 5 LLM 不调工具 / 调了不抄 | 加强 prompt 强约束 + 反例显眼程度 + 重跑;**不**回退到 v1 post-process,除非满足 design.md §0.3 的回归条件 |
| 上线后线上 review 对该工具调用方式有问题 | revert 一个 commit 即可;reviewer image 滚回上一版;无 DB / migration / 业务方配置变更 |
