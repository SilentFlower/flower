# Implementation Plan · walkthrough blocker 一致化

> 三件套之 implement.md。基于 `prd.md` R1-R8 + `design.md` §1-§4,展开 ordered checklist + 验证命令 + review gate。

## 总体顺序

```
Phase 1 · flower-tools-gitlab 加 editMrNote          (~30 min)
Phase 2 · flower-code-reviewer 加 walkthrough-rewrite 纯函数  (~60 min)
Phase 3 · run.ts 接入 post-process                    (~15 min)
Phase 4 · 整套质量门(typecheck + lint + 全单测)     (~10 min)
Phase 5 · e2e 真跑 MR-2 验收                          (~10 min)
Phase 6 · spec 沉淀 + commit                          (~15 min)
```

工作量预估:**≈ 2.5 小时**(纯代码,无外部依赖)。

---

## Phase 1 · flower-tools-gitlab 加 editMrNote

**目的**:为 walkthrough post-process 提供改 note body 的能力。

**Checklist**:
- [ ] 1.1 `packages/flower-tools-gitlab/src/client.ts` 的 `GitlabClient` 接口加方法签名 `editMrNote(projectId, mrIid, noteId, body): Promise<void>`(design.md §1.1)
- [ ] 1.2 在 `createGitlabClient` 内实装 `editMrNote`:`PUT /api/v4/projects/${encode(projectId)}/merge_requests/${mrIid}/notes/${noteId}`,JSON body `{ body }`,沿用 `gitlabFetch` 默认错误分类
- [ ] 1.3 `packages/flower-tools-gitlab/src/__tests__/client.test.ts` 加 4 个新 case:
  - happy path:method=PUT,URL 正确含 noteId,body JSON 含 body 字段
  - 401 → AuthError
  - 5xx(第二次仍失败)→ RetryableError
  - 普通 404 → 抛 Error 含 "404"

**验证**:
```bash
cd packages/flower-tools-gitlab && pnpm vitest run client.test
```

**Review gate**:editMrNote 签名 + 实装与 postMrComment 镜像对称,错误分类一致。

---

## Phase 2 · flower-code-reviewer 加 walkthrough-rewrite 纯函数

**目的**:落地 design.md §2.1 的 `rewriteWalkthroughBlockers` 纯函数,**单测先行**(TDD)。

**Checklist**:
- [ ] 2.1 新建 `packages/flower-code-reviewer/src/comments/walkthrough-rewrite.ts`,先写 type 签名(`WalkthroughRewriteInput` / `BlockerEntry` / `WalkthroughRewriteOutput`)
- [ ] 2.2 新建 `packages/flower-code-reviewer/src/__tests__/walkthrough-rewrite.test.ts`,按 design.md §2.3 表格写 6 个 case(AC1.1-1.6),全部 expect 红色(函数还没实现)
- [ ] 2.3 在 `walkthrough-rewrite.ts` 实装:
  - **2.3.a** filter 出本轮新增 + walkthrough 特征评论(`!beforeIds.has(id) && file===undefined && line===undefined && body.includes(":robot:") && body.includes("代码评审报告")`)。多个匹配取最后 1 条
  - **2.3.b** filter 出本轮新增 + 带 blocker marker 的 line_comment(`!beforeIds.has(id) && file!==undefined && line!==undefined && /<!--\s*severity:\s*blocker\s*-->/.test(body)`)
  - **2.3.c** title 抽取:正则去 marker + split 第一行 + 去 emoji+加粗等级前缀
  - **2.3.d** alert 块定位:行扫描算法(design.md §2.1 伪码)
  - **2.3.e** 改写逻辑:
    - 有 blocker + 找到 alert 块 → 替换 alert 块
    - 无 blocker + 找到 alert 块 → 删除 alert 块(连带前后空行 1 个)
    - 有 blocker + 无 alert 块 → 跳过(OoS)
    - 无 blocker + 无 alert 块 → 跳过
  - **2.3.f** 用 `supportsAlertBlock(gitlabVersion)` 决定渲染语法
  - **2.3.g** `newBody === oldBody` → 返回 `noteId: undefined`(避免无效 PUT)
- [ ] 2.4 在 `packages/flower-code-reviewer/src/comments/index.ts` 加 `export { rewriteWalkthroughBlockers }` 等

**验证**:
```bash
cd packages/flower-code-reviewer && pnpm vitest run walkthrough-rewrite.test
```

6 case 全绿。

**Review gate**:确认每个 AC1.* 都有对应单测;6.b alert 块定位算法对 LLM 不严格抄 few-shot(空行 / blockquote 嵌套等)的鲁棒性。

---

## Phase 3 · run.ts 接入 post-process

**目的**:落地 design.md §2.2 的接入点,串到主链路。

**Checklist**:
- [ ] 3.1 `packages/flower-code-reviewer/src/run.ts` 在 `scanForBlockers` 调用之后(L314-318 区段),包 try-catch 调 `rewriteWalkthroughBlockers` + `gitlabClient().editMrNote`
- [ ] 3.2 失败时 `console.warn("[code-reviewer] walkthrough 一致化改写失败,跳过:", err)`
- [ ] 3.3 成功时 `console.log("[code-reviewer] walkthrough 一致化:N 个 blocker")`(N = blockers.length)
- [ ] 3.4 `run.ts` 单测确认主链路不受影响(若有相关 mock 需要补 editMrNote stub)

**验证**:
```bash
cd packages/flower-code-reviewer && pnpm vitest run run.test
```

149 → 149+ 全绿(不破坏现有 case;若需要新增 mock 则数字上涨)。

**Review gate**:try-catch 包裹严密,**失败不抛**到 cli.ts(否则 exitCode 会被改成 2)。

---

## Phase 4 · 整套质量门

**目的**:确保整个 monorepo 编译 / lint / 测试干净。

**Checklist**:
- [ ] 4.1 `pnpm -r typecheck`(或 `npx tsc --build`)全过
- [ ] 4.2 `pnpm -r lint`(biome check)全过
- [ ] 4.3 `pnpm -r test`(vitest)全过
- [ ] 4.4 `git diff --stat` 确认改动范围与 design.md §0.1 一致(只动 4 文件 + 2 新增)

---

## Phase 5 · e2e 真跑 MR-2 验收

**目的**:落地 AC2,在 `xhgj003027/xhgj-iqs-ui` MR-2 验证 walkthrough 真改对了。

**Checklist**:
- [ ] 5.1 在 flower 仓 commit + push 上述改动到 main(触发镜像 build pipeline)
- [ ] 5.2 等 Harbor 上新 image tag 出来,记录 sha
- [ ] 5.3 在 pineapple MR-2 `.gitlab-ci.yml` 加 `FLOWER_IMAGE_TAG: <new-sha>` 锁定到新镜像(或等 latest 滚动)
- [ ] 5.4 push 一个空 commit / retry pipeline 触发新一轮评审
- [ ] 5.5 人工核对 walkthrough 顶部 alert 块的 N 和列表 = 实际 blocker line_comment 数 + 位置

**Review gate**:walkthrough 与 line_comment 数量一致,blocker 列表 path:line 对得上。

---

## Phase 6 · spec 沉淀 + commit

**目的**:把 post-process 这个模式沉淀到 spec,后续类似 LLM 自由概括 vs ground truth 不一致的 case 可以复用。

**Checklist**:
- [ ] 6.1 在 `.trellis/spec/flower-code-reviewer/backend/index.md` 加一节「Post-process LLM 输出:walkthrough 一致化」:解释什么时候用 post-process(LLM 概括会丢的事实)、什么时候用 prompt 工程(LLM 能精确表达的语义)
- [ ] 6.2 `git add -A && git commit` 一个干净 commit(commit message: `feat(flower-code-reviewer): walkthrough alert 块 blocker 列表与 line_comment 一致化`)
- [ ] 6.3 `task.py archive` 把任务归档

---

## Rollback 点

| 阶段 | 失败如何回滚 |
|---|---|
| Phase 1 单测红 | 改 client.ts 实装直到红→绿,**不**回滚单测 |
| Phase 2 单测红 | 改 walkthrough-rewrite.ts 直到红→绿 |
| Phase 3 run.ts 改动破坏现有 case | revert Phase 3 commit,只保留 Phase 1+2 工具能力(尚未接入主链路,无副作用) |
| Phase 5 e2e 验收发现 walkthrough 没改对 | 检查 alert 块定位算法是否漏了 LLM 实际输出的 edge case;补 unit test 复现 → 修代码 → 重 push |
| 上线后线上某 MR 触发 walkthrough body 异常 | 因 `run.ts` 包了 try-catch,**最坏情况就是 walkthrough 顶部数字仍旧由 LLM 自由概括**(回到本任务之前的状态),不会有新故障 |
