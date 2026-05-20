# Frontend Development Guidelines

> `@flower-ai/flower-code-reviewer` 的对外接口/入口层(CLI、prompt、skill 装配)开发规范。

---

## Overview

本项目是 Node.js / TypeScript 后端项目,**没有浏览器前端**。
本目录(`frontend/`)在本项目里重新解读为"**面向用户/调用方的入口层**":

| 通用前端概念 | 本项目对应物 |
|--------------|---------------|
| 页面 / 路由 | CLI 子命令、`process.argv` 解析(`src/args.ts`) |
| 组件 | 入口模块(`cli.ts`、`run.ts`、`extension.ts`) |
| Hook | pi 扩展工厂、`pi.on()` 事件订阅、`pi.registerTool()` |
| State Management | CLI 参数对象(`CliArgs`)、运行期上下文 |
| Accessibility | CLI 输出可读性、错误信息可操作性、`--help` 完整度 |
| Type Safety | TypeScript strict、`Type.Object` schema、参数 parse 校验 |

### 包定位

- 形态:**CLI 应用**,运行在 GitLab CI 容器内,跑完即退出
- 入口:`packages/flower-code-reviewer/src/cli.ts` → `dist/cli.js`(可执行 `flower-review`)
- 依赖:`@earendil-works/pi-coding-agent`(以 print 模式调 `piMain`)
- 触发:CI 注入 `CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID`,bot 评审 MR 并发评论

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | `src/` 目录布局与文件职责 |
| [Component Guidelines](./component-guidelines.md) | 入口模块(cli/run/extension)的拆分与签名约定 |
| [Hook Guidelines](./hook-guidelines.md) | pi 扩展工厂的注册顺序、`pi.on` 钩子用法 |
| [State Management](./state-management.md) | CLI 参数、环境变量、运行期上下文如何流转 |
| [Quality Guidelines](./quality-guidelines.md) | Biome 风格、强制要求与禁止模式 |
| [Type Safety](./type-safety.md) | TypeScript strict、`Type.Object` schema、`any` 的边界 |

---

## 写作目标

子 agent(`trellis-implement` / `trellis-check`)读完这些 spec 后应当能:

1. 知道 `cli.ts` → `run.ts` → `extension.ts` 的职责边界,不会把业务逻辑塞进 `cli.ts`
2. 写新工具时按 `defineTool({ name, label, description, parameters, execute })` 的标准结构
3. 不在 `cli.ts` / `run.ts` 里直接 console.log 评审意见(必须走 GitLab 工具;dry-run `--dry-run` 是例外)
4. 改 prompt 时知道必要的硬约束:
   - **severity 词表 = `blocker | major | minor`**(对齐 flower-tools-gitlab `severitySchema` 与 `comments/render.ts`,**禁止**残留旧词表 `info | warning | blocker`)
   - 工具优先(评论必须经 GitLab 工具发出)/ 不重复评论 / 第 4 条「禁止 `^/<quick-action>` 行」/ 第 7 条「每变更文件必读 `gitlab_get_file_content`」/ 第 8 条「diff 截断时必须写 N/M 截断说明」

---

## 关键设计点(2026-05-20 N2/N1/E1/E2/E3 沉淀)

### 1. 评论模板规范(Preset A · CodeRabbit-like)

- **行内评论 4 段式**:`_<emoji> <english severity>_ [severity:<level>]` 斜体首行(`🔴`/`🟠`/`🔵` 三档 emoji)+ 加粗中文标题 + 解释段(讲 why)+ `<details>` 包 reasoning(可选)+ `suggestion` 块(可选,失败则 fallback 普通 ```code``` 块)
- **整体评论 walkthrough**:整 body 包 `<details>` 默认折叠,内含「概要 / 文件变更表(file × churn × 总结)/ 行动建议」
- **`> [!caution]` alert 块版本降级**:启动期 `detectGitlabVersion` 探测一次;GitLab ≥ 17.10 用 `> [!caution]`,< 17.10 或探测失败(null)降级 `> ⚠️ **Caution**` blockquote
- **「无问题」轻量模板**:MR 干净时只发 2 行,避免刷屏
- **`[severity:<level>]` 前缀贴在 severity 标签行末尾**(`_🔴 Blocker_ [severity:blocker]`)— `scanForBlockers` 字面量匹配
- **模板样例**:5 个完整中文样例存于 `.trellis/tasks/05-20-code-reviewer-quality-and-pipeline/research/comment-style.md` §6.1-§6.6,prompt.ts 抄进 few-shot

### 2. GitLab 版本探测(`comments/gitlab-version.ts`)

- `detectGitlabVersion(client)`:`GET /api/v4/version` → 解析 `major.minor`,**module-level 三态缓存**(`undefined` 未探测 / `null` 探测失败 / `{major, minor}` 成功)
- 失败 fail-tolerant:无 token / HTTP 非 200 / 网络错 / 字段缺失全部归 null,**不抛错不阻塞主流程**
- `supportsAlertBlock(null) === false`(默认降级路径)
- `run.ts` 启动期 `await detectGitlabVersion()` 一次 + 传给 `buildPrompt({gitlabVersion})`,§6.6 alert 块模板根据版本动态切换(LLM few-shot 学到的就是正确版本写法)

### 3. Edge case 防御(E1/E2/E3/E5)

| Edge | 实现 | 文件 |
|------|------|------|
| **E1 · LLM 网关 fail open** | `isLlmFailure(err)` 5 级判定(AuthError 黑名单 / LLM 关键字 / 网络关键字 / HTTP 5xx 429 / 默认 fail close);LLM 失败 → `buildLlmFailureNotice` warning 评论 + `return exitCode: 0` 不阻塞 pipeline;**非 LLM 错误(AuthError / FileNotFoundError)正常抛**;但 `scanForBlockers` 触发的 blocker(已成功评出的)仍 fail close | `run.ts` |
| **E2 · MR diff size cap** | env `FLOWER_MAX_FILES`(默认 50);`applyDiffCap` 按 churn(additions + deletions)降序稳定排序取 top N;截断时 prompt 注入 `truncation: {shown, total}` → LLM 在 walkthrough 必须写「⚠️ 本次仅评 N/M 个最大变更文件,其余请手工 review」 | `run.ts` + `prompts.ts` |
| **E3 · quick action sanitize** | `sanitizeQuickActions(body)`(在 `@flower-ai/flower-tools-common`),50+ quick action 关键字 + 大小写不敏感;首字符 `/` → `&#47;`;flower-tools-gitlab 的 post 评论工具 execute 内 wrap;与 prompt 第 4 条硬约束形成**双层防御** | `flower-tools-common/src/sanitize.ts` + `flower-tools-gitlab/src/index.ts` |
| **E5 · 单文件 size cap + 二进制跳过** | `safeReadFile` wrapper 在 `flower-tools-gitlab/src/safe-read.ts` 工具层,`gitlab_get_file_content` execute 内 wrap;env `FLOWER_MAX_FILE_SIZE`(默认 51200);二进制按后缀(18 类)跳过;LLM 永远拿不到超 50KB 或二进制原始内容 | `flower-tools-gitlab/src/safe-read.ts` |
| **E4 · markdown 校验** | **延后**(remark 依赖较重);mitigation 暂留 prompt 5 个完整模板样例引导 LLM 复制 |

### 4. 评审 trace 单例 + 「无依据评论」blocker 拦截

- **`review-trace.ts` module-level 单例** `ReviewTrace`:`recordFileRead` / `recordLineComment` / `resetTrace` / `getTrace` / `findUnsupportedComments`
- `extension.ts` `pi.on('tool_call', ...)` 监听:`gitlab_get_file_content` 调用 → `recordFileRead` 累计 readFiles;`gitlab_post_line_comment` → `recordLineComment` 累计已发评论
- `run.ts` finalize 阶段(LLM 全部 tool call 完成后)调 `findUnsupportedComments(readFiles, lineComments)` → 若 line_comment 的 `path` ∉ `readFiles` → 拼 `[severity:blocker] 无依据评论:对 ${path} 发出评论但未读完整文件` 整体评论 post 一次 → `scanForBlockers({unsupportedCommentFiles})` 触发 exit 1
- **`scanForBlockers` 重载**:旧位置参数 `(beforeIds, after)` 兼容,新对象签名 `({beforeIds, after, unsupportedCommentFiles?})` 扩展;渐进迁移

### 5. 注册顺序(extension.ts)

`provider → compliance → tools(含 gitlab) → review-trace 监听`;review-trace 的 `pi.on(tool_call)` 必须挂在 gitlab tools `pi.registerTool` 之后才能拿到 tool_call event。

---

**语言**:本目录文档用中文,代码示例 / 文件路径 / 工具名保持英文。
