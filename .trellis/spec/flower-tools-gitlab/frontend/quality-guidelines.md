# Quality Guidelines

> `flower-tools-gitlab` 的代码质量底线。

---

## Forbidden Patterns

### ❌ 新增非 MR 评论的写操作

```typescript
// 错误:不允许
export const gitlabUpdateMrTitleTool = defineTool({ name: "gitlab_update_mr_title", ... });
export const gitlabMergeMrTool = defineTool({ name: "gitlab_merge_mr", ... });
```

**严格限制**:只允许 `gitlab_post_comment` / `gitlab_post_line_comment` 两个写工具。
其他写操作走人工或独立工单流程,LLM 不应该有这个能力。

### ❌ 暴露写 issue / 写 commit / 写 wiki 等其他写工具

同上,本包只服务 MR 评审。

### ❌ severity 增加档位

```typescript
// 错误
const severitySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("blocker"),
  Type.Literal("critical"),  // ❌ 新增
]);
```

三档是契约,改要先改 `code-reviewer/prompts.ts` 和 pipeline 失败策略。

### ❌ `readEnv()` 在 module-level 顶层调用

```typescript
// 错误
const { projectId, mrIid } = readEnv();  // module 顶层
```

让 `import` 本包就需要 CI env。必须在 `execute` 内调用。

### ❌ 客户端在 `import` 时初始化

```typescript
// 错误
const cachedClient: GitlabClient = createStubClient(...);  // 立即初始化
```

必须惰性,通过 `gitlabClient()` getter。

### ❌ 评论 body 拼接用户输入未转义

```typescript
// 错误(虽然 Markdown 是用户内容,但要防 XSS / 注入)
await postMrComment(..., `<script>${userInput}</script>`, ...);
```

LLM 生成的评论 body 本身就是 Markdown,放心传给 GitLab。
**但是**:从 `gitlab_get_previous_review` 拿回来的评论文本,**不要**反过来用 `eval` / `Function()` 解析。

### ❌ 在工具实现里硬编码 GitLab URL

```typescript
// 错误
const url = "https://gitlab.com/api/v4/...";
```

通过 `gitlabClient()` 透传 `GITLAB_HOST`。

---

## Required Patterns

### ✅ 工具命名:`get_*` 只读,`post_*` 写

参考 `src/index.ts:1-9` 注释。新工具按此命名,易于检视职责。

### ✅ `severity` 必带

所有 `post_*` 工具的参数必含 `severity: severitySchema`。

### ✅ `readEnv()` 集中读 CI env

不要散落到各工具里。

### ✅ `gitlabClient()` 惰性单例

### ✅ 公开 API 必有 JSDoc

每个工具 / `registerGitlabTools` / `gitlabClient` 上方必有中文 JSDoc。

---

## Testing Requirements

- `npm run typecheck`
- `npm run check`
- `npm run build`

真实接入 GitLab API 时:

- [ ] 用测试 GitLab 实例 + 真实 token,跑通 `--dry-run` 评审
- [ ] 跑通"先发评论 → 再 `gitlab_get_previous_review` 拉到刚发的"
- [ ] 评论 markdown 渲染正确(代码块、列表、表格)
- [ ] 行内评论真的绑定到对的 file + line

---

## Code Review Checklist

- [ ] 新工具是否写操作?如果是,只能是 MR 评论
- [ ] 工具 name 是否 `gitlab_<verb>_<noun>` snake
- [ ] 是否更新了 `registerGitlabTools` 集中入口
- [ ] severity 是否仍是三档
- [ ] `readEnv()` 是否在 `execute` 内调用
- [ ] `gitlabClient()` 是否惰性
- [ ] 是否硬编码 GitLab URL
- [ ] 真实接入时,client 方法的 endpoint / 鉴权方式是否符合 GitLab REST API 规范
