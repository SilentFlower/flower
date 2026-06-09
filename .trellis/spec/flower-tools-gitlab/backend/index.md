# Backend Development Guidelines

> `@flower-ai/flower-tools-gitlab` 的内部实现层(REST 客户端、stub 实现、未来真实接入)规范。

---

## Overview

本目录(`backend/`)关心 **`src/client.ts` / `src/workspace.ts` 的实现**:

- 已接入真实 GitLab REST API(**8 个 endpoint**:getMrDiff / getMrFiles / postMrComment / postMrLineComment / getBotComments / **getFileContent** / **listGroupProjects** / **listProjectBranches**)
- stub 阶段的 `[Stub]` console.log 已全部清除
- `safe-read.ts` 工具层 wrapper(默认 500 行行窗 + 单次最大 1000 行 + 单文件 50KB cap + 18 类二进制后缀跳过)封装 `gitlab_get_file_content` execute,LLM 默认拿不到超大整文件或二进制原始内容
- `workspace.ts` 负责跨项目本地上下文准备:只允许白名单 namespace 下的项目,按需 shallow fetch 到固定临时目录,供 reviewer 后续用本地 `rg` 搜索

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 当前布局与未来拆分 |
| [Database Guidelines](./database-guidelines.md) | 不适用(GitLab 是远端) |
| [Error Handling](./error-handling.md) | API 错误 / token 错误 / 增量评审重试策略 |
| [Logging Guidelines](./logging-guidelines.md) | 不打 token / diff 内容 / 评论 body |
| [Quality Guidelines](./quality-guidelines.md) | 与 frontend/ 共用 + backend 强约束 |

---

## 关键设计点

1. **轻量 HTTP 客户端**:`fetch` + 5-6 个 endpoint,**不引** `@gitbeaker/rest`
2. **endpoint 设计**:
   - `GET /api/v4/projects/{projectId}/merge_requests/{mrIid}/changes` → diff + files + diff_refs
   - `POST /api/v4/projects/{projectId}/merge_requests/{mrIid}/notes` → 整体评论
   - `POST /api/v4/projects/{projectId}/merge_requests/{mrIid}/discussions` → 行内评论(需要 position 参数)
   - `GET notes` 后过滤 `author.username === bot user` → bot 历史评论
   - `GET /api/v4/user` → bot 自身 username(由 client 内部自查 + 缓存,避免硬编码 env)
   - **`GET /api/v4/projects/{projectId}/repository/files/{encodedPath}/raw?ref={encodedRef}`** → 任意 ref 的文件原始内容(N1 LLM 拉真实代码上下文用;`path` / `ref` 必须 URL-encode;200 OK 返回文本 body 非 JSON;**工具层 `safe-read.ts` wrapper 兜底**:未传行号默认返回 1..500 行,显式 `startLine` / `endLine` 单次最多 1000 行并提示续读;文件窗口 size > `FLOWER_MAX_FILE_SIZE`(默认 50KB)截断 + 标注;按后缀跳过 `.png/.jpg/.jpeg/.gif/.pdf/.zip/.tar/.gz/.7z/.ico/.woff/.woff2/.ttf/.otf/.so/.dll/.exe/.bin/.lock` 18 类二进制)
3. **token 鉴权**:`PRIVATE-TOKEN` header(GitLab 推荐,client.ts 用此)
4. **`projectId` 必须 `encodeURIComponent`**:GitLab project path 含 `/`(如 `digital-independent-projects/srm-esign`),URL 拼接时必须 encode 成 `digital-independent-projects%2Fsrm-esign`,否则 404
5. **行内评论 position**:必须传 `position_type: "text"` + `base_sha` / `start_sha` / `head_sha` / `new_path` / `new_line`。三个 sha 从同一个 `/changes` 接口的 `diff_refs` 拿,**client 内部缓存 per-MR changes**(`Map<"<projectId>:<mrIid>", ChangesResponse>`)避免每次发评论都重拉 changes,也用于判断目标 `new_line` 是否在 diff 可评论行内。`getMrDiff` 必须在 hunk 内给新增行 / 上下文行 / 删除行标注 `add` / `ctx` / `del` 和行号;`postMrLineComment` 只能对 `add` / `ctx` 对应的新文件行号发 GitLab line discussion,目标不可评论时按下方「MR 行内评论定位与重定位」场景处理
6. **severity 词表 + 评论 body marker 注入策略**(2026-05-20 二次迭代):
   - **词表统一**:`severitySchema = z.enum(["blocker", "major", "minor"])`(原 `info | warning | blocker` 已弃用);对齐 `flower-code-reviewer/src/comments/render.ts` 与 `prompts.ts` few-shot 模板
   - **仅 blocker 注入 HTML 注释 marker**(2026-05-20 升级,替代旧字面 `[severity:blocker]` 前缀):
     - blocker:`postMrComment` / `postMrLineComment` execute 在 body 首行 prepend `<!-- severity: blocker -->\n`(GitLab markdown 渲染时 HTML 注释不显示,用户视图完全干净)
     - major / minor:**body 原样**,无任何 marker(由模板内 emoji + 加粗中文等级 表达严重程度,例如 `🟠 **重要** · ...`)
   - `run.ts:scanForBlockers` 双 marker 兼容:正则同时匹配 `<!--\s*severity:\s*blocker\s*-->`(新)和 `^\[severity:blocker\]`(旧,向后兼容历史评论)
   - 改 marker 格式必须同步改 `flower-code-reviewer/src/run.ts:scanForBlockers` 正则
7. **行内评论 quick-action 防御**:`postMrComment` / `postMrLineComment` execute 内对 `body` 参数做 `sanitizeQuickActions`(import 自 `@flower-ai/flower-tools-common`)→ 首字符 `/` 改成 `&#47;`,防止 LLM 输出 `/approve` `/close` 等被 GitLab 当作 quick action 误执行 MR 状态;**与 prompt 第 4 条硬约束形成双层防御**
8. **错误处理**:
   - HTTP 200/201 OK
   - 4xx(401/403/404/429)直接抛 Error,信息含 endpoint path + HTTP code + 响应体前 200 字符(截断防 token / 内部信息泄漏)
   - 5xx + 网络错误重试 1 次(sleep 2s),仍失败抛
   - **429 不重试**(限流意味配额耗尽,继续重试火上浇油)
   - **N1 `getFileContent` 错误分类**(`gitlabFetch({ classifyError: true })`):401/403 → `AuthError`(整个评审 abort)/ 404 → `FileNotFoundError`(LLM 可选拉别的 ref)/ 5xx → `RetryableError`(重试 1 次仍失败抛);其他 5 endpoint 保持原行为(`classifyError: false`),向后兼容
9. **超时 10 秒**:`AbortSignal.timeout(10_000)`
10. **失败 fail-loud**:GitLab API 错时 throw,让上层(工具 execute / pi 框架)知道

## 场景: MR 行内评论定位与重定位(2026-06-09)

### 1. 范围 / 触发

- 触发:GitLab 只允许对 MR diff hunk 内的新增行或上下文行创建 text position。LLM 若把 `gitlab_get_file_content` 的普通文件行号、删除行行号、或 hunk 外行号传给 `gitlab_post_line_comment`,GitLab 会拒绝 position,最终只能出现「原计划行内评论位置不可用」。
- 本场景是 GitLab REST position 合同 + reviewer prompt 合同的跨层变更,必须记录 diff 标注、可评论行判断、重定位、降级和测试点。

### 2. 签名

- 客户端:
  - `getMrDiff(projectId: string, mrIid: number): Promise<string>`
  - `postMrLineComment(projectId: string, mrIid: number, input: LineCommentInput): Promise<LineCommentResult>`
  - `collectCommentableNewLines(diff: string): Set<number>`
- 输入:
  - `LineCommentInput = { file: string; line: number; body: string; severity: "blocker" | "major" | "minor" }`
- 输出:
  - `LineCommentResult.posted`:只能是 `"line"` 或 `"note_fallback"`
  - `LineCommentResult.reason`:仅降级整体评论时返回
  - `LineCommentResult.originalLine`:LLM 原计划评论的新文件行号;重定位或降级时返回
  - `LineCommentResult.actualLine`:实际挂载的新文件行号;行内评论成功时返回
  - `LineCommentResult.relocated`:自动重定位时为 `true`

### 3. 契约

- `getMrDiff` 返回的每个文件 diff 必须包含 `--- a/<path>` / `+++ b/<path>` 文件头。
- hunk 内行格式必须标注行号和类型:
  - 新增行:`+<new_line> add  <content>`;可作为 `gitlab_post_line_comment.line`
  - 上下文行:` <new_line> ctx  <content>`;可作为 `gitlab_post_line_comment.line`
  - 删除行:`-<old_line> del  <content>`;不能作为 `new_line`
- `collectCommentableNewLines` 只收集新增行和上下文行对应的新文件行号;删除行、文件头、空行、`\ No newline at end of file` 不进入集合。
- `postMrLineComment` 必须从同一个 `/changes` 响应读取 `diff_refs` 和变更文件 diff,并复用 per-MR cache。
- 目标 `line` 可评论时,必须 POST `/discussions` 且 position 包含 `position_type: "text"`、三个 sha、`new_path`、`new_line`。
- 目标 `line` 不可评论但同文件最近可评论行距离 `<= 12`,且 body 不包含 ```suggestion 代码块时,允许自动重定位到最近可评论行;评论 body 首段必须说明原目标和实际挂载位置。
- 目标 `line` 不可评论且无法安全重定位时,必须降级为 MR 整体 note,body 必须包含「原计划行内评论位置不可用」、原因、最近 3 个候选可评论行和原评论内容。
- body 包含 ```suggestion 且原目标行不可评论时禁止自动重定位,必须降级整体 note,避免 GitLab suggestion 应用到错误行。
- `blocker` severity 的 HTML 注释 marker 注入规则不变:行内和降级整体 note 都必须走统一 wrapper。

### 4. 校验与错误矩阵

| 条件 | 结果 |
|------|------|
| `file` 是 MR 中未删除的 `new_path`,且 `line` 在 `add` / `ctx` 集合内 | POST `/discussions`;返回 `{ posted:"line", actualLine: line }` |
| `line` 不在可评论集合,最近候选距离 `<= 12`,body 无 suggestion | 重定位到最近候选;POST `/discussions`;返回 `{ posted:"line", originalLine, actualLine, relocated:true }` |
| `line` 不在可评论集合,最近候选距离 `> 12` | POST `/notes` 降级整体评论;不 POST `/discussions`;返回 `{ posted:"note_fallback", reason, originalLine }` |
| body 含 ```suggestion 且原 `line` 不可评论 | POST `/notes` 降级整体评论;原因写明 suggestion 未重定位 |
| `file` 不在 MR 变更文件内或是 deleted file | 视为无可评论候选;POST `/notes` 降级整体评论 |
| `line` 非整数 | 视为不可评论;不自动重定位;POST `/notes` 降级整体评论 |
| GitLab API 4xx / 5xx | 沿用 `gitlabFetch` fail-loud 和重试规则;不得吞错伪造成功 |

### 5. 正常 / 基线 / 错误用例

- 正常:LLM 从 `gitlab_get_mr_diff` 看到 `+ 295 add  exportField(...)`,调用 `gitlab_post_line_comment({file:"src/pages/procurement/shared/taskExportFields.ts", line:295, ...})`,工具发 `/discussions`。
- 基线:问题语义落在同一 hunk 的未改动上下文行,LLM 选择最近 `ctx` 标记的新文件行号;工具仍发 `/discussions`。
- 可恢复错误:LLM 传 `line: 301`,该行不在 hunk 中,最近可评论行是 `295`,距离 6 且无 suggestion;工具重定位到 295,并在评论前缀说明位置调整。
- 不可恢复错误:LLM 传 `line: 500`,最近候选距离超过 12;工具降级整体评论,展示最近候选行,避免 GitLab position 失败。
- suggestion 错误:LLM 在不可评论行上传 ```suggestion;工具禁止重定位,降级整体评论,避免修改建议应用到错误代码。

### 6. 必需测试

- `client.test.ts`:覆盖 `getMrDiff` hunk 标注 `add` / `ctx` / `del` 和行号。
- `client.test.ts`:覆盖 `collectCommentableNewLines` 只返回新增行 / 上下文行的新文件行号。
- `client.test.ts`:覆盖目标行可评论时 `/discussions` position 5 字段和 `actualLine` 返回。
- `client.test.ts`:覆盖不可评论近邻重定位,断言 `new_line` 改为最近候选、body 含定位调整、返回 `relocated:true`。
- `client.test.ts`:覆盖不可评论远距离降级,断言只 POST `/notes`、body 含原因和最近 3 个候选行。
- `client.test.ts`:覆盖 suggestion + 不可评论行降级,断言不 POST `/discussions`。
- `index.ts` 工具测试或现有 tool execution 测试:覆盖 `gitlab_post_line_comment` 的 `details.originalLine` / `details.actualLine` / `details.relocated` 透出。
- `flower-code-reviewer` prompt 测试:覆盖 prompt 明确要求行内评论行号来自 MR diff 的 `add` / `ctx` 标记,不得直接使用文件行窗普通行号。

### 7. 错误与正确示例

#### 错误

```typescript
// 文件行窗里看到第 295 行有问题,但 295 不一定是 MR diff 可评论 new_line。
await gitlabClient().postMrLineComment(projectId, mrIid, {
	file: "src/pages/procurement/shared/taskExportFields.ts",
	line: 295,
	body: "这里有问题",
	severity: "major",
});
```

#### 正确

```typescript
// 先从 getMrDiff 的 hunk 标记选择 add / ctx 对应的新文件行号。
const diff = await gitlabClient().getMrDiff(projectId, mrIid);
// 看到: + 295 add  field: "taskName",
await gitlabClient().postMrLineComment(projectId, mrIid, {
	file: "src/pages/procurement/shared/taskExportFields.ts",
	line: 295,
	body: "这里有问题",
	severity: "major",
});
```

## 场景: 跨项目上下文工具(2026-05-27)

### 1. 范围 / 触发

- 触发:新增 `gitlab_list_group_projects` / `gitlab_list_project_branches` / `gitlab_prepare_project_workspace` 三个工具,让 reviewer 按需读取同 namespace 内 harness 等权威业务文档。
- 这是 infra integration + 工具签名变更,必须记录 env、白名单、安全边界和返回契约。

### 2. 签名

- 客户端:
  - `listGroupProjects(group, { includeSubgroups?, search? }): Promise<GitlabProjectSummary[]>`
  - `listProjectBranches(project, { search? }): Promise<GitlabBranchSummary[]>`
  - `prepareProjectWorkspace(input: PrepareProjectWorkspaceInput): Promise<PreparedProjectWorkspace>`
- 工具:
  - `gitlab_list_group_projects({ group, includeSubgroups?, search? })`
  - `gitlab_list_project_branches({ project, search? })`
  - `gitlab_prepare_project_workspace({ project, ref, alias, depth? })`
- workspace helper:
  - `prepareProjectWorkspace(host, token, input)`
  - `resolveAllowedProjectPrefixes()`
  - `assertAllowedProject(project, allowedPrefixes?)`
  - `assertAllowedGroup(group, allowedPrefixes?)`

### 3. 契约

- `FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES`:可选,逗号分隔的允许 namespace 前缀;优先级最高。
- `CI_PROJECT_NAMESPACE`:未显式配置 prefix 时作为默认白名单。
- `CI_PROJECT_PATH`:没有 `CI_PROJECT_NAMESPACE` 时取去掉最后一段项目名后的 namespace。
- `FLOWER_GITLAB_CONTEXT_ROOT`:可选,默认 `/tmp/review-context/repos`。
- `project`:必须是 `namespace/project` 路径,不能是 URL;允许 `.git` 后缀输入,内部会去掉。
- `group`:必须是 GitLab namespace/path,不能是 URL 或 `.git` 仓库地址。
- `alias`:只允许 `[A-Za-z0-9._-]+`,最终路径必须落在 context root 下。
- `ref`:branch / tag / commit sha;不能为空、不能以 `-` 开头、不能包含空白、控制字符、反斜杠或 `..`。
- `depth`:默认 1,必须是 1..100 的整数。
- Git 认证:Git smart HTTP 使用 Basic header,通过 `GIT_CONFIG_KEY_0=http.extraHeader` + `GIT_CONFIG_VALUE_0=Authorization: Basic <base64("oauth2:<token>")>` 传给 `git`;REST API 仍使用 `PRIVATE-TOKEN`。不要把 token 写入 URL、remote、日志、工具返回值或未脱敏异常。
- `gitlab_prepare_project_workspace` 返回文本必须包含 `path/project/ref/commit/reused`;`details` 返回同结构对象。

### 4. 校验与错误矩阵

| 条件 | 结果 |
|------|------|
| 未配置任何白名单来源 | throw `未配置跨项目上下文白名单...` |
| `project` / `group` 不在允许 namespace 内 | throw `不在跨项目上下文白名单内...` |
| 输入 URL、路径穿越、反斜杠 | throw `不能是 URL 或包含路径穿越` |
| `alias` 含路径分隔符或为 `.` / `..` | throw `alias 只能包含...` |
| `ref` 为空、以 `-` 开头或含空白 / `..` | throw `ref 不能为空或包含可疑路径片段` |
| `depth` 非整数或超出 1..100 | throw `depth 必须是 1 到 100 之间的整数` |
| 目标目录存在但不是 Git 仓库 | throw `目标目录已存在但不是 Git 仓库...` |
| `git` 执行失败 | throw `git 命令执行失败...`,错误信息必须 redact token |

### 5. 正常 / 基线 / 错误用例

- 正常:当前 MR 在 `digital-biz-projects/iqs/xhgj-iqs-boot`,先 `gitlab_list_group_projects({group:"digital-biz-projects/iqs",search:"harness"})`,再 `gitlab_list_project_branches({project:"digital-biz-projects/iqs/iqs-harness",search:"v1.4"})`,最后 prepare 到 `/tmp/review-context/repos/iqs-harness` 并用 `rg` 搜文档。
- 基线:已存在同 alias Git 仓库时允许复用,但必须 `remote set-url origin <repoUrl>`、`fetch` 指定 ref、`checkout --detach --force FETCH_HEAD`、`clean -fdx`。
- 错误:传 `http://gitlab.xhgjdev.com/group/repo.git`、`../../repo`、`alias="../repo"`、`ref="--upload-pack=sh"` 都必须拒绝。

### 6. 必需测试

- `workspace.test.ts`:覆盖白名单来源优先级、project/group 归一化、alias/ref/depth 安全校验、repo URL 不含 token。
- `workspace.test.ts`:覆盖 git Basic auth header 构造与错误信息脱敏,包括明文 token 和 base64 header。
- `cross-project-tools.test.ts`:覆盖 3 个工具注册、TSV 文本返回、非白名单拒绝、prepare 返回不含 token。
- `client.test.ts`:覆盖 `listGroupProjects` / `listProjectBranches` 请求路径 encode、query 参数和响应映射。
- 真实验证可选但推荐:用本地 PAT 对企业 GitLab 跑一次 `prepareProjectWorkspace("digital-biz-projects/iqs/iqs-harness","v1.4")`,确认能 checkout 到具体 commit。

### 7. 错误与正确示例

#### 错误

```typescript
await execFile("git", ["clone", `http://oauth2:${token}@gitlab/repo.git`, "/tmp/repo"]);
```

#### 正确

```typescript
await execFile("git", ["-C", target, "fetch", "--depth", "1", "origin", ref], {
	env: {
		...process.env,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`,
	},
});
```
