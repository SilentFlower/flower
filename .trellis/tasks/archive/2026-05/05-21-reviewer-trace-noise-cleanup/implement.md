# Implementation Plan · 修 5 类 reviewer trace 错误信号

> 三件套之 implement.md。基于 `prd.md` R1-R4 + `design.md` §1-§5。

## 总体顺序

```
Phase 1 · Fix A · ref 弹性化(flower-tools-gitlab)         (~60 min)
Phase 2 · Fix B · bash 白名单扩容(flower-compliance)       (~30 min)
Phase 3 · Fix C · exit 1 预告日志(flower-code-reviewer)    (~20 min)
Phase 4 · prompts.ts 集中更新(Fix A + B 共享改动)         (~15 min)
Phase 5 · 整套质量门(typecheck + lint + 全单测)            (~10 min)
Phase 6 · e2e 真跑 MR-2 验证                                  (~10 min)
Phase 7 · commit + archive                                     (~10 min)
```

工作量预估:**≈ 2.5 小时**。建议**单 PR 提交**(3 个 fix 同源诱因,review 一次完)。

---

## Phase 1 · Fix A · ref 弹性化

**目的**:落地 design.md §1。

**Checklist**:
- [ ] 1.1 `packages/flower-tools-gitlab/src/index.ts` 找到 `gitlab_get_file_content` tool 定义,把 `ref` 从 `required` 数组中移除,JSON schema description 加上"省略时自动兜底到 MR source branch;不要传 HEAD"
- [ ] 1.2 在同文件加 `normalizeRef(rawRef: string | undefined): string` 纯函数(实装见 design.md §1.2)
- [ ] 1.3 tool handler 内调 `const ref = normalizeRef(input.ref)`,后续逻辑不变
- [ ] 1.4 新增 `packages/flower-tools-gitlab/src/__tests__/normalize-ref.test.ts`(或并入 tool-sanitize.test.ts),覆盖 AC1.1-AC1.5(5 case)

**验证**:
```bash
cd packages/flower-tools-gitlab && pnpm vitest run normalize-ref
```

**Review gate**:5 个 ref case 全绿;`tool-sanitize.test.ts` 等现有 case 不被破坏。

---

## Phase 2 · Fix B · bash 白名单扩容 + 容器 modern unix

**目的**:落地 design.md §2.2-§2.6 + §2.2.1 Dockerfile 同步。

**Checklist**:
- [ ] 2.1 `packages/flower-compliance/src/index.ts:52` 更新 `bashAllowList` regex(11 → 29 个,含 `rg`):
  ```typescript
  const BASH_ALLOW_LIST = /^(git|grep|rg|find|ls|cat|head|tail|nl|wc|file|sed|awk|sort|uniq|tr|column|diff|comm|printf|echo|basename|dirname|realpath|pwd|date|which|type|command)\b/;
  ```
  (变量名顺便改大写常量风格,贴近模块顶层常量约定)
- [ ] 2.2 同文件加 `SUGGESTION_BY_CMD` 常量 + `buildBashBlockReason()` 函数(design.md §2.4),把 `reason` 字符串生成从内联改为调用 helper
- [ ] 2.3 **Dockerfile 同步**:`packages/flower-code-reviewer/Dockerfile:44` 把
  ```dockerfile
  RUN apk add --no-cache git
  ```
  改为
  ```dockerfile
  RUN apk add --no-cache git ripgrep
  ```
  (`rg` 不在 alpine 基础镜像;白名单放行后必须容器内可执行。`jq` / `yq` 同样不在 alpine 默认镜像,**本任务暂不加**)
- [ ] 2.4 `packages/flower-compliance/src/__tests__/index.test.ts` 加 5 个新 case(AC2.1-AC2.5):
  - it.each(18 新增命令,含 `rg foo packages/`):放行
  - it("env 仍拦"):断言 `block: true` + reason 含 `可能泄漏 secret`
  - it("printenv 仍拦"):同上
  - it("curl 仍拦"):断言 reason 含 `禁止网络外发`
  - it("npm 仍拦"):断言 block
- [ ] 2.5 现有 `whitelistCmds` 数组测试(`__tests__/index.test.ts:72`)加新增的 18 个命令(保持现有 `git status` / `grep` 等放行覆盖)

**验证**:
```bash
cd packages/flower-compliance && pnpm vitest run index.test
# 镜像验证留到 Phase 6 e2e
```

**Review gate**:新加的 18 个命令(含 `rg`)全过;`env` / `curl` / `tee` 等高危仍拦截;reason 文案符合 AC2.4;Dockerfile diff 仅 +`ripgrep`(单行修改)。

---

## Phase 3 · Fix C · exit 1 预告日志(双路径拆分 + trace 真值)

**目的**:落地 design.md §3.1-§3.4。

**Checklist**:
- [ ] 3.1 `packages/flower-code-reviewer/src/run.ts:301` 附近(已有 `const trace = getTrace()`)新增一行,**与 `reviewer_list_my_blockers` 同源真值**:
  ```typescript
  const trace = getTrace();
  const unsupportedFiles = findUnsupportedComments(trace.readFiles, trace.lineComments);
  // ↓ 新增:与 reviewer_list_my_blockers 工具同源,直接复用 trace,不重 filter `after - beforeIds`
  const lineBlockerCount = trace.lineComments.filter((c) => c.severity === "blocker").length;
  ```
  ⚠️ **不要**再写 `after.filter(...).filter(blocker marker)` 的方案 — 那是过时设计,会和姊妹任务 `walkthrough-blocker-consistency` 试图解决的「双数据源不一致」问题同根。
- [ ] 3.2 `ReviewResult` 接口(`run.ts:134-137`)扩展两字段:
  ```typescript
  export interface ReviewResult {
    exitCode: 0 | 1 | 2;
    skillUsed: string;
    blockerCount: number;          // ← 新增
    unsupportedFileCount: number;  // ← 新增
  }
  ```
  所有 `runReview` 的 return 处都补这两个字段(共 4 处:L288 fail-open / L295 dryRun / L319 正常路径 / L323 catch-all),非正常路径填 `0` / `0`。
- [ ] 3.3 `packages/flower-code-reviewer/src/cli.ts` main 函数在 `process.exit(result.exitCode)` 之前加分段拼接:
  ```typescript
  if (result.exitCode === 1) {
    const parts: string[] = [];
    if (result.blockerCount > 0) parts.push(`${result.blockerCount} 个 blocker 评论`);
    if (result.unsupportedFileCount > 0) parts.push(`${result.unsupportedFileCount} 个无依据评论触发的 blocker`);
    console.log(
      `[code-reviewer] 评审完成:发现 ${parts.join(" + ")},` +
      `按设计 exit 1(下方 Runner "Job failed" 是预期信号,不是脚本崩溃)`,
    );
  }
  ```
- [ ] 3.4 **新建** `packages/flower-code-reviewer/src/__tests__/cli.test.ts`,4 case(AC3.1-AC3.4):
  - AC3.1:exitCode=1 + blockerCount=3 + unsupportedFileCount=0 → console.log spy 含 `3 个 blocker 评论` + `按设计 exit 1`,不含 `无依据评论触发`
  - AC3.2:exitCode=0 → console.log spy `not.toHaveBeenCalled()`
  - AC3.3:exitCode=1 + blockerCount=0 + unsupportedFileCount=2 → 含 `2 个无依据评论触发的 blocker`,**不含** `0 个 blocker 评论`(分段拼接生效)
  - AC3.4:exitCode=1 + blockerCount=2 + unsupportedFileCount=1 → 含 `2 个 blocker 评论 + 1 个无依据评论触发的 blocker`
- [ ] 3.5 `__tests__/run.test.ts` 现有 `runReview` 集成测试(若有)更新断言,涵盖新增的 `blockerCount` / `unsupportedFileCount` 字段(若无 runReview 集成测试可跳过)

**验证**:
```bash
cd packages/flower-code-reviewer && pnpm vitest run cli.test run.test
```

**Review gate**:exitCode=1 时**必有**预告日志且 N 准确反映两条路径;exitCode=0 时**没有**预告日志(无噪音);trace blocker 数与 `reviewer_list_my_blockers` 返回的 count 在同一次 reviewer run 内严格相等(由「同源真值」保证,无需额外断言)。

---

## Phase 4 · prompts.ts 集中更新

**目的**:Fix A 与 Fix B 的 prompt 改动合并到一处,避免 conflict。

**Checklist**:
- [ ] 4.1 `packages/flower-code-reviewer/src/prompts.ts` §「工作流」第 4 步替换为新版(design.md §1.5)
- [ ] 4.2 同文件 §「严格要求」段后追加「工具优先级」段(design.md §2.5)
- [ ] 4.3 `__tests__/prompts.test.ts` 加 2 case:
  - 断言 prompt 含 `不要传 "HEAD"` 字串(对应 AC1.6)
  - 断言 prompt 含 `工具优先级` 字串(对应 AC2.5)

**验证**:
```bash
cd packages/flower-code-reviewer && pnpm vitest run prompts.test
```

---

## Phase 5 · 整套质量门

**Checklist**:
- [ ] 5.1 `pnpm -r typecheck`
- [ ] 5.2 `pnpm -r lint`
- [ ] 5.3 `pnpm -r test`(预期单测数从 149 → ~170)
- [ ] 5.4 `git diff --stat` 确认改动只动 design.md §0.1 列出的文件 + `Dockerfile`

---

## Phase 6 · e2e 真跑 MR-2

**Checklist**:
- [ ] 6.1 flower 本仓 commit + push,等镜像 build pipeline 产出新 sha
- [ ] 6.2 pineapple `.gitlab-ci.yml` 加 `FLOWER_IMAGE_TAG: <new-sha>`(或滚 latest)
- [ ] 6.3 push 空 commit / retry pipeline 触发 reviewer
- [ ] 6.4 抓 trace,人工核验:
  - **不再出现** `ref="HEAD"` 的 HTTP 404 + `ref=""` 的 HTTP 400 + tool schema 拦截
  - 若 LLM 跑 `rg` / `nl` / `sort` / `awk` 等扩容后命令 → 放行(看 `🔧 [tool ←] bash` 是 result 不是 error;特别留意 `rg --version` 不报 `command not found`)
  - 若 LLM 跑 `env` / `curl` → **仍被拦**,且 reason 含替代建议
  - 若发现 blocker:trace 倒数第 2 行是 `[code-reviewer] 评审完成:发现 N 个 blocker 评论 [+ M 个无依据评论触发的 blocker],按设计 exit 1(...)`

**Review gate**:5 类错误信号在 trace 里**全部消失或被预告**,跑出来的 trace 比修前明显清爽。

---

## Phase 7 · commit + archive

**Checklist**:
- [ ] 7.1 一次性 `git add` 把改动 staged 起来(明确列文件,不用 `-A` 防止误带):
  - `packages/flower-tools-gitlab/src/{index.ts,__tests__/normalize-ref.test.ts}`
  - `packages/flower-compliance/src/{index.ts,__tests__/index.test.ts}`
  - `packages/flower-code-reviewer/src/{prompts.ts,cli.ts,run.ts,__tests__/cli.test.ts,__tests__/prompts.test.ts}`
  - `packages/flower-code-reviewer/Dockerfile`(+`ripgrep`)
  - `.trellis/tasks/05-21-reviewer-trace-noise-cleanup/{prd.md,design.md,implement.md}`(三件套 sync)
- [ ] 7.2 `git commit -m "[FIX] flower-code-reviewer · 修 reviewer trace 5 类错误信号(ref 弹性化 + bash 白名单扩容 + exit 1 双路径预告)"`(commit 信息风格对齐近 commit `[FIX]` / `[CI]` / `[CHORE]` 大类)
- [ ] 7.3 `git push -u origin fix/reviewer-trace-noise-cleanup`
- [ ] 7.4 `gh pr create --base main --title "..." --body "..."` 开 PR
- [ ] 7.5 PR 合并后,在 company 分支同步 + `task.py archive`
- [ ] 7.6 在 journal 记 1 行小结

---

## Rollback 点

| 阶段 | 失败如何回滚 |
|---|---|
| Phase 1 单测红 | 改 normalizeRef 直到绿;不动现有 client.ts 接口 |
| Phase 2 现有 whitelistCmds 测试破坏 | 检查新 regex 是否漏掉旧命令;补 regex |
| Phase 3 ReviewResult 接口扩展破坏现有调用 | `blockerCount?: number` 改成可选,默认 0 |
| Phase 6 e2e 发现 ref 兜底没生效 | 检查 `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` 是否真在 reviewer 容器 env 中(GitLab CI 默认注入,理论上有)|
| 上线后某 bash 命令意外放行造成事故 | 立刻在 regex 中删除该命令并重发 image |
