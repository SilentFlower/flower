# 优化 GitLab MR 行内评论定位

## Technical Design

### 变更边界

- `packages/flower-tools-gitlab/src/client.ts`
  - 为 diff 输出增加新文件行号标注。
  - 抽出可评论行解析结果，供行号校验、重定位和 fallback 文案复用。
  - 增强 `postMrLineComment`：exact match 仍优先；不可评论时按保守策略重定位或降级。
- `packages/flower-code-reviewer/src/prompts.ts`
  - 强化模型约束：行内评论行号必须来自 MR diff 的可评论行号标记。
- 单测
  - `flower-tools-gitlab/src/__tests__/client.test.ts` 覆盖 parser、重定位、fallback。
  - `flower-code-reviewer/src/__tests__/prompts.test.ts` 覆盖 prompt 约束文案。

### Diff 行号标注

保留 unified diff 的文件头和 hunk 结构，但把 hunk 内行渲染为带新文件行号和类型的文本：

```text
@@ -296,6 +304,15 @@ export function normalizeTaskExportSelectedFields(fields: string[]): string[] {
  304 ctx      );
  305 ctx  }
  306 ctx
+ 307 add  export function normalizeTaskExportImageFields(fields: string[]): string[] {
```

原则：
- 新增行和上下文行有 `new_line`，可作为 `gitlab_post_line_comment.line`。
- 删除行没有 `new_line`，保留旧行号或标记为 `del`，但不作为可评论新行。
- 行号标注只影响给模型看的 `getMrDiff` 文本，不改变 GitLab `/changes` 原始 diff 缓存。

### 可评论行模型

新增内部结构：

```typescript
interface CommentableLine {
	line: number;
	kind: "add" | "context";
}
```

解析规则沿用现有 `collectCommentableNewLines`：
- hunk 头 `+<start>` 初始化新文件行号。
- `+` 行和空格上下文行记录为可评论行，并推进新文件行号。
- `-` 删除行不记录、不推进新文件行号。
- `\ No newline...` 和空行按现有语义跳过。

`collectCommentableNewLines` 可保留为兼容导出函数，内部复用新解析函数。

### 自动重定位策略

`postMrLineComment` 执行顺序：

1. 找到同文件变更，解析可评论行。
2. 如果 `input.line` 在可评论集合中，按原逻辑发 GitLab discussion。
3. 如果不可评论，查找最近可评论行。
4. 仅当最近距离 `<= 12` 行时允许重定位。
5. 含 `suggestion` 代码块时不直接带 suggestion 重定位，避免 GitLab 把 patch 应用到错误行。
6. 其余情况降级普通 note，文案包含原因和候选行。

重定位正文前缀：

```text
定位调整：原目标 `src/a.ts:295` 不在 MR diff 可评论行中，已挂到最近可评论行 `src/a.ts:307`。
```

`LineCommentResult` 增加可选字段：

```typescript
{
	posted: "line" | "note_fallback";
	reason?: string;
	originalLine?: number;
	actualLine?: number;
	relocated?: boolean;
}
```

### Suggestion 安全策略

默认采用安全优先：

- 如果目标行可评论：保留 `suggestion`，按原位置发送。
- 如果目标行不可评论且 body 含 ````suggestion`：不重定位为行内评论，降级普通 note。
- fallback 文案说明“评论包含 suggestion，未自动重定位，避免建议应用到错误行”。

后续若需要更积极策略，可以把 `suggestion` 代码块改成普通代码块后重定位，但本任务不做。

### Fallback 诊断文案

降级普通评论正文：

```text
原计划行内评论位置不可用：`src/a.ts:295`。
原因：目标行不在 MR diff 的可评论 new_line 中。
最近可评论行：`src/a.ts:304`、`src/a.ts:307`、`src/a.ts:308`。

<原评论正文>
```

候选行取距离目标最近的 3 个可评论行，按距离优先、行号升序稳定输出。

## Rollout / Rollback

- 该变更只影响 reviewer 评论定位和展示，不影响业务仓代码。
- 若重定位行为出现误挂，可通过配置或代码快速回退到 exact match + fallback 旧策略。
- 需要重点观察含 suggestion 的评论是否仍保持安全降级。
