# Design · walkthrough blocker 一致化(agent 自审方案)

> 三件套之 design.md。承接 `prd.md` 的 R1-R7 / AC1-AC6。
> 实施 checklist 见 `implement.md`。

## 0. Overview

### 0.1 改动范围

```
packages/flower-code-reviewer/src/
  review-trace.ts          ← 扩展 PostedLineComment + recordLineComment 签名 + title 抽取纯函数
  extension.ts             ← tool_call 监听补提取 severity + body;新增 reviewer_list_my_blockers 工具注册
  prompts.ts               ← 工作流加 step「调 reviewer_list_my_blockers」+ 正反例 few-shot
  __tests__/
    review-trace.test.ts   ← AC2.* + title 抽取 case
    extension.test.ts (NEW)← AC3.* (mock pi event)
    prompts.test.ts        ← AC4.*

packages/flower-tools-gitlab/ ← 完全不动(v1 设计中的 editMrNote 弃用)
packages/flower-compliance/   ← 完全不动
```

**新增文件**:1 个(`__tests__/extension.test.ts`)
**修改文件**:4 个(`review-trace.ts` / `extension.ts` / `prompts.ts` + 各自 __tests__)

### 0.2 时序

```
LLM 跑(piMain)
  │
  │ for each blocker / major / minor:
  │   1. gitlab_get_file_content  ← extension.ts tool_call hook: recordFileRead
  │   2. gitlab_post_line_comment ← extension.ts tool_call hook: recordLineComment({file, line, severity, body})
  │
  │ (LLM 内部决定:发完 line_comment 了)
  │
  │ 3. reviewer_list_my_blockers  ← 新工具!execute 内部读 trace.lineComments 过滤 blocker
  │    返回 { count, blockers: [{path, line, title}] }
  │
  │ 4. LLM 拿到真值 → 写 walkthrough 顶部 alert 块
  │    (alert 块的 N + 列表 = 工具返回值逐条照抄)
  │
  │ 5. gitlab_post_comment(walkthrough body)
  ↓
piMain return
  │
  ├─ getBotComments(after)
  ├─ findUnsupportedComments  ← 已有(N1,不动)
  ├─ scanForBlockers          ← 已有(基于 line_comment marker,不动)
  ↓
return exitCode
```

**关键**:walkthrough body 一旦发出去就**不再被代码动**(对比 v1 post-process 方案在 piMain 返回后 PUT note)。一致性的保证完全靠 LLM 在 step 3-4 之间正确传递工具返回值。

### 0.3 v1 post-process 方案弃用记录(历史决策)

**v1 方案(已弃用,2026-05-21 brainstorm 阶段决策)**:在 `run.ts` `scanForBlockers` 之后加 try-catch,调纯函数 `rewriteWalkthroughBlockers` 识别 walkthrough body 的 alert 块 + 用 line_comment 真值重写,通过 `client.editMrNote` PUT 改 GitLab note。

**为什么弃用**:
- 哲学方向:把 LLM 当成不可靠零件然后用代码兜底,违反"agent 独立完成"的产品方向。
- 工程代价:walkthrough body 识别 + alert 块行扫描定位需要鲁棒处理 LLM 不严格抄 few-shot 的多种 edge case;改写后还要再 PUT API 一次,失败处理也是负担。
- 路径依赖:加了 post-process 后,后续 LLM 概括出错的同类问题(漏 major / 列了不存在的文件等)都会被沿用为"再加一个 post-process",拼出一个越来越大的"代码强改 LLM 输出"层,与 agent 路线相反。

**v2 方案(本次采用)**:给 LLM 一个`reviewer_list_my_blockers`自审工具拿真值,prompt 强约束让它照抄。

**触发回归 v1 的条件**(明确写下来,避免后续误判):
- e2e 实测加强 prompt 后 LLM **仍然** ≥30% 概率不调工具或不照抄,且**已经**穷尽了 prompt 工程方案(包括 hard inject system message)。
- 当前**不**采取 v1,即使未来真触发回归,也应该是有充分实测数据后的明确决策。

### 0.4 核心设计选择

| 选择 | 决定 | 理由 |
|---|---|---|
| 数据源 | `review-trace.ts` 本地单例(不发 GitLab API) | 1. 无 roundtrip,工具快;2. 严格"本轮"语义(API 拉到的会含历史轮);3. 复用现有单例基础设施 |
| 工具命名空间 | `reviewer_*`(新命名空间) | `gitlab_*` 暗示真的发 GitLab API,本工具不发;`reviewer_*` 体现"评审专用元工具",未来可加 `reviewer_get_trace` 等 |
| 工具注册位置 | `flower-code-reviewer/src/extension.ts`(与 review-trace 监听并列) | 工具依赖 review-trace 单例(已在 flower-code-reviewer);跨包注册会形成反向依赖 |
| `recordLineComment` 签名 | 直接换为对象 `({file, line, severity, body})`,**不**保留旧位置参数重载 | extension.ts 是唯一 caller;同步改完即可;保留重载是 YAGNI |
| title 抽取 | 纯函数 `extractBlockerTitle(body): string`,在 review-trace.ts 内 | 在 `recordLineComment` 时一次性抽好存进 trace,工具 execute 直接读;避免每次工具调用重复抽取 |

---

## 1. `review-trace.ts` 改动

### 1.1 接口扩展

```typescript
// 当前
export interface PostedLineComment {
  file: string;
  line: number;
}

// 改为
export interface PostedLineComment {
  file: string;
  line: number;
  severity: "blocker" | "major" | "minor";   // ← 新增
  title: string;                              // ← 新增
}

// recordLineComment 签名
// 当前:recordLineComment(file: string, line: number): void
// 改为:
export function recordLineComment(input: {
  file: string;
  line: number;
  severity: "blocker" | "major" | "minor";
  body: string;
}): void {
  trace.lineComments.push({
    file: input.file,
    line: input.line,
    severity: input.severity,
    title: extractBlockerTitle(input.body),  // ← 抽取一次,存进 trace
  });
}
```

### 1.2 新增纯函数 `extractBlockerTitle`

```typescript
/**
 * 从行内评论 body 抽取标题(第一行去 emoji + 加粗等级前缀)
 *
 * 兼容 spec `flower-code-reviewer/frontend/index.md` §1 的中文等级格式:
 * - `🔴 **阻塞** · 硬编码 secret` → "硬编码 secret"
 * - `🟠 **重要** 性能问题` → "性能问题"(等级与标题间无 `·`,容忍空格)
 * - `🔵 **建议** · 命名优化\n详细...` → "命名优化"
 * - HTML 注释 marker 已被 client 注入到 body 首行,需先剥离
 *
 * @internal 仅供 review-trace.ts 与单测用
 */
export function extractBlockerTitle(body: string): string {
  // 1. 剥离 HTML 注释 marker(`<!-- severity: blocker -->\n`)
  const stripped = body.replace(/^<!--\s*severity:\s*\S+\s*-->\s*\n?/, "");
  // 2. 取第一行
  const firstLine = stripped.split("\n", 1)[0] ?? "";
  // 3. 去 emoji + 加粗等级前缀(兼容 · / • / 空格分隔)
  const title = firstLine
    .replace(/^[🔴🟠🔵]\s*\*\*\S+\*\*\s*[·•]?\s*/, "")
    .trim();
  return title || "(无标题)";
}
```

### 1.3 单测覆盖

- AC2.1 + AC2.2:`recordLineComment` 对象签名 + 完整字段记录
- 新增 `extractBlockerTitle` 单测:
  - `🔴 **阻塞** · 硬编码 secret\n详情...` → `"硬编码 secret"`
  - `🟠 **重要**  性能问题` → `"性能问题"`(空格分隔)
  - `<!-- severity: blocker -->\n🔴 **阻塞** · X` → `"X"`(剥离 marker)
  - `` → `"(无标题)"`

---

## 2. `extension.ts` 改动

### 2.1 tool_call 监听补提取

```typescript
function registerReviewTrace(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "gitlab_get_file_content") {
      const path = event.input.path;
      if (typeof path === "string") {
        recordFileRead(path);
      }
      return undefined;
    }
    if (event.toolName === "gitlab_post_line_comment") {
      const file = event.input.file;
      const line = event.input.line;
      const severity = event.input.severity;
      const body = event.input.body;
      // 类型守卫:四个字段都得对,否则不记录(防御 LLM 异常输入)
      if (
        typeof file === "string" &&
        typeof line === "number" &&
        (severity === "blocker" || severity === "major" || severity === "minor") &&
        typeof body === "string"
      ) {
        recordLineComment({ file, line, severity, body });
      }
      return undefined;
    }
    return undefined;
  });
}
```

### 2.2 注册新工具 `reviewer_list_my_blockers`

新增函数 `registerReviewerSelfTools`(在 `default export` 的注册序列中调用一次):

```typescript
function registerReviewerSelfTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "reviewer_list_my_blockers",
    label: "列出本轮已发的 blocker 评论",
    description: [
      "返回本轮你已通过 `gitlab_post_line_comment` 发出的 **blocker 级**行内评论列表。",
      "数据从评审本地 trace 内存中读,**不发 GitLab API 请求**。",
      "用法:在写 walkthrough 整体评论之前调用,拿到本轮 blocker 真值,",
      "然后在 walkthrough 顶部 alert 块**逐条照抄** `path:line — title`,",
      "避免靠对话记忆概括出错。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => {
      const trace = getTrace();
      const blockers = trace.lineComments
        .filter((c) => c.severity === "blocker")
        .map((c) => ({ path: c.file, line: c.line, title: c.title }));
      return { count: blockers.length, blockers };
    },
  });
}
```

### 2.3 default export 注册序列

```typescript
export default function (pi: ExtensionAPI): void {
  registerHavefunProviders(pi, { appSource: "code-reviewer" });
  registerCompliance(pi, { mode: "ci-readonly", product: "code-reviewer" });
  registerCommonTools(pi);
  registerGitlabTools(pi);
  registerReviewTrace(pi);
  registerReviewerSelfTools(pi);      // ← 新增,放在 tools 之后,observability 之前
  registerObservability(pi);
}
```

### 2.4 单测覆盖(`__tests__/extension.test.ts`)

- AC3.1:mock pi event `{toolName:"gitlab_post_line_comment", input:{file,line,severity,body}}` → trace 含完整对象
- AC3.2:mock event 缺 severity → 不记录
- `reviewer_list_my_blockers` execute 直接调用 → 返回 count + blockers(覆盖 AC1.1-1.3,可以与 review-trace 单测共享 fixture)

---

## 3. `prompts.ts` 改动

### 3.1 工作流加 step

定位:`prompts.ts` 中现有「步骤 7 · 发整体评论 walkthrough」**之前**(假设当前步骤 6 是发 line_comment;插入新 step 6.5 或重新编号为 7,后续顺延)。

新 step 内容:

```markdown
### 步骤 X · 校对本轮 blocker 真值(强制,在写 walkthrough 之前)

发完所有 line_comment 后,**必须**调用一次 `reviewer_list_my_blockers` 工具。

工具会返回:
```json
{
  "count": <number>,
  "blockers": [
    {"path": "<file>", "line": <number>, "title": "<去掉等级前缀的标题>"}
  ]
}
```

写 walkthrough 顶部的 `> [!caution]`(或降级的 `> ⚠️ **Caution**`)alert 块时:

- alert 块中的 **N 数字** = `count`,不允许靠对话历史记忆数
- **Blocker 列表** = `blockers` 数组中每一条,**逐条照抄**为 `- \`<path>:<line>\` — <title>`,不允许摘要、不允许漏、不允许增、不允许调整顺序
- 如果 `count === 0`,**不要插入 alert 块**(沿用现有"无 blocker 不插 caution"约定)

**严禁**:
- 不调工具直接靠对话历史概括 → 历史已实测会数错(stress test 4 实际 vs 3 自述)
- 修改工具返回的 path / line / title 字面值 → 哪怕你觉得 title 文案可以更好,也不要改;一致性比文案优先
```

### 3.2 正例 few-shot

```markdown
### 示例 X · 调 reviewer_list_my_blockers 后写 walkthrough 顶部 alert 块

(假设你刚通过 gitlab_post_line_comment 发了 4 条 blocker)

调用 `reviewer_list_my_blockers` 拿到:
{
  "count": 4,
  "blockers": [
    {"path": "src/api/auth.ts", "line": 12, "title": "硬编码生产 API Key 会泄漏凭据"},
    {"path": "src/utils/exportHelper.ts", "line": 18, "title": "token 通过 URL query 暴露给第三方"},
    {"path": "src/db/seed.ts", "line": 45, "title": "明文密码 seed 导致历史数据可解"},
    {"path": "src/api/auth.ts", "line": 67, "title": "JWT 永不过期"}
  ]
}

然后 walkthrough 顶部应该写:

> [!caution]
> 本次评审发现 **4 个 blocker 级问题**,CI 将以非零退出码 fail。修复后请重新 push 触发自动重审。
>
> Blocker 列表:
> - `src/api/auth.ts:12` — 硬编码生产 API Key 会泄漏凭据
> - `src/utils/exportHelper.ts:18` — token 通过 URL query 暴露给第三方
> - `src/db/seed.ts:45` — 明文密码 seed 导致历史数据可解
> - `src/api/auth.ts:67` — JWT 永不过期
```

### 3.3 反例 few-shot(本次 stress test 4 vs 3 案例)

```markdown
### 反例 · 不调工具靠记忆概括 → 漏列

❌ 错误做法(2026-05-21 stress test 实测发生过):
LLM 实际发了 4 条 blocker line_comment,但写 walkthrough 时:
> [!caution]
> 本次评审发现 **3 个 blocker 级问题**,CI 将以非零退出码 fail。
>
> Blocker 列表:
> - `src/api/auth.ts:12` — 硬编码 API Key
> - `src/db/seed.ts:45` — 明文密码
> - `src/api/auth.ts:67` — JWT 永不过期

漏列了 `src/utils/exportHelper.ts:18`(token 进 URL query)。原因:LLM 在长对话上下文里靠记忆数,会丢条。

✅ 正确做法见示例 X:先调 `reviewer_list_my_blockers` 拿真值,再逐条照抄。
```

### 3.4 单测

- AC4.1:`prompt.includes("reviewer_list_my_blockers")`
- AC4.2:`prompt.includes("必须调")` + `prompt.includes("逐条照抄")`
- AC4.3:`prompt.includes("反例")` 或者断言反例段中含特定字串(如 `"stress test"` / `"漏列"`)

---

## 4. 兼容性与回滚

### 4.1 兼容性

- `PostedLineComment` 加字段 → **扩展**,不破坏 `findUnsupportedComments` 等读 `file` 的现有逻辑
- `recordLineComment` 签名变化 → extension.ts 是唯一 caller,**同步改完即可**;**不**保留旧签名
- 新增 `reviewer_list_my_blockers` 工具 → LLM 可选调用,不调也不报错(prompt 强约束让它调,但 tool 本身是 best-effort)
- `scanForBlockers` 完全不变 → CI exitCode 决策不依赖本任务

### 4.2 回滚

- 代码级:revert 一个 commit(或拆 2 commit:① review-trace + extension 工具基础设施 ② prompts.ts 工作流改造),整任务可回到 v1 之前状态
- 工具回滚:即使新工具上线后发现 LLM 调用方式有问题,**LLM 不调也不报错** → 没有强制 break;最坏情况就是回到本任务之前的状态(walkthrough 数字可能不准,CI 仍然 fail close)
- 无 DB / migration / 业务方配置改动

---

## 5. 跨包边界

| 跨包改动 | 是否需要 |
|---|---|
| `flower-providers` | ❌ 不动 |
| `flower-compliance` | ❌ 不动 |
| `flower-tools-common` | ❌ 不动 |
| `flower-tools-gitlab` | ❌ 不动(v1 设计中的 `editMrNote` 弃用) |
| `flower-code-reviewer` | ✅ review-trace + extension + prompts |
| 业务方 / harness 模板 | ❌ 不动 |
| Docker / CI | ❌ 不动(reviewer image 升级即可) |
| spec | ✅ 沉淀「`reviewer_*` 命名空间约定 + agent 自审工具模式」到 `.trellis/spec/flower-code-reviewer/frontend/index.md` 关键设计点段 |

---

## 6. spec 沉淀点(implement.md Phase 6 落地)

- **命名空间**:`reviewer_*` 工具前缀的语义 — 评审专用元工具,只读评审 trace,**不发外部 API 请求**;后续可加 `reviewer_get_trace` / `reviewer_list_my_reads` 等
- **agent 自审模式**:对 LLM 易出错的"自我概括类"任务,**给确定性工具拿真值 + prompt 强约束照抄**,而非代码 post-process 强改;明确写下 v1 弃用记录避免后续误回潮
