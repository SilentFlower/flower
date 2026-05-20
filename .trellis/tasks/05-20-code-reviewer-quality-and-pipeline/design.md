# Design · flower-code-reviewer 评审质量优化 + 真实 Pipeline 生产化

> 三件套之 design.md。承接 `prd.md` 的 R1-R7 / D1-D7,展开技术设计:接口契约 / 数据流 / 跨仓库边界 / 兼容性 / rollout/rollback。
> 实施 checklist 见 `implement.md`。

## 0. Overview

### 0.1 改动鸟瞰(4 sub-feature × 跨仓库)

```
┌──────────────────────────────────────────────────────────────────┐
│  GitHub: SilentFlower/flower (本仓,主战场)                       │
│  ├─ packages/flower-tools-gitlab/   ← N1 加 endpoint #6           │
│  ├─ packages/flower-code-reviewer/  ← N2 prompts + 渲染逻辑       │
│  │                                  ← E1/E2/E3/E5 mitigation      │
│  │                                  ← 「无依据评论」 blocker 拦截 │
│  ├─ packages/flower-tools-common/   ← (read 工具保留,不动)       │
│  └─ packages/flower-providers/      ← (上任务 buildPiCliArgs 不动)│
└──────────────────────────────────────────────────────────────────┘
                            ↓ Pull Mirror (N3 方案 A)
┌──────────────────────────────────────────────────────────────────┐
│  xhgjdev GitLab: mirror 后 flower 仓                              │
│  └─ .gitlab-ci.yml  ← include node-cli-image.yml                  │
└──────────────────────────────────────────────────────────────────┘
                            ↓ 内网 Runner build & push
┌──────────────────────────────────────────────────────────────────┐
│  Harbor 192.168.27.236/<ns>/flower-code-reviewer:<tag>            │
└──────────────────────────────────────────────────────────────────┘
                            ↑ business 仓 image: 引用
┌──────────────────────────────────────────────────────────────────┐
│  devops-infra-harness (跨仓,N4)                                  │
│  ├─ templates/node-cli-image.yml          ← L1.b 新模板           │
│  └─ templates/review-flower-code-reviewer.yml ← L2.a 新模板       │
└──────────────────────────────────────────────────────────────────┘
                            ↑ include
┌──────────────────────────────────────────────────────────────────┐
│  业务方 .gitlab-ci.yml(本任务不直接 touch)                       │
│  └─ include: 'devops-infra-harness/.../review-flower-code-reviewer.yml'
└──────────────────────────────────────────────────────────────────┘
```

### 0.2 实施顺序(对齐 R1)

`N2(评论质量)` → `N1(LLM 拉代码)` → `N3+N4(部署 + 模板,合并)`,串行;`N3 spike`(找运维 + 实测出公网)**可与 N2 并行**(spike 不影响代码改动)。

---

## 1. N2 · 评论质量优化(R2 落地细节)

### 1.1 prompts.ts 改动边界

**目标文件**:`packages/flower-code-reviewer/src/prompts.ts`

**改动点**:
- L33-59 现「严格要求」段后追加 **6 条新硬约束**(逐字抄 `research/comment-style.md` §5)
- 在 prompt 末尾追加 **5 个完整中文模板样例**作为 LLM few-shot(逐字抄 `research/comment-style.md` §6.1-§6.6)

**6 条新硬约束**(`research/comment-style.md` §5 已写完整文案,这里只列 key point):
1. **行内评论 4 段式**:`_<emoji> <english severity>_ [severity:<level>]` 斜体行(emoji 用 `🔴` blocker / `🟠` major / `🔵` minor,与 `research/comment-style.md` §5/§6 一致;`[severity:<level>]` 前缀贴在标签末尾保留 scanForBlockers 字面量匹配)+ 加粗中文标题 + 解释段 + `<details>` 包 reasoning(可选)
2. **整体评论 walkthrough 结构**:整 body 包 `<details>` 默认折叠,内含「概要 / 文件变更表 / 行动建议」
3. **「无问题」轻量模板**:MR 干净时只发 2 行
4. **quick action 禁令**:LLM 输出**绝对禁止** `^/(approve|close|wip|assign|label|milestone|due|spend|estimate)` 等任何以 `/` 开头的行
5. **emoji shortcode 规范**:`🟥 / 🟠 / 💡` 用 unicode 字符,**不**用 `:red_square:` shortcode(GitLab 渲染兼容性)
6. **`[severity:<level>]` 前缀保留**:每条行内评论第一行末尾必须含 `[severity:blocker]` / `[severity:major]` / `[severity:minor]`(`scanForBlockers` 依赖字面量匹配)

### 1.2 评论渲染逻辑

**位置**:`packages/flower-code-reviewer/src/`(具体 module 名实施时按现有约定起,可能新建 `src/comments/` 子目录)

**契约**:
```ts
/** 整体评论渲染 */
function renderWalkthrough(input: {
  mrTitle: string;
  summary: string;
  fileChanges: Array<{ path: string; additions: number; deletions: number; summary: string }>;
  actionItems: string[];
  gitlabVersion: string; // 用于 alert 块降级
  truncatedFiles?: { shown: number; total: number }; // E2 截断时填
}): string;

/** 行内评论渲染(4 段式) */
function renderInlineComment(input: {
  severity: 'blocker' | 'major' | 'minor';
  title: string;        // 中文加粗标题
  explanation: string;  // 解释段(why)
  suggestion?: string;  // GitLab suggestion 块内容(diff 形式)
  reasoning?: string;   // 折叠 reasoning(可选)
}): string;

/** 「无问题」轻量评论 */
function renderCleanReview(input: { mrTitle: string }): string;
```

**E2 截断说明**:`renderWalkthrough` 内,若 `truncatedFiles` 非空,walkthrough 内插入一段:

> ⚠️ 本次仅评 `{shown}/{total}` 个最大变更文件(按 churn 排序),其余请手工 review。

### 1.3 GitLab `[!caution]` alert 块降级策略

**为什么**:`> [!caution]` 等 GitHub alert 语法 GitLab **17.10+** 支持,旧版本会渲染成裸 `[!caution]` 字面文本(丑且语义丢失)。

**实现**:
- 在 reviewer 启动早期(进入主流程前)调用 `GET /api/v4/version` 拿到 `version` 字段(格式形如 `17.10.0-ee`)
- 解析 major / minor,缓存到 module-level 变量(同一进程内只查一次)
- `renderWalkthrough` 根据缓存决定:
  - `>= 17.10` → `> [!caution]\n> 本 MR 含 N 个 blocker,合并前必须修复:`
  - `< 17.10` → `> ⚠️ **Caution**\n> 本 MR 含 N 个 blocker,合并前必须修复:`
- 探测失败 → 默认降级路径(保守)

**契约**:
```ts
async function detectGitlabVersion(client: GitlabClient): Promise<{ major: number; minor: number } | null>;
function supportsAlertBlock(v: { major: number; minor: number } | null): boolean;
```

### 1.4 `scanForBlockers` 兼容性

**不动**:`run.ts` 现 `scanForBlockers` 基于 `[severity:blocker]` 字面量匹配,新模板保留前缀 → 完全向后兼容。

**新增 case**(在 N1 节扩展):见 §2.3「无依据评论」拦截。

---

## 2. N1 · LLM 拉真实代码上下文(R3 落地细节)

### 2.1 flower-tools-gitlab 新 endpoint `gitlab_get_file_content`

**位置**:`packages/flower-tools-gitlab/src/client.ts`(扩展)+ `packages/flower-tools-gitlab/src/index.ts`(export)

**REST API**:`GET /api/v4/projects/{id}/repository/files/{path}/raw?ref={ref}`

**TS 签名**(2026-05-20 实施后修订):
```ts
/**
 * 拉取 GitLab 仓库内任意 ref 的文件原始内容。
 *
 * 工具暴露给 LLM 的 schema 仅 { path, ref }(projectId 从 env CI_PROJECT_ID
 * 隐式读取,避免 LLM 跨项目越权 + 减少 prompt 噪声)。
 *
 * 工具 execute 层会通过 `safeReadFile` wrapper 兜底:
 *   - 文件 size > FLOWER_MAX_FILE_SIZE(默认 50KB)→ 截断 + 标注
 *   - 二进制后缀(.png / .lock / .pdf 等 18 类)→ 直接返回 HTML 注释 placeholder
 *
 * @param path 仓库内相对路径(URL encoding 由本函数处理)
 * @param ref  任意 ref(branch / tag / commit sha;默认 source HEAD 由调用方传)
 * @returns 文件文本内容(UTF-8;经 safeReadFile 截断/跳过后)
 * @throws AuthError(401/403)/ FileNotFoundError(404)/ RetryableError(5xx 重试后)
 */
async function gitlab_get_file_content(args: {
  path: string;
  ref: string;
}): Promise<string>;
```

**实现要点**:
- `path` 必须 URL-encoded(包括 `/` → `%2F`),复用现有 client.ts encoding helper
- 200 响应:整 body 即 raw 文件(非 JSON)
- 404 → 抛 `FileNotFoundError`(LLM 看到 → 可选拉别的 ref / path)
- 401/403 → 抛 `AuthError`(整个评审 abort)
- 5xx → 抛 `RetryableError`,client 层重试 1 次

**单测**(`packages/flower-tools-gitlab/src/client.test.ts` 新增 ≥ 3 case):
- 成功:200 + UTF-8 文件内容
- 404:抛 FileNotFoundError + 不重试
- size 截断(E5):返回 60KB 内容,verify caller 截断到 50KB + 加标注

### 2.2 prompts.ts 强约束「每文件必读」

**改动**(在 §1.1 6 条硬约束之外追加第 7 条):

> **第 7 条 · 真实代码上下文约束**:对 MR 改动的**每个变更文件**,必须先调用 `gitlab_get_file_content` 拉完整内容(ref 默认 source HEAD)再发出评论。鼓励拉**相关上下文**(被改函数实现 / 被改类定义 / 调用方),通过 `gitlab_get_file_content` 拉任意 ref 的任意路径。**未拉文件直接发评论 → 视为「无依据评论」 → 被 `scanForBlockers` 拦截为 blocker(自我阻塞)**。

### 2.3 「无依据评论」blocker 拦截

**位置**:`packages/flower-code-reviewer/src/run.ts` 的 `scanForBlockers`(扩展)

**逻辑**:
- 评审过程中,trace 所有 `gitlab_get_file_content` tool call,累计已拉文件集合 `readFiles: Set<string>`
- LLM 发评论(`gitlab_post_line_comment`)时,拿到评论关联的 `path`
- 若 `path` ∉ `readFiles` → 整体加一条 `[severity:blocker] 无依据评论:对 ${path} 发出评论但未读完整文件`
- 实现细节:不一定要拦截 LLM 发出,而是在 finalize 阶段(LLM 全部 tool call 完成后)扫一遍所有 line_comment 来源 path 是否都在 `readFiles` 中

**单测**(`packages/flower-code-reviewer/src/run.test.ts` 加 case):
- 输入:mock LLM 不调用 `gitlab_get_file_content` 就发 `gitlab_post_line_comment(path='a.go')`
- 期望:`scanForBlockers` 返回 ≥ 1 个 blocker,内容含「无依据评论」+ path

### 2.4 E5 · 文件 size cap + 二进制跳过

**位置**:`packages/flower-code-reviewer/src/`(可放在 `gitlab_get_file_content` 的 wrapper 层,不污染 flower-tools-gitlab 原始 client)

**实现**:
```ts
const MAX_FILE_SIZE = parseInt(process.env.FLOWER_MAX_FILE_SIZE ?? '51200', 10); // 50KB
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.tar', '.gz', '.7z',
  '.ico', '.woff', '.woff2', '.ttf', '.otf', '.so', '.dll', '.exe', '.bin',
  '.lock', // pnpm-lock / yarn.lock / package-lock 二进制式大文件
]);

async function safeReadFile(args: { project_id; path; ref }): Promise<string> {
  const ext = path.extname(args.path).toLowerCase();
  if (BINARY_EXT.has(ext)) {
    return `<!-- 二进制文件已跳过: ${args.path} -->`;
  }
  const content = await gitlab_get_file_content(args);
  if (content.length > MAX_FILE_SIZE) {
    return content.slice(0, MAX_FILE_SIZE) + `\n<!-- ⚠️ 文件过大(${content.length} bytes),仅展示前 ${MAX_FILE_SIZE} bytes -->`;
  }
  return content;
}
```

**注意**:这是 LLM 看到的 wrapper,所以截断后给 LLM 的提示用 HTML 注释形式(不污染评论 markdown)。

---

## 3. N3 · 镜像跨网部署(R4 落地细节)

### 3.1 Phase 1 spike(第一天 30min 必做)

**5 个 question 找运维 / 网络 / Harbor maintainer 拍板**(`prd.md` R4 列了清单)。

**实测项**:在 xhgjdev GitLab server 主机执行 `curl -I https://github.com`(或等价 ssh 进入 mihomo egress-proxy node 后 verify):
- 通 → 走方案 A
- 不通 → 切 B.a fallback

**输出**:`.trellis/tasks/05-20-code-reviewer-quality-and-pipeline/research/spike-result.md`(spike 当天落地;若答案影响 design,在此 design.md 加 ADR 补丁段)

### 3.2 方案 A · GitLab Pull Mirror 主链路

**配置 step**:
1. 在 xhgjdev GitLab 新建空仓 `flower-mirror`(namespace 待 spike Q3 确认,推荐 `infra/flower-mirror`)
2. 仓 Settings → Repository → Mirroring repositories → 添加 `https://github.com/SilentFlower/flower.git` + 选 Pull
3. 同步频率 → Free tier 30min(可接受);Premium 5min(若已有 license)
4. mirror 后仓的 `.gitlab-ci.yml`(由本任务**写到 GitHub flower 仓 root**,mirror 后自动出现在 xhgjdev GitLab):
   ```yaml
   include:
     - project: 'devops/devops-infra-harness'  # spike Q3 确认实际 path
       ref: main
       file: '/templates/node-cli-image.yml'

   build-flower-code-reviewer:
     extends: .node-cli-image
     variables:
       IMAGE_NAME: 'flower-code-reviewer'
       IMAGE_TAG: '${CI_COMMIT_SHORT_SHA}'
       SUB_DIR: 'packages/flower-code-reviewer'
       REGISTRY: '192.168.27.236'
       REGISTRY_NS: 'flower'  # spike Q3 确认
   ```

### 3.3 B.a fallback · GitHub Actions → ACR → Harbor

**触发条件**:Phase 1 spike 揭晓 GitLab 出公网不通 / Pull Mirror 不可用。

**落地**:
1. 在 GitHub flower 仓加 `.github/workflows/build-image.yml`:
   - on: push to main / tag
   - 复用现有 `ACR_USER` / `ACR_PASS` secret
   - docker build flower-code-reviewer image → push to `registry.cn-hangzhou.aliyuncs.com/<acr-ns>/flower-code-reviewer:<sha>`
2. ACR → 内网 Harbor 同步通道(spike Q3 确认是否有现成 cron / hook;若无则本任务**不实施**,留 fallback note 给运维手动)

**design 暂留**:B.a 具体细节在 spike 失败时再展开,本节不深入。

---

## 4. N4 · harness 模板(R5 落地细节)

### 4.1 `node-cli-image.yml`(L1.b)

**位置**:`/root/project/devops-infra-harness/devops-infra/templates/node-cli-image.yml`(spike Q3 确认实际目录)

**作用**:封装「monorepo workspace 子目录 → docker build → push registry」的标准 stage,可复用于任何 Node.js CLI 镜像(本任务 flower-code-reviewer / sibling auto-fix bot / 未来其他)。

**variable**:
```yaml
.node-cli-image:
  stage: build
  image: docker:24-cli  # 或 kaniko(spike 确认 harness 既有约定)
  services:
    - docker:24-dind
  variables:
    IMAGE_NAME: ''     # 必填
    IMAGE_TAG: '${CI_COMMIT_SHORT_SHA}'
    SUB_DIR: '.'       # monorepo 子目录;Dockerfile 在 ${SUB_DIR}/Dockerfile
    REGISTRY: ''       # 必填,如 '192.168.27.236'
    REGISTRY_NS: ''    # 必填,如 'flower'
    REGISTRY_USER: '${HARBOR_USER}'  # 默认从 group secret 取
    REGISTRY_PASS: '${HARBOR_PASS}'
  script:
    - docker login -u "${REGISTRY_USER}" -p "${REGISTRY_PASS}" "${REGISTRY}"
    - docker build -t "${REGISTRY}/${REGISTRY_NS}/${IMAGE_NAME}:${IMAGE_TAG}" -f "${SUB_DIR}/Dockerfile" .
    - docker tag "${REGISTRY}/${REGISTRY_NS}/${IMAGE_NAME}:${IMAGE_TAG}" "${REGISTRY}/${REGISTRY_NS}/${IMAGE_NAME}:latest"
    - docker push "${REGISTRY}/${REGISTRY_NS}/${IMAGE_NAME}:${IMAGE_TAG}"
    - docker push "${REGISTRY}/${REGISTRY_NS}/${IMAGE_NAME}:latest"
  tags:
    - infra-build-proxy  # research F1 已确认的 runner tag
```

### 4.2 `review-flower-code-reviewer.yml`(L2.a)

**位置**:同 §4.1 templates 目录。

**作用**:封装业务方接入 flower-code-reviewer 评审 job 的标准 stage。

**variable**:
```yaml
.review-flower-code-reviewer:
  stage: review
  image: '192.168.27.236/flower/flower-code-reviewer:${FLOWER_IMAGE_TAG}'
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    FLOWER_IMAGE_TAG: 'latest'           # 业务方可锁版本
    GITLAB_TOKEN: '${REVIEWER_BOT_TOKEN}'
    LLM_BASE_URL: '${LLM_BASE_URL}'
    LLM_API_KEY: '${LLM_API_KEY}'
    SIEM_INGEST_URL: '${SIEM_INGEST_URL}'
    FLOWER_MAX_FILES: '50'               # E2 cap
    FLOWER_MAX_FILE_SIZE: '51200'        # E5 cap
  script:
    - flower-review --mr-iid $CI_MERGE_REQUEST_IID
  allow_failure: false                    # blocker 阻塞 pipeline
  timeout: 10 minutes
```

业务方使用方式:
```yaml
# 业务方仓 .gitlab-ci.yml
include:
  - project: 'devops/devops-infra-harness'
    ref: main
    file: '/templates/review-flower-code-reviewer.yml'

code-review:
  extends: .review-flower-code-reviewer
  # 可选 override variable
```

### 4.3 `.gitlab-ci.example.yml` 改写

**位置**:`packages/flower-code-reviewer/.gitlab-ci.example.yml`

**改动**:从「裸 image 引用」改成「include 模板 + 注释 fallback」。

```yaml
# 推荐方式:include devops-infra-harness 模板
include:
  - project: 'devops/devops-infra-harness'  # 实际 path 见公司内 wiki
    ref: main
    file: '/templates/review-flower-code-reviewer.yml'

code-review:
  extends: .review-flower-code-reviewer
  # 如需 override 变量(如锁版本):
  # variables:
  #   FLOWER_IMAGE_TAG: 'v1.0.0-abc123'

# ---- 备用接入方式(不走 harness 模板,自管 image)----
# code-review-standalone:
#   stage: review
#   image: 192.168.27.236/flower/flower-code-reviewer:latest
#   rules:
#     - if: $CI_PIPELINE_SOURCE == "merge_request_event"
#   variables:
#     GITLAB_TOKEN: $REVIEWER_BOT_TOKEN
#     LLM_BASE_URL: $LLM_BASE_URL
#     LLM_API_KEY: $LLM_API_KEY
#     SIEM_INGEST_URL: $SIEM_INGEST_URL
#   script:
#     - flower-review --mr-iid $CI_MERGE_REQUEST_IID
#   allow_failure: false
#   timeout: 10 minutes
```

---

## 5. E1/E2/E3 mitigation 落地

### 5.1 E1 · LLM fail open

**位置**:`packages/flower-code-reviewer/src/run.ts` 主流程顶层。

**实现**:
```ts
try {
  await runReview(args); // 现主流程
} catch (e) {
  if (isLlmFailure(e)) {
    await postWarningComment({
      mrIid: args.mrIid,
      message: '⚠️ flower-code-reviewer 因 LLM 网关异常未能完成自动评审,请手工 review 本 MR。\n\n错误详情已上报 SIEM。',
    });
    // pipeline 不阻塞:exit 0
    return;
  }
  throw e; // 其他错误(GitLab API auth / 配置错)正常 fail close
}
```

**`isLlmFailure` 判定**:LLM 调用失败的 error 类型(network / 5xx / 429 / timeout);与 GitLab API 错误区分。

**单测**(`run.test.ts` 新 case):
- mock LLM client 全部 call 抛 `LlmNetworkError`
- 期望:`postWarningComment` 被调用 1 次 + `process.exitCode` 未设 1

### 5.2 E2 · MR diff size cap

**位置**:`packages/flower-code-reviewer/src/`(放在 diff 加载阶段)

**实现**:
- 拿到 MR diff 文件列表后,按 `additions + deletions` 降序排序
- 取前 `FLOWER_MAX_FILES`(默认 50)个文件
- 若有截断,记录 `truncatedFiles = { shown: N, total: M }` 传入 `renderWalkthrough`

**单测**:
- 输入:mock 51 文件 diff,每个 churn 不同
- 期望:返回 top 50;walkthrough 含「⚠️ 本次仅评 50/51」字样

### 5.3 E3 · quick action sanitize

**位置**:`packages/flower-code-reviewer/src/sanitize.ts`(新文件,纯函数)

**实现**:
```ts
const QUICK_ACTIONS = [
  'approve', 'unapprove', 'close', 'reopen', 'wip', 'draft',
  'assign', 'unassign', 'reassign', 'label', 'unlabel', 'relabel',
  'milestone', 'remove_milestone', 'due', 'remove_due_date',
  'spend', 'spent', 'estimate', 'remove_estimate', 'remove_time_spent',
  'lock', 'unlock', 'merge', 'rebase', 'subscribe', 'unsubscribe',
  'confidential', 'todo', 'done', 'tag', 'cc', 'shrug', 'tableflip',
];

const QUICK_ACTION_REGEX = new RegExp(`^/(${QUICK_ACTIONS.join('|')})(\\s|$)`, 'i');

/**
 * 把评论 body 中以 / + GitLab quick action 关键字开头的行做转义,
 * 防止 GitLab 服务端把评论解读为 quick action 误执行 MR 操作。
 * 转义方式:首字符 / → &#47;
 */
export function sanitizeQuickActions(body: string): string {
  return body
    .split('\n')
    .map((line) => (QUICK_ACTION_REGEX.test(line) ? '&#47;' + line.slice(1) : line))
    .join('\n');
}
```

**调用点**:`gitlab_post_comment` / `gitlab_post_line_comment` 的 wrapper 层(在发出前过一遍 sanitize),`post*` 之前。

**单测**(`sanitize.test.ts`):
- 12+ quick action 各一个 case
- 非 quick action 行(普通 `/path` 引用)不动
- 多行混合 case

---

## 6. 跨仓库改动边界

| 仓库 | 改动 | 提交方式 |
|------|------|---------|
| **GitHub flower(本仓)** | N1 工具 + N2 prompt/渲染 + E1/E2/E3/E5 mitigation + `.gitlab-ci.yml`(供 mirror)+ `.gitlab-ci.example.yml` 改 include 形式 | 主 PR |
| **devops-infra-harness** | N4 加 `node-cli-image.yml` + `review-flower-code-reviewer.yml` | 单独 PR + maintainer review |
| **xhgjdev GitLab(运维侧)** | 建 mirror 仓 + 配 Pull Mirror + 设置 GitLab CI variable(HARBOR_USER/PASS) | 运维配置,本任务不写代码,提工单 |
| **业务方仓**(fork sandbox srm-esign) | 验 e2e 时:在 srm-esign `.gitlab-ci.yml` 加 include + REVIEWER_BOT_TOKEN 等 variable | 本任务 e2e 阶段触发,**不长期 own** |

---

## 7. Rollout / Rollback

### Rollout
1. 镜像 tag 双写:`<sha>` + `latest`,业务方可选 `latest`(自动跟进)或锁 `<sha>`(保守)
2. fork sandbox(srm-esign)率先验,跑稳后业务方接入
3. harness 模板 PR 合入前,flower 仓 `.gitlab-ci.yml` 临时 inline 写(不走 include)→ 合入后改 include

### Rollback
- **L1 · 镜像层**:若新版本(`latest`)有问题 → 业务方把 `FLOWER_IMAGE_TAG` 锁回上一个 `<sha>`
- **L2 · 模板层**:若 harness 模板有问题 → 业务方 `extends:` 改回 `.gitlab-ci.example.yml` 备用接入方式(image 直引)
- **L3 · 代码层**:GitHub flower 仓 git revert → mirror 后自动同步 → 下一次 build 出旧版镜像 → `latest` tag 自动指回旧版

### 灰度
- 本任务范围内不引入种子用户(R6),无灰度需求
- 后续推广任务可通过「业务方仓 include 锁版本 `<sha>`」实现按仓库灰度

---

## 8. 兼容性

| 接口 / 契约 | 兼容性 |
|-------------|--------|
| `[severity:<level>]` 前缀(scanForBlockers) | 完全保留,新模板继续带 → 向后兼容 |
| flower-tools-gitlab 5 既有 endpoint | 不动,新加第 6 个,纯增量 |
| `.gitlab-ci.example.yml` | 改为 include 形式 + 保留旧 inline 写法作备用注释段,业务方若已抄旧版可平滑迁移 |
| Dockerfile + WORKDIR /workspace | 不动(N1 走远程 API,不依赖 mount 行为) |
| prompts.ts | 追加 6 + 1 条硬约束 + 5 个 few-shot,既有约束不删 |

---

## 9. 风险与 mitigation 汇总

| 风险 | mitigation | 兜底 |
|------|-----------|------|
| GitLab 出公网不通 → Pull Mirror 失败 | spike 第一天揭晓 | B.a fallback(GitHub Actions → ACR → Harbor) |
| GitLab 版本 < 17.10 → alert 块裸字面 | 启动探测版本 + 降级 blockquote | 默认走降级路径 |
| LLM 输出 quick action `/approve` | prompt 硬约束 + post 前 sanitize 双层 | 兜底 sanitize 拦截 |
| LLM 输出 markdown 损坏 | prompt 给 5 个完整模板样例引导复制 | E4 延后(remark 校验) |
| harness maintainer review 卡住 | 提早提 PR + 主动跟进 | 临时 inline 配置 `.gitlab-ci.yml`,合入后切 include |
| 镜像同步延迟 30min | 接受(评审非 hot path) | 紧急修复手动触发 mirror sync |
| MR diff 过大 LLM token 爆 | E2 cap 默认 50 文件 | walkthrough 标注截断 |
| 单文件巨大 LLM token 爆 | E5 cap 默认 50KB | 截断 + 标注 |
| 二进制文件被拉 | E5 按后缀跳过 | wrapper 返回 HTML 注释 placeholder |

---

## 10. 不在 design 范围内(参考 PRD Out of Scope)

- N5 auto-fix bot
- npm registry 发布
- 多 LLM 模型矩阵 / 模型选型
- K2 常驻 service
- 多业务方扩散 onboarding
- E4 markdown 校验(remark 依赖)
