# Design · 修 5 类 reviewer trace 错误信号

> 三件套之 design.md。承接 `prd.md` 的 R1-R4 / AC1-AC5。

## 0. Overview

### 0.1 改动范围

```
packages/flower-tools-gitlab/src/
  index.ts                   ← gitlab_get_file_content tool schema + 实装 normalizeRef
  client.ts                  ← (可选)getFileContent 客户端再做一道 ref 校验(防御)
  __tests__/tool-sanitize.test.ts ← + 6 case(AC1.*)
  __tests__/client.test.ts        ← (若 client.ts 也动)+ 兼容 case

packages/flower-code-reviewer/src/
  prompts.ts                 ← §「工作流」第 4 步 + 加「工具优先级」段
  cli.ts (或 run.ts)         ← exit 1 前打预告日志
  __tests__/cli.test.ts (或 run.test.ts) ← + 2 case(AC3.*)
  __tests__/prompts.test.ts  ← + 2 case(AC1.6 / AC2.4 字符串断言)

packages/flower-compliance/src/
  <bash-tool 拦截相关>.ts    ← 错误信息加替代建议
  __tests__/<对应>.test.ts   ← + 3 case(AC2.*)
```

完全不动:`flower-providers`、`flower-tools-common`、`observability.ts`、`extension.ts`。

### 0.2 跨包改动顺序

```
Fix A (flower-tools-gitlab) → 自洽,先做
  └→ Fix A 同步 prompts.ts(flower-code-reviewer)
Fix B (flower-compliance + flower-code-reviewer prompts.ts)
  └→ 与 Fix A 的 prompts.ts 改动合并提交 1 个 PR
Fix C (flower-code-reviewer cli.ts / run.ts)
```

合在 1 个 PR 也行(本任务规模小,2h 内);拆 3 个 PR 也行(各自独立)。**推荐 1 个 PR**,题目同源,review 一次完。

---

## 1. Fix A · `ref` 处理弹性化

### 1.1 接口契约变化

`gitlab_get_file_content` tool 的 JSON schema:

```diff
{
  "name": "gitlab_get_file_content",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "..." },
      "ref":  { "type": "string", "description": "..." }
    },
-   "required": ["path", "ref"]
+   "required": ["path"]
  }
}
```

description 字段也更新:

```
ref(可选):分支名 / tag / commit sha。
  - 省略或传空 → 自动兜底到当前 MR 的 source branch(评审 source 版本最常用)
  - 看历史版本 / target 分支:显式传对应 ref
  - **不要传 "HEAD"**:GitLab API 不识别该别名,会被解析成 default branch
```

### 1.2 `normalizeRef` 实装(在 `flower-tools-gitlab/src/index.ts` 的 gitlab_get_file_content tool 内)

```typescript
function normalizeRef(rawRef: string | undefined): string {
  const trimmed = rawRef?.trim();

  // 缺省 / 空字符串 / "HEAD" → 兜底
  if (!trimmed || trimmed === "HEAD") {
    const sourceBranch = process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
    if (sourceBranch && sourceBranch.trim() !== "") {
      console.warn(
        `[gitlab_get_file_content] ref="${rawRef ?? "(missing)"}" 自动兜底到 source branch "${sourceBranch}"`,
      );
      return sourceBranch;
    }
    // 没有 CI env(本地调试)→ 抛明确错误
    throw new Error(
      `ref 缺失或为 "HEAD" / 空字符串,且环境变量 CI_MERGE_REQUEST_SOURCE_BRANCH_NAME 未设置无法兜底。` +
      `请显式传 ref(branch 名 / tag 名 / commit sha)。`,
    );
  }
  return trimmed;
}
```

### 1.3 调用点接入

在 tool handler 内:

```typescript
async function gitlabGetFileContentHandler(input: { path: string; ref?: string }) {
  const ref = normalizeRef(input.ref);  // ← 新增
  return await gitlabClient().getFileContent(projectId, input.path, ref);
}
```

`client.ts:getFileContent` 不动(底层接口仍要求 string,因为 normalize 已经在 tool 层完成)。

### 1.4 单测覆盖(`__tests__/tool-sanitize.test.ts` 或新增 `__tests__/normalize-ref.test.ts`)

```typescript
describe("normalizeRef", () => {
  beforeEach(() => {
    process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = "try/code-review-onboarding";
  });
  it("AC1.1 ref='HEAD' → source branch", () => { ... });
  it("AC1.2 ref='' → source branch", () => { ... });
  it("AC1.3 ref undefined → source branch", () => { ... });
  it("AC1.4 ref='prod' → 'prod'(透传)", () => { ... });
  it("AC1.5 ref='HEAD' + CI env 不存在 → 抛中文错误", () => {
    delete process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
    expect(() => normalizeRef("HEAD")).toThrow(/ref 缺失/);
  });
});
```

### 1.5 prompts.ts 同步

`prompts.ts` §「工作流」第 4 步:

```diff
- 4. **每个变更文件**:必须调用 `gitlab_get_file_content` 拉完整内容(ref 传 MR source branch HEAD;
-    想看 target 版本或历史 commit 可传对应 ref)。
+ 4. **每个变更文件**:必须调用 `gitlab_get_file_content` 拉完整内容。
+    - **看 MR source 版本**:`ref` 参数可省略,工具会自动兜底到当前 MR 的 source branch
+    - **看 target 版本 / 历史 commit**:显式传 branch 名 / commit sha
+    - **不要传 `"HEAD"`**:GitLab REST API 不识别该别名
```

---

## 2. Fix B · bash 白名单扩容 + 错误信息优化

### 2.1 当前白名单(已 grep 确认)

`flower-compliance/src/index.ts:52`:
```typescript
const bashAllowList = /^(git|grep|find|ls|cat|head|tail|wc|file|sed|awk)\b/;
```

只覆盖 10 个命令,大量纯只读工具被拦。

### 2.2 扩容后白名单(26 个)

```typescript
const bashAllowList = /^(git|grep|find|ls|cat|head|tail|nl|wc|file|sed|awk|sort|uniq|tr|column|diff|comm|printf|echo|basename|dirname|realpath|pwd|date|which|type|command|jq|yq)\b/;
```

**新增 16 个** 全部满足:
- 纯只读(不修改文件 / 系统状态)
- 无副作用(不发起网络请求 / 不执行其他命令链)
- 不泄漏未 masked secret(尤其排除 `env` / `printenv`)

### 2.3 拒绝清单(不放行,defense-in-depth)

未来若有人提 issue 要加,默认按下表评估:

| 命令 | 风险 |
|---|---|
| `env` / `printenv` | 输出 env vars,即使 GitLab mask 也可能漏(历史有 mask 失效 case) |
| `curl` / `wget` / `nc` | 数据外泄通道 |
| `tee` / `mv` / `rm` / `mkdir` / `touch` / `cp` | 写文件系统 |
| `xargs` / `bash` / `sh` / `eval` / `source` | 命令链/执行任意脚本 |
| `npm` / `pip` / `apt` / `yum` | 改系统 |
| `chmod` / `chown` | 改权限 |

### 2.4 错误信息加替代建议

当 LLM 触碰白名单外命令时,返回的 reason 字符串加 1-2 行替代建议(便于 LLM 在下一轮 turn 自动改用对的工具)。

```typescript
// flower-compliance/src/index.ts 内
const SUGGESTION_BY_CMD: Record<string, string> = {
  env:      "想看 MR 元数据 → 用 `gitlab_get_mr_files` / `gitlab_get_mr_diff`;查 env 不可,可能泄漏 secret",
  printenv: "同 env,不可放行",
  curl:     "想拉文件 → `gitlab_get_file_content`;禁止网络外发",
  wget:     "同 curl,禁止网络外发",
  tee:      "禁止写文件;只读评审场景不需要落盘",
  mv:       "禁止写文件",
  rm:       "禁止写文件",
  cp:       "禁止写文件",
  npm:      "禁止安装/执行包管理工具",
  pip:      "同 npm",
};

function buildBashBlockMessage(firstWord: string): string {
  const base = `CI 只读模式:bash 命令 "${firstWord}" 不在白名单内`;
  const suggestion = SUGGESTION_BY_CMD[firstWord];
  return suggestion ? `${base}\n建议:${suggestion}` : base;
}
```

### 2.5 prompts.ts 加「工具优先级」段

`prompts.ts` 「严格要求」段后追加:

```markdown
## 工具优先级(强制)

- **MR / 文件 / 代码信息**:首选 `gitlab_*` 工具
  - MR 文件列表 → `gitlab_get_mr_files`
  - MR diff → `gitlab_get_mr_diff`
  - 文件全文 → `gitlab_get_file_content`
  - 历史评论 → `gitlab_get_previous_review`
- **bash 用法**:
  - ✅ 可用:`git` 系列(log / show / diff / blame / branch …)
  - ✅ 可用:文本处理(`grep` / `sed` / `awk` / `sort` / `uniq` / `tr` / `nl` / `column` / `printf` / `echo` / `jq` / `yq` 等)
  - ✅ 可用:路径 / 元信息(`pwd` / `basename` / `dirname` / `realpath` / `date` / `which`)
  - ❌ **禁用**:`env` / `printenv`(可能泄漏 secret)
  - ❌ **禁用**:`curl` / `wget`(网络外发)
  - ❌ **禁用**:任何写文件命令(`mv` / `rm` / `tee` / `cp` 等)
```

### 2.6 单测

`packages/flower-compliance/src/__tests__/index.test.ts`:

- AC2.1:`it.each` 跑 16 个新增命令,各模拟一个 bash 调用,断言返回 undefined(放行)
- AC2.2:`env` / `printenv` 仍返回 block:true
- AC2.3:`curl` / `tee` / `mv` / `npm` 等高危仍 block
- AC2.4:`env` 拦截 reason 含 `可能泄漏 secret`;`curl` 含 `禁止网络外发`;`nl` **不应**出现在测试拒绝列表(已放行)
- AC2.5:`prompts.test.ts` 断言含 `工具优先级` 段

---

## 3. Fix C · exit 1 预告日志

### 3.1 改动点选择

两个候选位置:

**A. `cli.ts` main 函数**(末尾,exit 前):
```typescript
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runReview(args);
  if (result.exitCode === 1) {
    console.log(`[code-reviewer] 评审完成:发现 blocker,按设计 exit 1(下方 Runner "Job failed" 是预期信号,不是脚本崩溃)`);
  }
  process.exit(result.exitCode);
}
```

**B. `run.ts` 函数末尾**(return 前):需要传 blockerCount 出来,接口微调

**推荐 A**:更靠近 exit 系统调用,语义清晰;不动 `runReview` 接口。

### 3.2 包含实际 blocker 数

为了让日志更有信息量,需要 `runReview` 返回 blocker count:

```typescript
// run.ts ReviewResult 接口扩展
export interface ReviewResult {
  exitCode: 0 | 1 | 2;
  skillUsed: string;
  blockerCount: number;  // ← 新增,exitCode=1 时 > 0
}
```

`scanForBlockers` 当前返回 boolean,改返回数字(blockerCount)对调用者也好用:

```typescript
// 新签名:返回真实 blocker count(>0 即为 fail)
export function countBlockers(input: ScanForBlockersInput): number {
  // ... 类似现有 scanForBlockers,只是 some → count
}
```

或保持 `scanForBlockers` 返回 boolean,在 `run.ts` 里**重复**遍历一次拿数量(简单点,接口零变更)。

**选后者**:零接口变更,**只多一次 filter + length 计算**(O(n) 评论数,可忽略)。

### 3.3 cli.ts 实装

```typescript
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runReview(args);
  if (result.exitCode === 1) {
    console.log(
      `[code-reviewer] 评审完成:发现 ${result.blockerCount} 个 blocker,` +
      `按设计 exit 1(下方 Runner "Job failed" 是预期信号,不是脚本崩溃)`,
    );
  }
  process.exit(result.exitCode);
}
```

### 3.4 单测

- AC3.1:exitCode=1 + blockerCount=3 → console.log spy 收到含 "3 个 blocker" + "按设计 exit 1" 的字符串
- AC3.2:exitCode=0 → console.log spy 不被调用(用 `expect(spy).not.toHaveBeenCalled()`)
- AC3.3:断言 N 与 blockerCount 一致

---

## 4. 兼容性 / 回滚

### 4.1 兼容性

- ✅ `gitlab_get_file_content` ref 改 optional:LLM 旧调用(显式传 ref)零影响,只是新增"省略也行"路径
- ✅ compliance 错误信息变长:消费方(LLM)只会更明白,**不破坏现有断言**(除非测试 hardcode 了完整错误字符串 — spike 时确认)
- ✅ ReviewResult 接口加 blockerCount:**接口扩展,非破坏**;旧调用方不读这个字段也能编译

### 4.2 回滚

- 3 个 fix 独立,各自 revert 一个 commit 即可(若拆 3 PR 走);若合并 1 个 PR,整体 revert 也能正确还原
- 无 db / migration
- 极端兜底:即使本任务 commit 上线后线上行为异常,**reviewer 行为只会比修前**更稳(三个 fix 全是减少错误信号 / 加强弹性),不会引入新故障路径

---

## 5. 跨包边界

| 跨包改动 | 是否需要 |
|---|---|
| `flower-providers` | ❌ 不动 |
| `flower-tools-gitlab` | ✅ Fix A 主体 |
| `flower-tools-common` | ❌ 不动 |
| `flower-compliance` | ✅ Fix B 错误文案 |
| `flower-code-reviewer` | ✅ Fix A 同步 prompts.ts + Fix B 同步 prompts.ts + Fix C cli.ts |
| spec | ✅ `.trellis/spec/flower-code-reviewer/backend/index.md` 加节"trace 噪音控制原则"(可选,小条目) |
