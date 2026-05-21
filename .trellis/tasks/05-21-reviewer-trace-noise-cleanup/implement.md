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

## Phase 2 · Fix B · bash 白名单扩容

**目的**:落地 design.md §2.2-§2.6。

**Checklist**:
- [ ] 2.1 `packages/flower-compliance/src/index.ts:52` 更新 `bashAllowList` regex:
  ```typescript
  const bashAllowList = /^(git|grep|find|ls|cat|head|tail|nl|wc|file|sed|awk|sort|uniq|tr|column|diff|comm|printf|echo|basename|dirname|realpath|pwd|date|which|type|command|jq|yq)\b/;
  ```
- [ ] 2.2 同文件加 `SUGGESTION_BY_CMD` 常量 + `buildBashBlockMessage` 函数(design.md §2.4),把 `reason` 字符串生成从内联改为调用 helper
- [ ] 2.3 `packages/flower-compliance/src/__tests__/index.test.ts` 加 5 个新 case(AC2.1-AC2.5):
  - it.each(16 新增命令):放行
  - it("env 仍拦"):断言 `block: true` + reason 含 `可能泄漏 secret`
  - it("printenv 仍拦"):同上
  - it("curl 仍拦"):断言 reason 含 `禁止网络外发`
  - it("npm 仍拦"):断言 block
- [ ] 2.4 现有 `whitelistCmds` 测试 case 加新增的 16 个命令(保持现有 `git status` / `grep` 等放行覆盖)

**验证**:
```bash
cd packages/flower-compliance && pnpm vitest run index.test
```

**Review gate**:新加的 16 个命令全过;`env` / `curl` / `tee` 等高危仍拦截;reason 文案符合 AC2.4。

---

## Phase 3 · Fix C · exit 1 预告日志

**目的**:落地 design.md §3。

**Checklist**:
- [ ] 3.1 `packages/flower-code-reviewer/src/run.ts` 在 `scanForBlockers` 调用处增加 blocker 计数变量(可重用 `after.filter(...)` 的结果):

  ```typescript
  // 用纯函数 countBlockers 替代 scanForBlockers 调用,或在 scanForBlockers 内同时返回 count
  // 简单方案:scanForBlockers 后再 filter 一次拿 count
  const newBlockerLineComments = after
    .filter((c) => !beforeIds.has(c.id))
    .filter((c) => c.file !== undefined && c.line !== undefined)
    .filter((c) => /<!--\s*severity:\s*blocker\s*-->/.test(c.body));
  const blockerCount = newBlockerLineComments.length;
  ```
- [ ] 3.2 `ReviewResult` 接口加 `blockerCount: number` 字段;`runReview` return 处填上
- [ ] 3.3 `packages/flower-code-reviewer/src/cli.ts` main 函数在 `process.exit(result.exitCode)` 之前加判断:
  ```typescript
  if (result.exitCode === 1) {
    console.log(
      `[code-reviewer] 评审完成:发现 ${result.blockerCount} 个 blocker,` +
      `按设计 exit 1(下方 Runner "Job failed" 是预期信号,不是脚本崩溃)`,
    );
  }
  ```
- [ ] 3.4 `__tests__/cli.test.ts`(若无则新建) + `__tests__/run.test.ts` 加 3 case(AC3.1-AC3.3):
  - exitCode=1 + blockerCount=3 → console.log spy 收到含 "3 个 blocker" 字串
  - exitCode=0 → console.log spy **未**被调用(`expect(spy).not.toHaveBeenCalled()`)
  - exitCode=1 + blockerCount=0 不应该发生,但若出现 → 不打印(避免误导)

**验证**:
```bash
cd packages/flower-code-reviewer && pnpm vitest run cli.test run.test
```

**Review gate**:exitCode=1 时**必有**预告日志且 N 正确;exitCode=0 时**没有**预告日志(无噪音)。

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
- [ ] 5.4 `git diff --stat` 确认改动只动 design.md §0.1 列出的文件

---

## Phase 6 · e2e 真跑 MR-2

**Checklist**:
- [ ] 6.1 flower 本仓 commit + push,等镜像 build pipeline 产出新 sha
- [ ] 6.2 pineapple `.gitlab-ci.yml` 加 `FLOWER_IMAGE_TAG: <new-sha>`(或滚 latest)
- [ ] 6.3 push 空 commit / retry pipeline 触发 reviewer
- [ ] 6.4 抓 trace,人工核验:
  - **不再出现** `ref="HEAD"` 的 HTTP 404 + `ref=""` 的 HTTP 400 + tool schema 拦截
  - 若 LLM 跑 `nl` / `sort` / `jq` 等扩容后命令 → 放行(看 `🔧 [tool ←] bash` 是 result 不是 error)
  - 若 LLM 跑 `env` / `curl` → **仍被拦**,且 reason 含替代建议
  - 若发现 blocker:trace 倒数第 2 行是 `[code-reviewer] 评审完成:发现 N 个 blocker,...`

**Review gate**:5 类错误信号在 trace 里**全部消失或被预告**,跑出来的 trace 比修前明显清爽。

---

## Phase 7 · commit + archive

**Checklist**:
- [ ] 7.1 一次性 `git add -A` 把 4 包改动 staged 起来:
  - `packages/flower-tools-gitlab/src/{index.ts,__tests__/}`
  - `packages/flower-compliance/src/{index.ts,__tests__/}`
  - `packages/flower-code-reviewer/src/{prompts.ts,cli.ts,run.ts,__tests__/}`
  - 任务三件套已经在 trellis 自动跟踪
- [ ] 7.2 `git commit -m "fix(flower-code-reviewer): 修 reviewer trace 5 类错误信号(ref 弹性化 + bash 白名单扩容 + exit 1 预告)"`
- [ ] 7.3 `task.py archive`
- [ ] 7.4 在 journal 记 1 行小结

---

## Rollback 点

| 阶段 | 失败如何回滚 |
|---|---|
| Phase 1 单测红 | 改 normalizeRef 直到绿;不动现有 client.ts 接口 |
| Phase 2 现有 whitelistCmds 测试破坏 | 检查新 regex 是否漏掉旧命令;补 regex |
| Phase 3 ReviewResult 接口扩展破坏现有调用 | `blockerCount?: number` 改成可选,默认 0 |
| Phase 6 e2e 发现 ref 兜底没生效 | 检查 `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` 是否真在 reviewer 容器 env 中(GitLab CI 默认注入,理论上有)|
| 上线后某 bash 命令意外放行造成事故 | 立刻在 regex 中删除该命令并重发 image |
