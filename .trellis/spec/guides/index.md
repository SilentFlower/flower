# Thinking Guides

> **Purpose**: Expand your thinking to catch things you might not have considered.

---

## Why Thinking Guides?

**Most bugs and tech debt come from "didn't think of that"**, not from lack of skill:

- Didn't think about what happens at layer boundaries → cross-layer bugs
- Didn't think about code patterns repeating → duplicated code everywhere
- Didn't think about edge cases → runtime errors
- Didn't think about future maintainers → unreadable code

These guides help you **ask the right questions before coding**.

---

## Available Guides

| Guide | Purpose | When to Use |
|-------|---------|-------------|
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Identify patterns and reduce duplication | When you notice repeated patterns |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Think through data flow across layers | Features spanning multiple layers |
| [Debugging LLM Integration](./debugging-llm-integration.md) | LLM 网关接入"streaming 错误"类问题的决策树(先 curl 网关再怀疑 SDK 配置) | 接入新 LLM 网关时拿到 parser 错误 / 空响应 / 404 |
| [GitLab REST Debugging](./gitlab-rest-debugging.md) | 用环境变量 token 查询 MR、评论、diff、pipeline 的排查清单 | 用户给 GitLab 链接并授权使用环境变量 token 时 |

---

## 跨层模式索引(2026-05-20 N2/N1/E1/E2/E3 沉淀)

以下为本次 code-reviewer 任务收口时识别的可复用跨层模式,具体落地见对应 spec / 任务 design:

### 模式 1 · LLM 网关 fail open(评审失败退化)

- **问题**:LLM 网关抖动 / 限流 / 5xx → 整个评审 fail close 让 pipeline 阻塞,业务方愤怒
- **方案**:`run.ts` 顶层 try/catch + `isLlmFailure(err)` 5 级判定;LLM 失败 → 退化为 1 条 warning 评论说明「评审失败请手工 review」+ `exitCode = 0` 不阻塞;但 `scanForBlockers` 已成功识别的 blocker 仍 fail close
- **关键**:`isLlmFailure` 必须区分 LLM 失败 vs GitLab API 失败(后者应 fail close);判定基于 error 类名 + HTTP status + message 关键字综合
- **落地**:`packages/flower-code-reviewer/src/run.ts`(`isLlmFailure` / `buildLlmFailureNotice`)
- **测试 case**:mock LLM 抛 LlmNetworkError → warning 评论 post + exit 0;mock AuthError → 正常抛(fail close)

### 模式 2 · 评审 trace 单例 + 「无依据评论」拦截

- **问题**:LLM 不读源代码瞎评论 → 评论质量低 + 业务方失信
- **方案**:module-level 单例 `ReviewTrace` 累计 `readFiles: Set<path>` 和 `lineComments: Array<{path}>`;extension.ts `pi.on('tool_call', ...)` 监听 `gitlab_get_file_content` 调用记录 readFiles,`gitlab_post_line_comment` 调用记录 lineComment;finalize 阶段(LLM 全部 tool call 完成后)算 `unsupportedFiles = lineComments.path - readFiles`,有则拼 blocker 整体评论 + 触发 scanForBlockers exit 1
- **关键**:**module-level 单例**(不是依赖注入)是因为 pi-coding-agent 框架的 tool dispatch 不易传上下文;`resetTrace()` 在 run.ts 启动期调用避免污染连续运行
- **落地**:`packages/flower-code-reviewer/src/review-trace.ts` + `extension.ts` 注册顺序 `tools → review-trace 监听`
- **测试 case**:mock LLM 不调用 `gitlab_get_file_content` 就发 line_comment → scanForBlockers 返回 ≥ 1 个「无依据评论」blocker

### 模式 3 · 跨包 utility 收敛(common-up)

- **问题**:每个 tools-* package 各写一份 sanitize / encoding / time helpers → DRY 违反 + 修复不同步
- **方案**:通用纯函数 utility 统一放 `flower-tools-common`;下游 package 通过 `@flower-ai/flower-tools-common` workspace dep + tsconfig `references` 引用
- **关键**:**抑制 helper 在 caller 包里就地写**(即使「就一个 caller」);如果一段函数可能被 sibling package 也用到,就直接放 common
- **落地**:本次 `sanitizeQuickActions` 从 flower-code-reviewer 上移到 flower-tools-common(sibling `code-reviewer-auto-fix-bot` 也会复用)
- **判定标准**:utility 是不是纯函数(无 IO / 无副作用)+ 是不是与具体 package 业务无关 → 是 → common

---

## Quick Reference: Thinking Triggers

### When to Think About Cross-Layer Issues

- [ ] Feature touches 3+ layers (API, Service, Component, Database)
- [ ] Data format changes between layers
- [ ] Multiple consumers need the same data
- [ ] You're not sure where to put some logic

→ Read [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md)

### When to Think About Code Reuse

- [ ] You're writing similar code to something that exists
- [ ] You see the same pattern repeated 3+ times
- [ ] You're adding a new field to multiple places
- [ ] **You're modifying any constant or config**
- [ ] **You're creating a new utility/helper function** ← Search first!

→ Read [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md)

### When to Think About LLM Integration Debugging

- [ ] 接入新 LLM 网关首次跑通
- [ ] `pi-ai streamSimple` / `complete` 报 `Incomplete JSON segment` / `Stream ended without finish_reason` / done event 内容空
- [ ] "流式响应看起来收到了但 text 是空字符串"
- [ ] 怀疑 SDK 与网关 SSE 不兼容(先验证不是路径问题再说)

→ Read [Debugging LLM Integration](./debugging-llm-integration.md)

### When to Think About GitLab REST Debugging

- [ ] 用户给了 GitLab MR / pipeline / job 链接
- [ ] 用户说明可以用环境变量里的 GitLab token
- [ ] 需要确认 reviewer 评论、行内位置、diff refs 或 pipeline 状态
- [ ] 需要删除旧 bot 评论或触发 reviewer 重跑前做备份

→ Read [GitLab REST Debugging](./gitlab-rest-debugging.md)

---

## Pre-Modification Rule (CRITICAL)

> **Before changing ANY value, ALWAYS search first!**

```bash
# Search for the value you're about to change
grep -r "value_to_change" .
```

This single habit prevents most "forgot to update X" bugs.

---

## How to Use This Directory

1. **Before coding**: Skim the relevant thinking guide
2. **During coding**: If something feels repetitive or complex, check the guides
3. **After bugs**: Add new insights to the relevant guide (learn from mistakes)

---

## Contributing

Found a new "didn't think of that" moment? Add it to the relevant guide.

---

**Core Principle**: 30 minutes of thinking saves 3 hours of debugging.
