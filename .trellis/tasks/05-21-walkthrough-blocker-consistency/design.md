# Design · walkthrough blocker 列表与 line_comment 一致化

> 三件套之 design.md。承接 `prd.md` 的 R1-R8 / AC1-AC4。
> 实施 checklist 见 `implement.md`。

## 0. Overview

### 0.1 改动范围

```
packages/flower-tools-gitlab/src/
  client.ts          ← + editMrNote(projectId, mrIid, noteId, body)
                       + BotComment 加 position 信息(已有 file/line,需要再加是否整体评论的判定)
  __tests__/client.test.ts ← + editMrNote 单测
  index.ts           ← (不必导出 editMrNote 给 LLM,内部 GitlabClient 接口加就够)

packages/flower-code-reviewer/src/
  comments/
    walkthrough-rewrite.ts (NEW) ← 纯函数: 识别 alert 块 + 重写 body
    index.ts ← + export
  run.ts             ← 跑后阶段调 walkthrough-rewrite + editMrNote
  __tests__/walkthrough-rewrite.test.ts (NEW) ← 单测 6 case(AC1.*)
```

**完全不动**:`prompts.ts`、`extension.ts`、`observability.ts`、`skill-selector.ts`、`review-trace.ts`。

### 0.2 时序

```
LLM 跑(piMain)
  │ 发 line_comment × N(含 blocker)
  │ 发 walkthrough × 1
  ↓
piMain return
  │
  ├─ getBotComments(after)   ← 已有
  │
  ├─ findUnsupportedComments ← 已有(N1)
  │
  ├─ scanForBlockers         ← 已有,用 line_comment + marker 算 exitCode
  │
  ├─ NEW: rewriteWalkthroughBlockers(beforeIds, after, gitlabVersion)
  │   1. 从 after 过滤出本轮新增 + 位置为空 + walkthrough 特征 body 的整体评论
  │   2. 从 after 过滤出本轮新增 + 位置非空 + 带 blocker marker 的 line_comment
  │   3. 计算 actualBlockers = [{ path, line, title }]
  │   4. 调 rewriteAlertBlock(walkthrough.body, actualBlockers, alertSyntax)
  │   5. 若 newBody !== oldBody → editMrNote(walkthrough.id, newBody)
  ↓
return exitCode
```

### 0.3 核心设计选择

| 选择 | 决定 | 理由 |
|---|---|---|
| 改写时机 | `scanForBlockers` 之后,同步 best-effort | 已经拉了 after,复用;失败不影响主链路 |
| 改写位置 | `comments/walkthrough-rewrite.ts` 纯函数 + `client.editMrNote` 副作用 | 纯函数易测;副作用集中在 client 层 |
| walkthrough 识别 | body 含 `:robot:` + `代码评审报告` 关键字 + position 为 null + id 不在 beforeIds | 三重过滤减少 false positive(R6) |
| alert 块定位 | 行扫描:从匹配「`> [!caution]` 或 `> ⚠️ **Caution**`」的行开始,到第一个**非** blockquote 行为止,作为 alert 块的边界 | LLM 不一定严格按 few-shot 抄,要鲁棒一些 |
| blocker 标题抽取 | 正则去 `<!-- severity: blocker -->\n?`,再正则去前缀 `^[🔴🟠🔵] \*\*\S+\*\* ` | 兼容标题中有 punctuation / 中文 |

---

## 1. flower-tools-gitlab 改动

### 1.1 接口扩展(`client.ts`)

```typescript
// BotComment 接口扩展(添加 position 字段)
export interface BotComment {
  id: number;
  body: string;
  file: string | undefined;   // 已有,等价于 position?.new_path
  line: number | undefined;   // 已有,等价于 position?.new_line
}

// GitlabClient 接口新增方法
editMrNote(projectId: string, mrIid: number, noteId: number, body: string): Promise<void>;
```

实现走 `PUT /api/v4/projects/:id/merge_requests/:mr_iid/notes/:note_id`,JSON body `{ body: <new body> }`。错误分类(401 → AuthError、404 → 抛 Error、5xx → RetryableError、其他 4xx → Error)与 postMrComment 对齐。

**不暴露**到 LLM 工具层(`index.ts` 不 registerTool),仅 GitlabClient 接口可用。

### 1.2 测试覆盖(`__tests__/client.test.ts`)

- `editMrNote` happy path:fetch mock 验证 method/path/body 正确
- 401 → `AuthError`
- 5xx → `RetryableError`
- 404 → 普通 Error

---

## 2. flower-code-reviewer 改动

### 2.1 纯函数 `rewriteWalkthroughBlockers(input)`(`comments/walkthrough-rewrite.ts`)

#### 签名

```typescript
export interface WalkthroughRewriteInput {
  /** 跑前 snapshot 的评论 id 集合(用于过滤本轮新增) */
  beforeIds: Set<number>;
  /** 跑后拉到的全部 bot 评论 */
  after: BotComment[];
  /** GitLab 版本(决定 alert 块语法) */
  gitlabVersion: GitlabVersion | null;
}

export interface BlockerEntry {
  /** 文件路径 */
  path: string;
  /** 行号 */
  line: number;
  /** blocker 评论标题(line_comment body 第一行去 emoji + 加粗等级 后剩余文本) */
  title: string;
}

export interface WalkthroughRewriteOutput {
  /** 需要改写的 walkthrough note id;无需改写时为 undefined */
  noteId: number | undefined;
  /** 改写后的完整 body;noteId 为 undefined 时也为 undefined */
  newBody: string | undefined;
  /** 实际识别到的 blocker 列表(便于 caller 打日志) */
  blockers: BlockerEntry[];
}

export function rewriteWalkthroughBlockers(
  input: WalkthroughRewriteInput,
): WalkthroughRewriteOutput;
```

#### 实现细节

1. **过滤本轮新增**:`after.filter(c => !beforeIds.has(c.id))`
2. **找 walkthrough**:`new.filter(c => c.file === undefined && c.line === undefined && c.body.includes(":robot:") && c.body.includes("代码评审报告"))`
   - 若 0 个 → 返回 `{ noteId: undefined, newBody: undefined, blockers: [] }`(R3)
   - 若 ≥ 2 个 → 取**最后 1 条**(按数组顺序最后,因为 `getBotComments` 内部 `sort=asc`,最新的在末尾)
3. **找新增 blocker line_comments**:`new.filter(c => c.file !== undefined && c.line !== undefined && /<!--\s*severity:\s*blocker\s*-->/.test(c.body))`
4. **抽 title**(每条 line_comment):
   - 去掉 HTML marker:`body.replace(/^<!--\s*severity:\s*blocker\s*-->\s*\n?/, "")`
   - 取第 1 行:`stripped.split("\n", 1)[0]`
   - 去掉 severity prefix:`firstLine.replace(/^[🔴🟠🔵]\s*\*\*\S+\*\*\s*/, "")`
   - 若空则 fallback 为 `"(无标题)"`
5. **改写 alert 块**:
   - 用 `supportsAlertBlock(gitlabVersion)` 决定 alertSyntax 前缀(`> [!caution]` 或 `> ⚠️ **Caution**`)
   - 在 walkthrough.body 中定位 alert 块(连续 blockquote 行,起始为 alertSyntax 关键字)
   - 若找到 → 用新 alert 块替换该段
   - 若没找到 alert 块 + blockers.length > 0 → **跳过改写**(prompts.ts few-shot 显示 alert 块只在有 blocker 时插入;若 LLM 没插但有 blocker,本任务 OoS,留给后续修)
   - 若 blockers.length === 0 + 找到 alert 块 → **删除整个 alert 块**(R4)
6. **构造新 alert 块**:

```
> [!caution]
> 本次评审发现 **<N> 个 blocker 级问题**,CI 将以非零退出码 fail。修复后请重新 push 触发自动重审。
>
> Blocker 列表:
> - `<path>:<line>` — <title>
> - ...
```

7. **若 newBody === oldBody** → 返回 `{ noteId: undefined, newBody: undefined, blockers }`(避免无意义的 PUT)
8. 否则返回 `{ noteId: walkthrough.id, newBody, blockers }`

#### alert 块定位算法(伪码)

```
lines = body.split("\n")
startIdx = lines.findIndex(line =>
  line.startsWith("> [!caution]") ||
  /^>\s*⚠️\s*\*\*Caution\*\*/.test(line)
)
if startIdx === -1: return null
endIdx = startIdx
while endIdx + 1 < lines.length and lines[endIdx + 1].startsWith(">"):
  endIdx++
// alert 块 = lines[startIdx..=endIdx];前后边界行也保留(空行 / 正文)
```

### 2.2 `run.ts` 接入点

在 `scanForBlockers` 之后(第 314-318 行之后),新增:

```typescript
try {
  const rewrite = rewriteWalkthroughBlockers({
    beforeIds,
    after,
    gitlabVersion,
  });
  if (rewrite.noteId !== undefined && rewrite.newBody !== undefined) {
    await gitlabClient().editMrNote(projectId, mrIid, rewrite.noteId, rewrite.newBody);
    console.log(`[code-reviewer] walkthrough 一致化:${rewrite.blockers.length} 个 blocker`);
  }
} catch (err) {
  console.warn("[code-reviewer] walkthrough 一致化改写失败,跳过:", err);
}
```

注意:`gitlabVersion` 在 `runReview` 入口已经探测了一次,可以直接复用。

### 2.3 单测(`__tests__/walkthrough-rewrite.test.ts`)

按 AC1.1-AC1.6 共 6 个 case:

| Case | beforeIds | after | gitlabVersion | 期望输出 |
|---|---|---|---|---|
| 1.1 | { 100 } | 4 blocker line + walkthrough 写 3 blocker | { major: 17, minor: 10 } | noteId=walkthrough.id, newBody alert 块 N=4 列表 4 条,其他段不变 |
| 1.2 | {} | 1 blocker + walkthrough | { major: 18 } | alert 用 `> [!caution]` 改写 |
| 1.3 | {} | 1 blocker + walkthrough(`> ⚠️ Caution` 语法) | { major: 17, minor: 8 } | alert 用 `> ⚠️ **Caution**` 改写 |
| 1.4 | {} | 0 blocker + walkthrough 含 alert 块写「2 blocker」 | { major: 17, minor: 10 } | newBody 移除整个 alert 块,正文保留 |
| 1.5 | {} | 2 blocker line,无 walkthrough | _ | noteId=undefined |
| 1.6 | _ | line_comment body `🔴 **阻塞** 硬编码生产 API Key 会泄漏凭据\n\n详细...` | _ | blockers[0].title === "硬编码生产 API Key 会泄漏凭据" |

---

## 3. 兼容性与回滚

### 3.1 兼容性

- 现有 149 单测全过(本任务只 + 单测,不动现有逻辑契约)
- LLM prompt / 工作流不变,LLM 仍然自由写 walkthrough,只是顶部 alert 块在 post-process 阶段被静默校正
- 部署只需 reviewer 容器升级,业务方 `.gitlab-ci.yml` 不动

### 3.2 回滚

- **代码级回滚**:revert 一个 commit 即可,无 DB / 配置 migration
- **运行时降级**:`run.ts` 中 try-catch 包裹整个 post-process,失败 warn 不抛错,**已有的 walkthrough 不会被破坏**(GitLab API 失败 = 原 body 保留)
- **特性开关(可选)**:加 env `FLOWER_WALKTHROUGH_REWRITE=0` 关掉 post-process,出问题快速回滚。**本任务暂不实现**,理由:逻辑足够本地 + 失败兜底已经够,无需 runtime kill switch

---

## 4. 跨包边界

| 跨包改动 | 是否需要 |
|---|---|
| `flower-providers` | ❌ 不动 |
| `flower-compliance` | ❌ 不动 |
| `flower-tools-common` | ❌ 不动 |
| `flower-tools-gitlab` | ✅ 加 `editMrNote` |
| `flower-code-reviewer` | ✅ 加 `walkthrough-rewrite` + `run.ts` 接入 |
| 业务方 / harness 模板 | ❌ 不动 |
| Docker / CI | ❌ 不动 |
| spec | ✅ 沉淀到 `.trellis/spec/flower-code-reviewer/backend/index.md`(post-process 模式) |
