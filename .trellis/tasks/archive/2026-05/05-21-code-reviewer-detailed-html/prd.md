# flower-code-reviewer · 详细架构与实现细节的 HTML 文档

## 0. 触发场景

仓库根目录已经有 `intro.html`(50KB / 1382 行)讲整个 **flower monorepo** 宏观:洋葱式架构、pi 是什么、同根不同枝、设计哲学、未来愿景、演进路径。

现在需要**放大镜**聚焦到 `packages/flower-code-reviewer/` 这一个包 — **从触发链路到内部实现到错误处理**全面讲透,作为接入方 / 维护者 / 后续 contributor 的单点权威文档。

## 1. Goal

产出一份**单文件、自包含、浏览器直接可看**的 HTML(无外部 JS/CSS 依赖,inline 样式),把 flower-code-reviewer **从外部接入视角到内部实现细节**完整阐述清楚,让读者**不用读代码也能拿到 80% 的信息**。

**2026-05-27 变更确认**:用户明确说明本任务的已实现载体是 `docs/intro.html`,不是另起 `docs/code-reviewer-detailed.html`。因此本任务改为在增强版 `docs/intro.html` 的 B2.1 章节内 inline 完成 flower-code-reviewer S1-S12 操作手册,并验收该章节的事实准确性与可读性。

**同时**:把现有的 `intro.html` 搬进新建的 `docs/` 目录,以后所有 HTML 类长文档都集中在 `docs/`,**避免根目录散落**。

### 文件最终位置

```
docs/                                  ← 新增,所有 HTML 长文档归口
└── intro.html                         ← 从仓库根移动后增强;B2.1 内含 flower-code-reviewer S1-S12
```

`intro.html` 现在没有任何代码 / md 引用它(已 grep 确认),安全移动不会破链接。

## 2. 视觉与风格约束

### R1 · 沿用 intro.html 的设计语言

- 颜色令牌(`--bg`, `--ink`, `--accent`/朱砂 / 墨绿 / 琥珀 / 靛青 / 紫罗兰)直接复用
- 字体栈(serif 用于标题 / sans 用于正文 / mono 用于代码)复用
- 顶部状态条 + section 标题样式延续学术手稿感
- 不引入新的 JS 框架 / CDN 依赖,全部 inline 样式

### R2 · 自包含

- 单 HTML 文件,**双击可在浏览器打开**,无需 webpack / live-server
- 所有图示用 **纯 HTML + CSS + SVG**(不依赖 mermaid CDN);可手写少量 SVG 流程图
- 代码示例用 `<pre>` + 简单语法高亮 CSS(不引入 highlight.js)

### R3 · 中文为主

- 全篇中文叙述(代码标识符 / 命令保持英文)
- 重要英文术语首次出现时用「中文(English)」格式

## 3. 内容大纲(必备 sections)

### S1 · 头部 · 一句话定位 + Quick Facts

- 一句话定位:"GitLab MR 自动评审 agent,跑在 CI 容器里,基于 pi-coding-agent + 4 个 havefun LLM provider,产出 GitLab 行内评论 + walkthrough 整体评论。"
- Quick facts 卡片:
  - 输入:`CI_MERGE_REQUEST_IID`、4 个 secret 环境变量
  - 输出:GitLab MR 行内评论 + 整体评论 + exit code
  - 跑在:Alpine Linux Docker 容器(Node 22)
  - 触发:GitLab Runner,**仅 MR pipeline**
  - exit code:0 / 1 / 2 各自含义

### S2 · 鸟瞰架构 · 触发链路

完整请求链路图(SVG 或 ASCII art):

```
开发者 push MR → GitLab → Runner spawn 容器 → /usr/local/bin/flower-review
→ piMain(prompt) → LLM(havefun 网关)
→ tool_call(gitlab_get_mr_files / get_mr_diff / get_file_content / post_*)
→ scanForBlockers → exit 0/1
```

- 标出**容器内 vs 容器外**的边界
- 标出**LLM 网关 vs GitLab API** 的两个外部依赖
- 标出**compliance 拦截 / observability 日志**的横切关注点

### S3 · 包依赖关系

横向依赖图,展示 `flower-code-reviewer` 与其他兄弟包的关系:

| 兄弟包 | 用来做什么 |
|---|---|
| `flower-providers` | 注册 4 个 havefun-* LLM provider;翻译 env 到 pi CLI argv |
| `flower-tools-gitlab` | 6 个 GitLab REST tool(`gitlab_get_mr_files` / `gitlab_get_mr_diff` / `gitlab_get_file_content` / `gitlab_get_previous_review` / `gitlab_post_comment` / `gitlab_post_line_comment`) |
| `flower-tools-common` | zentao_search / dingtalk_doc_search(stub,跨产品共享) |
| `flower-compliance` | ci-readonly 模式:写工具禁用 / bash 白名单 + SIEM 审计 |
| `@earendil-works/pi-coding-agent` | 上游 agent 框架,提供 piMain / extensions / 内置 read/bash/edit/write 工具 |

### S4 · 内部模块剖析

每个核心文件一节,解释**做什么 / 关键设计点 / 何时被调**:

| 文件 | 节标题 | 重点 |
|---|---|---|
| `cli.ts` | 入口与 exit code | argv 解析、顶层 catch-all → exit 2 |
| `args.ts` | CLI 参数 | `--mr-iid` / `--skill` / `--dry-run` |
| `run.ts` | 评审 orchestration | 9 步主流程、scanForBlockers、isLlmFailure、E1 fail-open、E2 diff cap |
| `prompts.ts` | prompt 构造 | 7 步工作流、severity 三档、CodeRabbit-like 4 段式模板、alert 块降级 |
| `skill-selector.ts` | skill 自动选 | 4 个 skill(general / backend / frontend / security)与触发关键字 |
| `extension.ts` | pi 扩展工厂 | provider / compliance / tools / observability / review-trace 注册顺序 |
| `observability.ts` | 流式打印 | turn_start / message_update / tool_execution_end 事件监听 |
| `review-trace.ts` | tool call 追踪 | recordFileRead / recordLineComment / findUnsupportedComments(N1 落地) |
| `comments/` | GitLab 版本探测 | detectGitlabVersion / supportsAlertBlock(17.10+) |

### S5 · 评审工作流(prompt 里给 LLM 的 7 步)

把 prompts.ts §「工作流」逐字搬过来,加注释解释每一步**为什么这么编排**:

1. `gitlab_get_previous_review` 看历史避免重复
2. `gitlab_get_mr_files` 列文件
3. `gitlab_get_mr_diff` 看 diff
4. **每个变更文件必读** `gitlab_get_file_content`(N1 落地的硬约束)
5. 可选 · 拉相关上下文
6. `gitlab_post_line_comment` 发行内评论
7. `gitlab_post_comment` 发整体 walkthrough

### S6 · 关键 features 与已 ship 落地

每个 feature 一卡片,标出**为什么需要 / 怎么实现 / 落地 commit**:

- **N2 评论质量**:CodeRabbit-like 4 段式 + walkthrough 折叠模板,prompts.ts few-shot 固化
- **N1 真实代码上下文 + 无依据评论拦截**:LLM 必须先 `get_file_content` 再评行,否则 scanForBlockers 拦为 blocker
- **E1 LLM 网关 fail-open**:isLlmFailure 分类 → 发 warning 评论 + exit 0,不阻塞业务方 pipeline
- **E2 MR diff cap**:`FLOWER_MAX_FILES` 默认 50,超 cap 按 churn 排序取 top N + walkthrough 提示截断
- **E3 GitLab 版本降级**:`> [!caution]` alert 块仅 17.10+ 支持,旧版本自动降级 blockquote
- **severity 三档 + HTML 注释 marker**:`<!-- severity: blocker -->` 藏在 body 里供 scanForBlockers 识别,UI 不显示

### S7 · 错误处理与 exit code 语义

- `exit 0`:评审完成,无 blocker(或 LLM 网关失败 fail-open)
- `exit 1`:至少一个 blocker 被检测到(scanForBlockers 命中)
- `exit 2`:cli.ts 顶层 catch-all(配置错 / GitLab API auth 错 / 不可恢复)
- `isLlmFailure` 五级判定:
  1. AuthError / FileNotFoundError → 非 LLM 失败(fail-close)
  2. 关键字 llm/provider/anthropic/openai/... → fail-open
  3. 网络 / 超时关键字 → fail-open
  4. HTTP 5xx / 429 → fail-open
  5. 其他 → fail-close

### S8 · 配置与环境变量

完整 env 表 + 默认值 + 校验规则:

| 变量 | 必需 | 默认 | 含义 |
|---|---|---|---|
| `CI_MERGE_REQUEST_IID` | 是(或 `--mr-iid`) | - | MR IID |
| `CI_PROJECT_ID` | 是 | - | GitLab project id |
| `GITLAB_TOKEN`(实际从 `REVIEWER_BOT_TOKEN` 注入) | 是 | - | GitLab API token,`api` scope |
| `LLM_BASE_URL` | 是 | - | havefun 网关根 URL |
| `LLM_API_KEY` | 是 | - | havefun 网关 key |
| `LLM_PROVIDER` | 否 | havefun-openai-responses | havefun-anthropic / -openai / -openai-responses / -gemini |
| `LLM_MODEL` | 否 | gpt-5.5 | BUILTIN_MODELS 中的 id |
| `LLM_REASONING_EFFORT` | 否 | high | off/minimal/low/medium/high/xhigh |
| `SIEM_INGEST_URL` | 否 | - | 审计上报 endpoint |
| `FLOWER_MAX_FILES` | 否 | 50 | diff cap |
| `FLOWER_MAX_FILE_SIZE` | 否 | 51200 | 单文件 byte 上限 |
| `FLOWER_VERBOSE` | 否 | (开)| `0/false/off/no` 关 observability |

### S9 · GitLab CI 接入(给业务方看的)

业务方 `.gitlab-ci.yml` 最简接入 + 常见 override:

```yaml
include:
  - project: 'digital-rd-infra/devops-infra'
    file: '/templates/projects/application.yml'

code-review:
  extends: .flower-code-review
  # 可选 override:
  # variables:
  #   LLM_MODEL: claude-opus-4-7
  #   LLM_REASONING_EFFORT: xhigh
  #   FLOWER_MAX_FILES: '30'
  # allow_failure: false   # 强约束:blocker 真挡合并(默认 advisory)
```

加段子解释 `allow_failure: true` 默认 advisory vs 显式 strict 的取舍。

### S10 · 容器与部署

- Dockerfile 关键步骤(node:22-alpine builder + 砍 devDeps + koffi 多架构裁剪)
- `/usr/local/bin/flower-review` wrapper(让 GitLab CI script 模式可调)
- 镜像跨网路径(GitHub flower → 内网 GitLab mirror → Harbor build → 业务方 image:pull)— 引用过去任务的成果

### S11 · 已知局限与 roadmap

- walkthrough alert 块 blocker 列表与 line_comment 数不一致(2026-05-21 发现,有 sibling task)
- env 缺省 fallback 不走 havefun 网关(2026-05-21 发现,有 sibling task)
- LLM 不识别 GitLab `ref=HEAD`(2026-05-21 发现,有 sibling task)
- bash 白名单过严 — `nl` `jq` `sort` 等只读工具被拦(同上)
- minor 评论容易被 blocker / major 淹没

### S12 · Appendix · 评论模板 few-shot

把 prompts.ts §「模板示例」6 个 few-shot 全文 dump 到附录,用代码块呈现,便于读者按图索骥。

## 4. Acceptance Criteria

### AC1 · 文件 + 视觉

- [ ] **AC1.1** 新建 `docs/` 目录;增强版文档位于 `docs/intro.html`
- [ ] **AC1.2** 根目录不再散落 `intro.html`;最终只有 `docs/intro.html`
- [ ] **AC1.3** `docs/intro.html` 保持单文件自包含,可通过浏览器 `file://` 直接打开
- [ ] **AC1.4** `docs/intro.html` 能完整渲染,无 console error
- [ ] **AC1.5** flower-code-reviewer B2.1 章节与 intro.html 整体视觉语言一致(颜色令牌、字体栈、顶部状态条样式 reuse)
- [ ] **AC1.6** 无外部 JS / CSS / 字体 / mermaid CDN 依赖;允许普通 `<a href="https://...">` 引用链接和代码示例里的 URL
- [ ] **AC1.7** 文件大小合理(当前工程手册约 250KB,允许包含 monorepo 宏观 + reviewer 深挖章节)

### AC2 · 内容完整性

- [ ] **AC2.1** `docs/intro.html` 的 B2.1 中 S1-S12 全部 sections 落地,每节有正文 + 必要图表
- [ ] **AC2.2** 9 个内部源文件每个都有专节解释(S4 全覆盖)
- [ ] **AC2.3** S2 触发链路图 + S3 包依赖图 至少各 1 张(SVG 或 ASCII art)
- [ ] **AC2.4** S8 env 表所有变量与代码 `flower-providers/src/env.ts` + `flower-code-reviewer/src/run.ts` 实际读的对得上
- [ ] **AC2.5** S9 业务方接入示例与 harness 模板 `.flower-code-review` job 实际行为对得上
- [ ] **AC2.6** S12 6 个 few-shot 与 `prompts.ts` 中的模板**字符级一致**(从源码 dump 而非凭记忆写)

### AC3 · 可维护性

- [ ] **AC3.1** 全文中文为主,中英文混用风格与 intro.html 一致
- [ ] **AC3.2** HTML 结构清晰(`<header>` / `<section>` / `<article>` 语义化标签,不用 `<div>` 堆砌)
- [ ] **AC3.3** 文档目录中可进入 B2.1;B2.1 内每个 S1-S12 有稳定锚点
- [ ] **AC3.4** 关键术语首次出现时**直接给出该术语在源码的路径**(如「`scanForBlockers`(`run.ts:169`)」),便于读者从文档跳到源码

### AC4 · 校对

- [ ] **AC4.1** 任一同事 / 用户视角读完后,能回答出"reviewer 怎么知道发现 blocker?" / "新业务方怎么接入?" / "LLM 网关挂了会怎样?"
- [ ] **AC4.2** 没有事实错误(关键 API / env / 行号引用要么准确要么标 ~大约~)
- [ ] **AC4.3** 没有装腔作势的"绝对完美"措辞,**已知局限 S11 必须诚实列出**

## 5. Out of Scope

- ❌ 自动化构建脚本(让 CI 跑 HTML lint / 链接检查 等)— 本任务先有静态产物
- ❌ 多页面 / SPA / 双语版本 — 单文件中文为主即可
- ❌ 与 intro.html 合并 — 两份文档保持职责分离(intro 宏观、本文档微观),都进 `docs/` 并存
- ❌ 跨包的 flower-providers / flower-tools-gitlab / flower-compliance 详细文档 — 本任务**只**讲 flower-code-reviewer,其他包仅引用边界
- ❌ 另建 `docs/code-reviewer-detailed.html` — 用户已确认实现载体是 `docs/intro.html`
- ❌ 给 `docs/` 加 README / index.md — `intro.html` 本身就是入口,不重复造

## 6. Risks

- ⚠️ **源码漂移**:文档写完后,后续改 reviewer 代码会导致行号 / API / few-shot 漂移。**mitigation**:AC3.4 要求关键术语带源码路径但**不写死行号**(行号会变);用文件名 + 函数名作为锚点。
- ⚠️ **范围膨胀**:文档容易越写越大,失去焦点。**mitigation**:S1-S12 是上限,**不**再往外扩;深入到具体行业务规则的地方就**链接源码**而不是 inline 复制。
- ⚠️ **HTML 单文件维护成本**:50KB+ HTML 改起来不像 Markdown 那么轻。**mitigation**:可以在文档里加注释 `<!-- 维护提示:本文件由 .trellis/tasks/05-21-code-reviewer-detailed-html 任务产出,改前请熟悉 reviewer 源码 -->`。

## 7. 关联任务

- intro.html 是兄弟文档(整个 flower monorepo 视角)
- 3 个 sibling 修复任务都会被本文档 S11 引用:
  - `05-21-walkthrough-blocker-consistency`
  - `05-21-flower-providers-default-fallback`
  - `05-21-reviewer-trace-noise-cleanup`
