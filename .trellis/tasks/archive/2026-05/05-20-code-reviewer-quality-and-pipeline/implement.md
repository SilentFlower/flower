# Implementation Plan · flower-code-reviewer 评审质量优化 + 真实 Pipeline 生产化

> 三件套之 implement.md。基于 `prd.md` R1-R7 + `design.md` 各 §,展开有序 checklist + 验证命令 + review gate + rollback。

## 总体顺序(2026-05-20 修订:简化版)

```
┌─ Day 1 ─────────────────────────────────────────────────────────┐
│  Phase 1 · N2 评论质量(无外部依赖,可即时开干)        ✓ 已完成 │
└─────────────────────────────────────────────────────────────────┘
┌─ Day 2 ─────────────────────────────────────────────────────────┐
│  Phase 2 · N1 LLM 拉代码 + 「无依据评论」blocker 拦截    ✓ 已完成 │
└─────────────────────────────────────────────────────────────────┘
┌─ Day 3 ─────────────────────────────────────────────────────────┐
│  Phase 3 · E1/E2/E3/E5 mitigation + safeRead 接入工具层 ✓ 已完成 │
└─────────────────────────────────────────────────────────────────┘
┌─ Day 4 ─────────────────────────────────────────────────────────┐
│  Phase 4 · N3 简化:手动 push mirror(0.25 Day)                 │
│  Phase 5 · N4 harness 模板  → 拆 sibling task                    │
│           (devops-infra-harness/.trellis/tasks/...harness-template)│
└─────────────────────────────────────────────────────────────────┘
┌─ Day 5 ─────────────────────────────────────────────────────────┐
│  Phase 6 · spec 沉淀 + commit + push(本任务收口)               │
│           真实 fork sandbox MR e2e → 拆给 sibling task 完成后再做│
└─────────────────────────────────────────────────────────────────┘
```

**~~Phase 0 spike~~** → 2026-05-20 决策走 A1 手动 push mirror,**无需 spike**。
总工作量预估(剩余):**≈ 1.5 Day**(Phase 4 简化 + Phase 6 收口)。

---

## ~~Phase 0 · N3 spike~~(2026-05-20 已 OoS)

**决策修订**:原方案 A(Pull Mirror)需要 GitLab server 出公网到 github.com,这是公司合规红线。
改走 **A1 · 开发者本机 push mirror**(`git push xhgjdev main`),走本机出公网,GitLab server 无需出公网。
**spike 与 5 个 question 大部分不再需要**,仅保留 2 条由 sibling task `code-reviewer-harness-template` 跟进。

---

## Phase 1 · N2 评论质量(Day 1,可与 Phase 0 并行)

**目的**:落地 R2(Preset A 完整 CodeRabbit-like 评论模板)。

**Checklist**:
- [x] 1.1 `packages/flower-code-reviewer/src/prompts.ts` 追加 6 条新硬约束(逐字抄 `research/comment-style.md` §5;design.md §1.1 列了 key point)
- [x] 1.2 `prompts.ts` 末尾追加 5 个完整中文模板样例 few-shot(逐字抄 `research/comment-style.md` §6.1-§6.6)
- [x] 1.3 新增 `packages/flower-code-reviewer/src/comments/` 子目录(或按现有约定),实现 `renderWalkthrough` / `renderInlineComment` / `renderCleanReview`(签名见 design.md §1.2)
- [x] 1.4 实现 GitLab 版本探测 `detectGitlabVersion` + `supportsAlertBlock`(design.md §1.3),启动期一次性 cache
- [x] 1.5 `renderWalkthrough` 内集成 alert 块降级分支(`>= 17.10` 用 `> [!caution]`,否则降级 blockquote)
- [x] 1.6 单测:
  - 行内 4 段式渲染 1 case
  - walkthrough 渲染 + 文件变更表渲染 1 case
  - 「无问题」轻量模板 1 case
  - alert 块降级 2 case(17.10+ / <17.10)
  - `[severity:<level>]` 前缀保留(任意模板路径输出 grep `severity:` 命中)
- [x] 1.7 typecheck + lint + test 全绿
- [x] 1.8 临时跑一次 fork sandbox IID 1(用 dev image 或本地 `flower-review --mr-iid 1`),visual check 评论 markdown 在 GitLab 网页渲染正确

**Validation**:
```bash
cd packages/flower-code-reviewer
pnpm typecheck && pnpm lint && pnpm test
# e2e(本地 dev,不依赖 image)
flower-review --mr-iid 1 --project-id 125  # fork sandbox
```

---

## Phase 2 · N1 LLM 拉真实代码上下文(Day 2-3)

**目的**:落地 R3(`gitlab_get_file_content` + 强约束 + 「无依据评论」拦截)。

**Checklist**:
- [x] 2.1 `packages/flower-tools-gitlab/src/client.ts` 加 `gitlab_get_file_content` 函数(签名见 design.md §2.1)
- [x] 2.2 `packages/flower-tools-gitlab/src/index.ts` export 第 6 个工具
- [x] 2.3 `packages/flower-tools-gitlab/src/client.test.ts` 加 3+ case:成功 / 404 / 5xx 重试(参考既有 14 case 模式)
- [x] 2.4 `packages/flower-code-reviewer/src/` 加 `safeReadFile` wrapper(design.md §2.4):env `FLOWER_MAX_FILE_SIZE` + 二进制后缀跳过
- [x] 2.5 `prompts.ts` 加第 7 条硬约束(每文件必读;design.md §2.2)
- [x] 2.6 `packages/flower-code-reviewer/src/run.ts` `scanForBlockers` 扩展 「无依据评论」拦截(design.md §2.3):trace 已拉文件集合 + finalize 时扫 line_comment path 是否 ∉ readFiles
- [x] 2.7 单测:
  - flower-tools-gitlab `client.test.ts`:3+ case 全过
  - flower-code-reviewer `run.test.ts`:mock LLM 不拉文件就发评论 → scanForBlockers 返回「无依据评论」blocker
  - `safeReadFile` 单测:50KB 截断 + .png 跳过 + .lock 跳过 + 正常文件透传
- [x] 2.8 typecheck + lint + test 全绿
- [x] 2.9 fork sandbox IID 2 试跑(本地 dev),verify LLM 实际调用 `gitlab_get_file_content`(看 SIEM trace 或 stdout log)

**Validation**:
```bash
cd packages/flower-tools-gitlab && pnpm test
cd packages/flower-code-reviewer && pnpm typecheck && pnpm lint && pnpm test
flower-review --mr-iid 2 --project-id 125
```

---

## Phase 3 · E1/E2/E3 mitigation(Day 3-4,可与 Phase 4/5 并行)

**目的**:落地 R7 的 E1 LLM fail open + E2 diff cap + E3 sanitize(E5 已在 Phase 2 落)。

**Checklist**:
- [x] 3.1 E1:`run.ts` 顶层 try/catch + `isLlmFailure` 判定 + `postWarningComment` 路径(design.md §5.1)
- [x] 3.2 E1 单测:mock LLM 全失败 → warning 评论 post 1 次 + exit 0
- [x] 3.3 E2:diff 加载阶段加 churn 排序 + cap(env `FLOWER_MAX_FILES` 默认 50);截断时 `renderWalkthrough` 传 `truncatedFiles`(design.md §5.2)
- [x] 3.4 E2 单测:51 文件 mock → 取 top 50 + walkthrough 含「⚠️ 本次仅评 50/51」
- [x] 3.5 E3:新建 `packages/flower-code-reviewer/src/sanitize.ts` `sanitizeQuickActions` 纯函数(design.md §5.3)
- [x] 3.6 E3:`gitlab_post_comment` / `gitlab_post_line_comment` 调用点 wrapper 接入 sanitize
- [x] 3.7 E3 单测:`sanitize.test.ts` 12+ quick action case + 普通行不动 + 多行混合
- [x] 3.8 typecheck + lint + test 全绿

**Validation**:
```bash
cd packages/flower-code-reviewer && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 4 · N3 简化(A1 · 本机 push mirror,Day 4)

**目的**:把 GitHub flower 仓代码送到内网 xhgjdev GitLab,后续 build pipeline 由 sibling task `code-reviewer-harness-template` 接手。

**Checklist**:
- [ ] 4.1 在 xhgjdev GitLab 建 flower 镜像仓(namespace / project name 由 sibling task 拍板;若 sibling 未起,暂用 `infra/flower-mirror`)
- [ ] 4.2 本地 flower 仓 `git remote add xhgjdev http://gitlab.xhgjdev.com/<ns>/flower-mirror.git`
- [ ] 4.3 第一次 push:`git push xhgjdev main:main`(走本机出公网到 xhgjdev,需开发者本机能访问内网)
- [ ] 4.4 verify:xhgjdev GitLab UI 上看到 flower 仓全部代码 + commit 历史一致
- [ ] 4.5(文档化)在 flower 仓 README 或 `.trellis/spec/guides/` 加一条 guide:「每次 release 手动 `git push xhgjdev main`」流程

**Validation**:
```bash
# 本机 push 完成后
git ls-remote xhgjdev main  # 应返回与 origin 一致的 sha
```

**说明**:Phase 4 只做「push 通」,不做镜像 build 也不 push Harbor — 那是 sibling task `code-reviewer-harness-template` 的范围。

---

## ~~Phase 5 · N4 harness 模板~~ → 拆 sibling task

**已拆出**:`devops-infra-harness/.trellis/tasks/05-20-code-reviewer-harness-template`
- 模板撰写 / harness maintainer review / `.gitlab-ci.example.yml` 升级到 include 形式 — 全部归 sibling task
- 本任务里 `packages/flower-code-reviewer/.gitlab-ci.example.yml` 保持现状(裸 image 直引示例 `yourcompany/flower-code-reviewer:latest`),待 sibling task 完成后再升级
- 跨任务接口:sibling task 给出最终 harness path / Harbor namespace / variable 名 → 同步回 flower 仓更新 example

---

## Phase 6 · 收尾(Day 5)

**目的**:本任务范围内的 DoD(N2 / N1 / E1-E5 / spec / commit)收口。
**注意**:真实 MR e2e 拆给 sibling task `code-reviewer-harness-template` 完成后再做。

**Checklist**:
- [x] 6.1 单测 + lint + typecheck 全绿(全部 4 个 package,Phase 3 已 ✓ 320+ cases)
- [x] 6.2 spec 沉淀(本次跨包发现):
  - `.trellis/spec/flower-code-reviewer/frontend/index.md`(评论模板规范 / Edge cases / GitLab 版本探测)
  - `.trellis/spec/flower-tools-gitlab/backend/index.md`(`gitlab_get_file_content` endpoint / severity 词表 `blocker/major/minor` / 工具层 sanitize / 工具层 safeReadFile cap)
  - `.trellis/spec/flower-tools-common/backend/index.md`(`sanitizeQuickActions` 通用工具)
  - `.trellis/spec/guides/index.md`(新 guide:跨包 utility 收敛模式 + LLM fail-open 模式 + 评审 trace 模式)
- [ ] 6.3 commit + push(flower 仓主分支,本任务范围)
- [ ] 6.4 sibling task 跟进:
  - `devops-infra-harness/.trellis/tasks/...harness-template` 跑 implement(模板撰写 + maintainer review)
  - `code-reviewer-auto-fix-bot` 后启动

**Validation**:
```bash
cd /root/project/flower
npm test          # 320+ cases all green
npm run check     # 0 errors, ≤ 11 warnings
npm run build     # 0 errors
```

---

## Review Gates 汇总

| Gate | 触发时机 | 责任人 |
|------|---------|--------|
| G1 · spike 决策 | Phase 0 末 | silentflower(决策走 A 还是 B.a) |
| G2 · 三件套 review | Phase 1 启动前(`task.py start` 前) | silentflower |
| G3 · 各 Phase 自检 | 各 Phase 末(typecheck + lint + test) | trellis-check sub-agent |
| G4 · harness PR | Phase 5 末 | harness maintainer |
| G5 · e2e visual check | Phase 6 末 | silentflower 人工眼验 |
| G6 · 最终 commit | DoD 全 ✓ | silentflower |

---

## Rollback Plan

| Scope | 回滚动作 |
|-------|---------|
| 镜像新版本有问题 | 业务方仓 `FLOWER_IMAGE_TAG` 锁回上一个 `<sha>` |
| harness 模板有问题 | 业务方 `extends:` 切回 `.gitlab-ci.example.yml` 备用 inline 接入方式 |
| 代码 bug(prompt / 渲染 / sanitize / scanForBlockers) | GitHub flower 仓 git revert → mirror 自动同步 → 下一次 build 出旧版镜像 → `latest` tag 指回旧版 |
| harness PR 合入卡住 | Phase 4 临时 inline 写 `.gitlab-ci.yml`(不走 include),解锁 build;harness PR 合入后再切 include |
| Pull Mirror 出问题(license / 频率) | 切 B.a fallback(GitHub Actions → ACR → Harbor) |
| ACR/Harbor 同步问题(B.a) | 手工 docker pull/push 应急同步 |

---

## 不在 implement 范围内

- N5 auto-fix bot(sibling 任务)
- npm registry 发布(Phase 2 长期目标)
- 多业务方扩散 onboarding(推广任务)
- E4 markdown 校验(remark 依赖,延后)
- 多 LLM 模型矩阵
