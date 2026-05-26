# flower 文档:intro.html 深度增强(单文件工程手册)

## 0. 任务历史(brainstorm 决策快照)

本任务最初是 `code-reviewer-detailed-html`(独立产出 `docs/code-reviewer-detailed.html`,微观讲 flower-code-reviewer)。

2026-05-22 brainstorm 后 scope 大幅扩张,**改为单文件 `docs/intro.html` 深度增强**:原 reviewer 详细内容(S1-S12)并入 intro 的 Part B 作为 B2 reviewer 节(高保真 inline),原独立 `code-reviewer-detailed.html` **不再产出**。任务身份(slug)随之 rename 为 `intro-html-deep-enhance`,复杂度从 lightweight 升级为 complex(三件套:`prd.md` + `design.md` + `implement.md`)。

8 个核心决策(brainstorm 已 lock):

1. **单文件**:`docs/intro.html`(原 `intro.html` `git mv` 到 `docs/`,然后深度增强)
2. **Part A 字符级保留 + Part B 工程手册末尾追加**(两段式)
3. **Part B 三节**:B1 pi 框架 4 维度 / B2 7 个 package 详细 / B3 跨包数据流
4. **B1 pi 4 维度全要**:API 表面 + 内部机制 + flower 集成 + 设计哲学/同类对比
5. **B2 reviewer 节是例外**:S1-S12 完整 inline(其它 6 个 package 5 字段短卡片 + 默认折叠)
6. **B1 + B3 默认展开,B2 默认折叠 + 摘要卡**
7. **高保真 self-contained**:prompts 工作流 7 步 / 6 个 few-shot / exit code 五级 / env 表全文 dump;预估文件 ≤300KB
8. **防漂移:接受 + 声明**:文档头加 commit 快照 marker;关键节末加源码链接(文件名 + 函数名锚点,不写死行号)

## 1. Goal

把 monorepo 文档从「intro.html 50KB 愿景诗」演化为「**单文件、自包含、≤300KB 工程手册**」。

读者收到一个 HTML 链接,**双击 / 浏览器 file:// 直接打开,无需 build / 无外部依赖**,就能读完:

- flower monorepo 的**架构愿景与设计哲学**(Part A,原 intro 7 节诗篇)
- **pi 上游框架**的 API 表面、内部运作机制、flower 怎么用它、与同类对比(Part B 第 1 节,B1)
- **7 个 package** 各自的职责 / 边界 / 对外契约 / 关键模块 / 与兄弟包的关系(Part B 第 2 节,B2)
- **flower-code-reviewer** 的完整操作手册:9+1 个内部源文件剖析 / prompts 工作流 7 步 / 6 个评论 few-shot 模板 / exit code 五级判定 / E1-E3 fail-open & 降级 / env 表 / GitLab CI 接入 / 容器与部署 / 已知局限(Part B 第 2 节 reviewer 节,inline 占大头)
- **跨包数据流**:LLM ↔ provider ↔ havefun 网关 / tool ↔ compliance 拦截 ↔ 执行 / observability 旁路 / SIEM 审计(Part B 第 3 节,B3)

### 不再产出(对比旧 PRD)

- ❌ `docs/code-reviewer-detailed.html` — 内容并入 intro Part B 的 B2 reviewer 节

### 文件最终位置

```
docs/
└── intro.html         ← `git mv` 移过来 + Part B 追加(单一最终产物)
```

## 2. 视觉与风格约束

### R1 · 沿用 intro.html 的设计语言

- 颜色令牌(`--bg`, `--ink`, `--accent` / 朱砂 / 墨绿 / 琥珀 / 靛青 / 紫罗兰)直接复用
- 字体栈(serif 用于标题 / sans 用于正文 / mono 用于代码)复用
- 顶部状态条 + section 标题样式延续学术手稿感
- 不引入新的 JS 框架 / CDN 依赖,**全部 inline 样式**

### R2 · 自包含 single file

- 单 HTML 文件,**双击可在浏览器打开**,无需 webpack / live-server
- 所有图示用 **纯 HTML + CSS + SVG**(不依赖 mermaid CDN);可手写少量 SVG 流程图
- 代码示例用 `<pre>` + 简单语法高亮 CSS(不引入 highlight.js)
- 折叠/展开用原生 `<details>` / `<summary>`,不写 JS

### R3 · 中文为主

- 全篇中文叙述(代码标识符 / 命令保持英文)
- 重要英文术语首次出现时用「中文(English)」格式

### R4 · Part A 字符级保留

- 原 `intro.html` 7 节(架构洋葱 / pi 是什么 / 同根不同枝 / 为什么这样设计 / 未来愿景 / 演进路径)**字符级不变**
- 改动只在文件末尾追加 Part B 区域(以及顶部 TOC 必要扩展)
- 用 `git diff -M` 可验证 Part A 部分为 rename,内容字符级零改动(允许的最小例外:顶部 `<title>` / TOC 锚点新增)

### R5 · 全文 TOC

- 文档顶部有 TOC(目录锚点),可快速跳到 Part A 各节 + Part B 各节(B1.1-B1.4 / B2.1-B2.7 / B3)
- TOC 自身用 fixed/sticky 或回到顶部按钮(纯 CSS,无 JS)

### R6 · Part A 与 Part B 视觉分界明显

- A → B 之间有清晰分界标识(顶部分卷状态条 / 视觉横向规则 / 大字标题「Part B · 工程手册」)
- reader 跨过分界时心智明显"换台"

### R7 · 高保真 inline(关键约束)

- B2 reviewer 节 S1-S12 全文 inline(不省略),包含:
  - `prompts.ts` §「工作流」**7 步全文 dump**(包括 alert 块降级 / severity 三档标签 / few-shot 4 段式模板说明)
  - **6 个 few-shot 模板字符级 dump**(原 reviewer-detailed S12)
  - exit code 五级判定 / `isLlmFailure` 决策树全文
  - env 表(完整列名 + 默认值 + 校验规则)
  - GitLab CI `.gitlab-ci.yml` 接入 yaml 示例 + `allow_failure` 取舍说明
  - 容器细节(Dockerfile 关键步骤 + `/usr/local/bin/flower-review` wrapper + 镜像跨网路径)
- B1 pi 框架节 inline `.d.ts` 关键签名片段(piMain / extension / hook 类型)

### R8 · 文档头加快照声明

文档 `<head>` 后加 metadata 注释:

```html
<!--
本文档反映 flower commit X (YYYY-MM-DD) 的状态快照。
最新源码以 GitHub 主分支为准。
源码 ↔ 文档漂移采取「接受 + 声明」策略,不强制同步。
-->
```

### R9 · 关键代码节末加源码链接

每个 dump 了源码内容的节(prompts 工作流 / 6 个 few-shot / extension factory / observability event / scanForBlockers 决策)末尾加:

```
源码:packages/flower-code-reviewer/src/prompts.ts §「工作流」
```

**用文件名 + 函数名 / 段落标题作为锚点,不写死行号**(行号会漂移)。

### R10 · pi 框架 4 维度全要(B1 内容范围)

- **B1.1 API 表面**:piMain / extension 工厂 / Hook 入参出参(来源:`.d.ts` + README)
- **B1.2 内部运作机制**:turn loop / message_update / tool_call / tool_execution_end 事件如何发(来源:`dist/*.js` 反推 + `docs/development.md` + 我们 `observability.ts` 监听这几个 event 的现有用法佐证)
- **B1.3 flower 怎么用 pi**:extension.ts 注册 5 个 GitLab tool + compliance 拦截 + observability;flower-providers 怎么注册 4 个 havefun-* provider;flower-compliance 怎么钩 ToolUse 前置(来源:本仓库源码,精确)
- **B1.4 设计哲学 / 与同类对比**:为什么 piMain + extension 形态;对比 cursor / cline / aider / claude-code / openai-agents-sdk;"agent 框架 vs agent SDK" 区别(来源:推理 + 同类工具调研)

## 3. 最终产物结构(逻辑视图)

```
docs/intro.html(单文件 ≤300KB)
│
├─ <head>
│    title / inline CSS / metadata 快照声明
│
├─ <body>
│    ┌────────────────────────────────────────────────────────────┐
│    │ TOC(全文目录,Part A + Part B 各级锚点)                    │
│    ├────────────────────────────────────────────────────────────┤
│    │ Part A · 愿景与架构(原 intro 字符级保留)                  │
│    │   A1. 架构 · 一座洋葱                                       │
│    │   A2. pi 是什么                                             │
│    │   A3. 同根不同枝                                            │
│    │   A4. 为什么这样设计                                        │
│    │   A5. 未来愿景                                              │
│    │   A6. 演进路径                                              │
│    ├──────── 视觉分界:Part B · 工程手册 ────────────────────────┤
│    │ B0. 引子 · 从诗进入手册(1-2 段导读)                       │
│    │                                                            │
│    │ B1. pi 框架深度分析(默认展开)                              │
│    │   B1.1 API 表面(piMain / extension / Hook)                │
│    │   B1.2 内部运作机制(turn loop / tool dispatch / event)    │
│    │   B1.3 flower 怎么用 pi(extension 工厂 / provider 注册)  │
│    │   B1.4 设计哲学 · 与同类对比                                │
│    │                                                            │
│    │ B2. 7 个 package 详细职责(默认折叠 + 摘要卡)              │
│    │   B2.1 flower-code-reviewer ★(展开,占大头,S1-S12 inline)│
│    │   B2.2 flower-providers                                    │
│    │   B2.3 flower-tools-gitlab                                 │
│    │   B2.4 flower-tools-common                                 │
│    │   B2.5 flower-tools-arms                                   │
│    │   B2.6 flower-compliance                                   │
│    │   B2.7 flower-ops-bot                                      │
│    │                                                            │
│    │ B3. 跨包数据流(默认展开)                                   │
│    │   B3.1 LLM 调用链:flower-code-reviewer → providers        │
│    │         → @earendil-works/pi-ai → havefun 网关             │
│    │   B3.2 tool dispatch:LLM tool_call → compliance 前置拦截  │
│    │         → flower-tools-gitlab REST                        │
│    │   B3.3 observability 旁路:event listener → 流式打印       │
│    │   B3.4 SIEM 审计:compliance 上报路径                       │
└─────────────────────────────────────────────────────────────────┘
```

## 4. Requirements(汇总,R1-R10 见 §2,以下补充内容性 R)

- **R11 · TOC 双层**:顶层 Part A / Part B;Part B 再展开 B1.1-B1.4 / B2.1-B2.7 / B3.1-B3.4
- **R12 · B2 reviewer 节内部 12 子节(对应原 PRD S1-S12)**:
  - S1 头部 · 一句话定位 + Quick Facts
  - S2 鸟瞰架构 · 触发链路图
  - S3 包依赖(在 B2 reviewer 节内,与 B3 总数据流呼应但不重复)
  - S4 9+1 个源文件剖析(cli.ts / args.ts / run.ts / prompts.ts / skill-selector.ts / extension.ts / observability.ts / review-trace.ts / comments/ + 补充 `reviewer-self-tools.ts`,原 PRD 漏了)
  - S5 评审工作流 7 步(prompts.ts §「工作流」字符级 dump)
  - S6 关键 features 已 ship:N1 真实代码上下文 / N2 评论质量 / E1 fail-open / E2 diff cap / E3 GitLab 版本降级 / severity 三档
  - S7 错误处理与 exit code(0/1/2 + isLlmFailure 五级判定)
  - S8 配置与环境变量表(12+ 项,完整)
  - S9 GitLab CI 接入(yaml + allow_failure 取舍)
  - S10 容器与部署(Dockerfile + wrapper + 跨网路径)
  - S11 已知局限与 roadmap(**截至 2026-05-22 实际状态;`reviewer-trace-noise-cleanup` 已合并,移出 known-issues**)
  - S12 评论模板 few-shot 字符级 dump(6 个)
- **R13 · B2 其它 6 个 package 统一 5 字段模板**:
  - 一句话定位
  - 职责(做什么)
  - 边界(不做什么)
  - 对外契约(导出的工具 / API / 命令)
  - 与兄弟包关系(谁依赖它 / 它依赖谁)
- **R14 · B3 跨包数据流图**:用 SVG 或 ASCII art 画 4 个子流(B3.1-B3.4)
- **R15 · 折叠默认值**:`<details open>` 控制
  - B1 4 子节 → `open`(默认展开)
  - B2 7 节 → 默认折叠;reviewer 节例外 → `open`(展开)
  - B3 4 子节 → `open`(默认展开)
- **R16 · Part A 不动**:不重新编排 Part A 7 节顺序,不改 Part A 文字,不增减 Part A 内容(仅允许顶部 TOC 锚点新增的微小 head 修改)

## 5. Acceptance Criteria

### AC1 · 文件 + 视觉

- [ ] AC1.1 新建 `docs/`;`git mv intro.html docs/intro.html`(保留 git rename 历史)
- [ ] AC1.2 Part A 7 节字符级保留(`git diff -M docs/intro.html` 显示为 rename + Part B 追加,Part A 区域 zero diff;允许 head 内 metadata + TOC 锚点的最小增量)
- [ ] AC1.3 Part B 三节(B0 / B1 / B2 / B3)全部落地;B1 有 4 子节;B2 有 7 节(reviewer 大头 + 6 短卡片)
- [ ] AC1.4 浏览器 file:// 打开无 console error,TOC 锚点跳转正常
- [ ] AC1.5 无外部 `<script src=...>` 加载外部 JS、无 `<link rel=stylesheet href=https://...>` 加载外部 CSS;文档中正文 `https://` GitHub 源码引用 / DingTalk 文档引用等"内容性外链"不算违规
- [ ] AC1.6 文件大小 ≤300KB
- [ ] AC1.7 折叠/展开交互全部用原生 `<details>` / `<summary>`,无 JS
- [ ] AC1.8 Part A 与 Part B 视觉分界线明显(顶部分卷状态条 / 大字标题 / 视觉横向规则其一)

### AC2 · 内容完整性

- [ ] AC2.1 Part A 6 节全部完整保留(A1-A6)
- [ ] AC2.2 Part B 引子(B0)1-2 段链接 A → B
- [ ] AC2.3 B1.1-B1.4 全部落地,每节有正文 + 必要图示
- [ ] AC2.4 B2.1 flower-code-reviewer S1-S12 全 12 子节落地(R12 列出)
- [ ] AC2.5 B2.2-B2.7 其它 6 个 package 统一 5 字段模板(R13 列出)
- [ ] AC2.6 B3.1-B3.4 跨包数据流 4 个子流,每个有图示
- [ ] AC2.7 reviewer 节 S5 工作流 7 步 / S12 6 个 few-shot 与 `prompts.ts` **字符级一致**(从源码 dump,非凭记忆)
- [ ] AC2.8 S8 env 表所有变量与 `flower-providers/src/env.ts` + `flower-code-reviewer/src/run.ts` 实际读的对得上
- [ ] AC2.9 S9 业务方 yaml 接入示例与 harness 模板 `.flower-code-review` job 实际行为对得上
- [ ] AC2.10 S11 已知局限**反映 2026-05-22 实际状态**(`reviewer-trace-noise-cleanup` 已合并,从 known-issues 移除;`walkthrough-blocker-consistency` 已合并,同理;`flower-providers-default-fallback` 已合并,同理)
- [ ] AC2.11 S4 列出 9 个文件 + `reviewer-self-tools.ts`(共 10 个源文件)

### AC3 · 可维护性

- [ ] AC3.1 全文中文为主,中英文混用风格与 intro.html 一致
- [ ] AC3.2 HTML 结构清晰(`<header>` / `<section>` / `<article>` 语义化标签,不堆 `<div>`)
- [ ] AC3.3 顶部 TOC 双层(Part A 顶层 + Part B 顶层 + Part B 二级)
- [ ] AC3.4 关键术语首次出现时给出**该术语在源码的文件 + 函数名锚点**(如「`scanForBlockers`(`run.ts`)」),**不写死行号**
- [ ] AC3.5 文档头有快照声明 metadata 注释(R8)
- [ ] AC3.6 每个 dump 源码内容的节末尾有源码链接(R9)

### AC4 · 校对(reader 视角)

- [ ] AC4.1 reader 能回答:「reviewer 怎么知道发现 blocker?」(指向 S7 + S2 触发链路)
- [ ] AC4.2 reader 能回答:「pi 的 extension 机制怎么工作?」(指向 B1.1 + B1.3)
- [ ] AC4.3 reader 能回答:「flower-providers 怎么挂上 pi 的 LLM 系统?」(指向 B1.3 + B2.2)
- [ ] AC4.4 reader 能回答:「LLM 网关挂了 reviewer 会怎样?」(指向 B2.1 S7 isLlmFailure 五级 + E1 fail-open)
- [ ] AC4.5 reader 能回答:「7 个 package 各自负责什么?」(指向 B2)
- [ ] AC4.6 没有事实错误(API / env / few-shot 模板要么准确要么标 ~大约~)
- [ ] AC4.7 没有装腔作势措辞;S11 已知局限诚实列出
- [ ] AC4.8 与同类工具对比(B1.4)不踩同行,但客观;flower 自己的不足也讲

## 6. Definition of Done

- HTML 文件双击可看,所有 AC 通过
- task.json 状态从 in_progress → completed
- 单 commit 提交(若拆分则按 Part A / B / docs 目录新建 / 三件套等合理拆;commit message 体现"intro.html 深度增强")
- 不需要 push 到 remote(本地评审完成即可,后续是否 push 由 user 决定)

## 7. Out of Scope

- ❌ 独立 `docs/code-reviewer-detailed.html`(并入 intro Part B 的 B2 reviewer 节;原 PRD S1-S12 降格为 B2.1 的内部子节)
- ❌ 多页面 / SPA / 双语版本 / 移动端响应式优化(intro 现有响应式即可)
- ❌ build script / pre-commit hook 自动 sync 源码 ↔ 文档(违背 R2 自包含)
- ❌ 强制 doc-source 行号同步(用文件名 + 函数名锚点,接受漂移)
- ❌ 其它 6 个 package 写 detailed.html(它们体量小,B2 5 字段卡片足够)
- ❌ 修改 Part A 7 节文字(只新增 Part B;顶部 TOC 锚点扩展不算修改 Part A 内容)
- ❌ 修改任何源代码(本任务只产出 HTML)
- ❌ `06-` 后续月份的功能演进文档(本任务只快照 2026-05-22 当前状态)
- ❌ pi-coding-agent 上游源码逆向到具体实现细节(B1.2 只到"event 怎么发"的颗粒度,不展开到 dist 反编译每行)
- ❌ 加 README / docs/index.md(intro.html 本身就是入口)

## 8. Risks

- ⚠️ **R-1 · 源码漂移**:文档写完后,后续改 reviewer / providers / pi 升级 会导致 inline 内容过期。
  **mitigation**:R8 文档头快照声明 + R9 节末源码链接(reader 知道有过时风险);S11 已知局限明示"截至 2026-05-22";维护者改源码后**酌情**更新文档,不强制。

- ⚠️ **R-2 · scope 膨胀失控**:Part B 越写越大,可能超 300KB。
  **mitigation**:R12 / R13 严格控制每节字段;reviewer 节用 `<details>` 折叠次级内容(比如 S12 6 个 few-shot 默认折叠仅展示一个完整版,其余 5 个折叠);AC1.6 卡在 ≤300KB,实施时监控文件大小,超过提前砍。

- ⚠️ **R-3 · B1.2 pi 内部机制反推不准**:dist 是 minified,可能反推出错。
  **mitigation**:优先看 `docs/development.md` + `.d.ts`(权威);只反推 dist 中能确认的部分;不确定处明示「~推测,以源码为准~」。

- ⚠️ **R-4 · B1.4 与同类对比可能踩到同行**:cursor / cline / aider 对比若写不当容易显得贬低。
  **mitigation**:AC4.8 要求客观,不踩同行;讲我们自己的 trade-off,不讲别人不好。

- ⚠️ **R-5 · Part A 字符级保留约束误伤**:某些必要的 head 修改(如 title / TOC 锚点)被严格判定为违反 AC1.2。
  **mitigation**:AC1.2 明示允许 head 内 metadata + TOC 锚点的最小增量;`git diff -M` 验证时人工 review 增量是否合理。

- ⚠️ **R-6 · sub-agent 派的研究内容不一致**:并行多个 research / implement sub-agent 可能产出风格不统一。
  **mitigation**:design.md 写清楚每节的 schema / 字段;主 agent 在 sub-agent 产出后做"风格统一打磨"步骤(implement.md 末尾的"视觉打磨"checklist 包括这一项)。

## 9. 关联任务 / 已合并 sibling

- **已合并**:`05-21-walkthrough-blocker-consistency` / `05-21-flower-providers-default-fallback` / `05-21-reviewer-trace-noise-cleanup`(本文档 S11 应反映这些已修复,不再列为 known-issues)
- **关联进行中**:`05-20-code-reviewer-auto-fix-bot`(planning;本文档 S11 / B2.1 可以提一句"未来演进方向 · auto-fix")
- **关联但 OOS**:任何独立 `code-reviewer-detailed.html` 思路 — 已 abandoned,内容并入 intro

## 10. Research References(留位,implement 阶段 sub-agent 产出后填)

研究将在 implement 阶段以 trellis-research sub-agent 并行派发,产物写入 `research/`:

- `research/pi-internal-mechanism.md` — B1.2 反推 dist + development.md(支撑 B1.2 内容)
- `research/pi-vs-peers.md` — B1.4 cursor / cline / aider / claude-code / openai-agents-sdk 对比(支撑 B1.4 内容)
- `research/packages-survey.md` — B2.2-B2.7 各 package 的职责 / 边界 / 关键模块抽取(支撑 B2 6 个短卡片)
- `research/cross-package-dataflow.md` — B3 4 个数据流的实际代码路径梳理(支撑 B3 图示)
