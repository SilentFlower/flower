# design.md · intro.html 深度增强

## 1. 总体技术设计

### 1.1 单文件 self-contained 约束(R2)

- 输出物只有一个 `docs/intro.html` 文件
- 无 build step,reader 双击或 `xdg-open` / `open` 直接看
- 不引入任何外部资源:**不 `<script src=https://...>` 加载 JS、不 `<link rel=stylesheet href=https://...>` 加载 CSS、不嵌入字体 CDN、不依赖 mermaid / highlight.js**
- 文档正文里出现 `https://github.com/.../foo.ts` 这类**内容性外链**(供 reader 跳转到源码)是允许的,**不算违背 R2**(因为没有它,reader 也能正常读文档,只是失去"跳到源码"的便利)
- 所有交互(折叠/展开)用原生 `<details>` / `<summary>`,不写 JS;TOC 锚点用 `<a href="#anchor">` 跳转

### 1.2 两段式结构:Part A 字符级保留 + Part B 末尾追加

- 原 `intro.html` 7 节(architecture-onion / pi-is-what / same-root-different-branch / why-this-design / future-vision / evolution-path)字符级保留
- 唯一允许的 Part A 区域微小修改:
  - `<head>` 内加 metadata 快照注释(R8)
  - `<head>` `<title>` 文字微调(允许"flower monorepo · 架构与工程手册"之类的延展;但非必须)
  - 顶部 TOC 添加 Part B 各节锚点(TOC 自身是 Part A `<body>` 之前/之后的导航元素,**不算改 Part A 主体**)
- Part B 紧跟在原 7 节之后追加,**新 `<section>` 元素**,独立于原 Part A 任何 `<section>`

### 1.3 视觉分界(R6)

实现选项(实施时选一):

- **选项 a · 大字标题分卷**(推荐 — 与 intro.html 现有学术手稿调性最契合)
  - Part B 起点放一个大字标题 `<header class="part-divider">Part B · 工程手册</header>`
  - 加副标题:"从愿景诗篇进入工程手册"
  - 标题前后留较多 padding 让 reader 心智明显切换
- **选项 b · 视觉横向规则**:用一个粗线条 SVG / CSS border 横向规则把 A / B 分开
- **选项 c · 顶部状态条切换**:模仿 intro.html 现有顶部条的设计,在 Part B 区域换一个状态条颜色 / 文字

实施时三选一,但 a 是默认。

### 1.4 TOC 双层结构(R5 / R11)

```
TOC (顶部 / sticky)
├── Part A · 愿景与架构
│   ├── A1. 架构 · 一座洋葱
│   ├── A2. pi 是什么
│   ├── A3. 同根不同枝
│   ├── A4. 为什么这样设计
│   ├── A5. 未来愿景
│   └── A6. 演进路径
└── Part B · 工程手册
    ├── B0. 引子
    ├── B1. pi 框架深度分析
    │   ├── B1.1 API 表面
    │   ├── B1.2 内部运作机制
    │   ├── B1.3 flower 怎么用 pi
    │   └── B1.4 设计哲学 · 与同类对比
    ├── B2. 7 个 package 详细职责
    │   ├── B2.1 flower-code-reviewer ★(展开)
    │   ├── B2.2 flower-providers
    │   ├── B2.3 flower-tools-gitlab
    │   ├── B2.4 flower-tools-common
    │   ├── B2.5 flower-tools-arms
    │   ├── B2.6 flower-compliance
    │   └── B2.7 flower-ops-bot
    └── B3. 跨包数据流
        ├── B3.1 LLM 调用链
        ├── B3.2 tool dispatch
        ├── B3.3 observability 旁路
        └── B3.4 SIEM 审计
```

实现:`<nav class="toc">` 内嵌 `<ul>` 双层,纯 CSS 样式;reader 点击展开 / 折叠 Part B 二级用 `<details>`。

### 1.5 折叠/展开默认值(R15)

| 节 | 默认 | 实现 |
|---|---|---|
| Part A 全部 6 节 | 展开(原 intro 是连续叙述,不折叠) | `<section>` 直接渲染,无 details 包裹 |
| B0 引子 | 展开 | `<section>` 直接渲染 |
| B1 4 子节 | 全展开 | `<details open>` 包裹,reader 可手动折叠 |
| B2 摘要 + 6 短卡片 | 折叠 + 摘要卡可见 | `<details>` 包裹,`<summary>` 显摘要卡 |
| B2.1 reviewer 节 | **展开**(例外) | `<details open>` 包裹,内部 S1-S12 各自再 `<details>` 控制(S5 工作流 / S12 6 few-shot 等长内容默认折叠) |
| B3 4 子节 | 全展开 | `<details open>` |

### 1.6 节内更细的折叠(reviewer 节内部)

B2.1 reviewer 节内部 S1-S12 各自策略:

| 子节 | 默认 | 原因 |
|---|---|---|
| S1 头部 + Quick Facts | 展开 | 短,reader 必看 |
| S2 触发链路图 | 展开 | 图示需立即看到 |
| S3 包依赖 | 展开 | 短 |
| S4 10 个源文件剖析 | 折叠(每个文件 `<details>`) | 内容多 |
| S5 prompts 工作流 7 步 | 折叠(整段 `<details>`) | 长 |
| S6 features | 展开 | 短卡片 |
| S7 exit code + isLlmFailure | 展开 | reader 经常找 |
| S8 env 表 | 展开(表格) | reader 经常找 |
| S9 GitLab CI yaml | 展开 | reader 经常找 |
| S10 容器与部署 | 折叠 | 偏运维,非通用 |
| S11 已知局限 | 展开 | 诚实展示 |
| S12 6 few-shot | 折叠(第 1 个展开,其余 5 个折叠) | 长,reader 需要时再展开 |

## 2. B1 pi 框架 4 维度内容映射

### 2.1 B1.1 API 表面 — 来源映射

| 内容 | 数据来源 |
|---|---|
| piMain 函数签名 | `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` + `main.d.ts` |
| extension 接口 | `dist/main.d.ts` extension factory 类型 |
| 内置工具(read / bash / edit / write) | README + `dist/*.d.ts` |
| Hook 类型(turn_start / message_update / tool_execution_*) | `dist/core/hooks/index.d.ts`(从 package.json `exports./hooks` 推断) |

实施时 sub-agent 读取这些文件后 dump 类型签名片段(R7 高保真)。

### 2.2 B1.2 内部运作机制 — 来源映射

| 内容 | 数据来源 |
|---|---|
| turn loop 流程 | `dist/main.js` 反推 + `docs/development.md` |
| event 系统(emit / listen) | flower `observability.ts` 监听代码佐证 |
| tool dispatch 序列 | flower `extension.ts` 注册代码 + `dist` 反推 |

**风险**:`dist` minified,反推可能不准。
**mitigation**:每段反推内容标注「来源」(development.md 引用文字 / .d.ts 类型注释 / 推测);推测处加 `<aside class="caveat">推测,以源码为准</aside>`。

### 2.3 B1.3 flower 怎么用 pi — 来源映射

| 内容 | 数据来源(精确,本仓库) |
|---|---|
| extension factory 注册 | `packages/flower-code-reviewer/src/extension.ts` 全文(72 行,可大段 dump) |
| 5 个 GitLab tool 注册 | `packages/flower-tools-gitlab/src/index.ts` |
| Provider 注册 | `packages/flower-providers/src/*` |
| Compliance ToolUse 拦截 | `packages/flower-compliance/src/*` |
| Observability event 监听 | `packages/flower-code-reviewer/src/observability.ts`(121 行,可大段 dump) |

### 2.4 B1.4 设计哲学 / 与同类对比 — 来源映射

| 对比对象 | 数据来源 |
|---|---|
| cursor | research(WebSearch + 官方 docs) |
| cline | research(GitHub README + ARCHITECTURE.md) |
| aider | research(官方 docs) |
| claude-code | 主流认知 + 公开文档 |
| openai-agents-sdk | research(SDK 文档) |
| pi 自己 | README + CHANGELOG + 推理 |

**对比维度**:agent 形态(框架 vs SDK)、extension 机制、tool 集成方式、本地 vs 云、目标场景。

## 3. B2 7 个 package schema

### 3.1 reviewer 节(B2.1)— 用 PRD R12 列出的 S1-S12 完整 schema

参见 PRD §4 R12。每个 S 子节内部结构由实施时 sub-agent 按 R12 字段产出,具体内容来源:

- S1 头部:Quick Facts 卡片
- S2 触发链路图:SVG / ASCII
- S3 包依赖:对照 5 兄弟包描述
- S4:每个文件名 → 做什么 / 关键设计点 / 何时被调
- S5:`prompts.ts` §「工作流」字符级 dump
- S6:每个 feature 一个卡片(N1/N2/E1/E2/E3/severity)
- S7:exit code 0/1/2 + isLlmFailure 五级表格
- S8:env 表(完整)
- S9:yaml 示例代码块 + 说明
- S10:Dockerfile 关键步骤 + wrapper + 跨网路径
- S11:**已 ship 的 sibling 任务移出 known-issues**;剩余的:walkthrough alert 与 line_comment 数不一致(已 fix?待 sub-agent 校对)、bash 白名单过严(已 fix?待校对)、minor 评论容易被淹没
- S12:6 个 few-shot 字符级 dump

### 3.2 其它 6 个 package(B2.2-B2.7)— 5 字段统一 schema

每个 `<details>` 内部:

```
<summary>
  flower-X · 一句话定位
</summary>
<dl class="package-card">
  <dt>职责</dt><dd>做什么(2-4 句)</dd>
  <dt>边界</dt><dd>不做什么 / 不负责的范畴(2-3 句)</dd>
  <dt>对外契约</dt><dd>导出的工具 / API / 命令(列表)</dd>
  <dt>关键模块</dt><dd>核心源文件简表(可选,2-4 项)</dd>
  <dt>与兄弟包关系</dt><dd>谁依赖它 / 它依赖谁(图示或文字)</dd>
</dl>
```

各 package 简要(implement 阶段 sub-agent 据此查仓库填):

| Package | 一句话定位 |
|---|---|
| flower-providers | 把 LLM env 翻译成 pi CLI argv;注册 4 个 havefun-* provider(havefun-anthropic / -openai / -openai-responses / -gemini) |
| flower-tools-gitlab | 5 个 GitLab REST tool(get_mr_files / get_mr_diff / get_file_content / get_previous_review / post_comment / post_line_comment) |
| flower-tools-common | 跨产品共享 stub 工具(zentao_search / dingtalk_doc_search) |
| flower-tools-arms | 阿里云 ARMS API stub |
| flower-compliance | 3 个 mode(ci-readonly / default / 未来 auto-fix);写工具禁用 / bash 白名单 / SIEM 审计 |
| flower-ops-bot | 钉钉 bot 形态(常驻 service,与 reviewer CI Job 形态不同) |

## 4. B3 跨包数据流图 schema

4 个子流,每个用 **ASCII art 或简单 SVG**(R2 自包含,不用 mermaid)。

### 4.1 B3.1 LLM 调用链

```
flower-code-reviewer
  └─ piMain(prompt, extensions)
       └─ pi 内部 LLM client
            └─ flower-providers 注册的 havefun-* provider
                 └─ havefun 网关
                      └─ Anthropic / OpenAI / Gemini upstream
```

### 4.2 B3.2 tool dispatch

```
LLM 返回 tool_call
  └─ pi 内部 dispatcher
       └─ flower-compliance 前置拦截(ci-readonly 拦写工具 / bash 白名单)
            ├─ 通过 → flower-tools-gitlab REST → GitLab API
            └─ 拦截 → 返回错误给 LLM
```

### 4.3 B3.3 observability 旁路

```
pi 内部 turn loop
  └─ emit event(turn_start / message_update / tool_execution_end)
       └─ flower observability.ts listener
            └─ stdout 流式打印(可被 FLOWER_VERBOSE 关闭)
```

### 4.4 B3.4 SIEM 审计

```
flower-compliance 拦截事件
  └─ 拦截记录(谁 + 时间 + 工具 + 文件 + 操作)
       └─ POST SIEM_INGEST_URL(如配置)
            └─ SIEM 后端(超出本 repo)
```

## 5. 内容生产策略 · sub-agent 分工(implement 阶段)

完整 sub-agent 分工见 `implement.md`,这里给设计层 schema。

### 5.1 4 个 research sub-agent(并行 · brainstorm 不派 / implement 阶段派)

| Sub-agent | 任务 | 产出 |
|---|---|---|
| R-1 | 反推 pi dist + 读 development.md + .d.ts | `research/pi-internal-mechanism.md` |
| R-2 | 调研 cursor/cline/aider/claude-code/openai-agents-sdk | `research/pi-vs-peers.md` |
| R-3 | 梳理本仓库 6 个 package(除 reviewer)的源码 → 5 字段卡片资料 | `research/packages-survey.md` |
| R-4 | 梳理跨包数据流 4 条线的实际代码路径 | `research/cross-package-dataflow.md` |

### 5.2 1-2 个 implement sub-agent(串行 · 等 research 回来后)

- I-1:写 Part B 内容到 docs/intro.html(主体)
- I-2(可选):写视觉打磨 + AC 自检 + 修补

主 agent 自己做的事:
- git mv intro.html → docs/intro.html
- 处理 head metadata + TOC 锚点扩展(Part A 区域唯一修改)
- 派发 sub-agent
- 汇总 / 风格统一打磨
- 最终 AC 自检

## 6. 防漂移机制(实现细节)

### 6.1 文档头快照声明(R8)

`<head>` 紧跟 `<meta>` 之后插入:

```html
<!--
================================================
本文档反映 flower commit <abbrev-sha> (<YYYY-MM-DD>) 的状态快照。
最新源码以 GitHub 主分支为准。
源码 ↔ 文档漂移采取「接受 + 声明」策略,不强制同步。

如发现文档与源码不一致:
  - reader 视角:以 GitHub 源码为准
  - 维护者视角:酌情更新本文档,不阻塞 PR
================================================
-->
```

实施时,`<abbrev-sha>` 用 implement 完成时的 commit hash(可在 implement 完成最后一步用 `git rev-parse --short HEAD` 填)。

### 6.2 节末源码链接(R9)

每个 dump 了源码内容的节(包括 prompts 工作流 / 6 个 few-shot / extension factory / observability event listener / scanForBlockers 决策树 / 5 个 GitLab tool 注册)末尾,加一个 `<footer class="source-ref">`:

```html
<footer class="source-ref">
  源码:<code>packages/flower-code-reviewer/src/prompts.ts</code> §「工作流」
</footer>
```

**用文件名 + 段落标题或函数名作为锚点,不写死行号**。

## 7. Rollout / Rollback

### 7.1 Rollout

- 任务 commit 到分支 `doc/code-reviewer-detailed-html`(已建)
- 不需要 push to remote;reader 在本地分支 file:// 打开即可
- 若需要发给他人,可手动用钉钉 / Slack 发送 HTML 文件,**或** push 后用 GitHub raw 链接

### 7.2 Rollback

- 撤销:`git revert <commit-sha>` 或在分支上 reset HEAD
- 因为 intro.html 用 `git mv` 移到 docs/,reset 会自动恢复(git history 完整)
- 因 Part A 字符级保留,Part A reader 不会受任何影响 — 哪怕实施过程中只追加了部分 Part B,Part A 仍然可读

## 8. 兼容性 / 风险

- ✅ **不影响代码**:本任务只产出 HTML,不动 `packages/*`
- ✅ **不影响 CI**:`docs/` 目录不被 reviewer pipeline 扫(reviewer 只看 PR diff;HTML 文件不参与 lint / typecheck)
- ⚠️ **影响**:`intro.html` 从根目录移到 `docs/`(已 grep 确认无任何代码引用)
- ⚠️ **路径敏感引用**:若有外部链接(如钉钉文档曾分享过的 raw URL)指向 `intro.html`,git mv 后会 404
  - **mitigation**:全 grep `intro.html` 引用,确认无;若有,在原位置留 redirect HTML(stub `<meta refresh>` 跳到 docs/intro.html)

## 9. Decision Log(ADR-lite,brainstorm 后)

### Decision 1:single file vs multi-file(2026-05-22)
- **Context**:scope 扩张后产生「一份巨型 vs 多份分册」张力
- **Decision**:single file(`docs/intro.html` 增强)— 不再产出 `code-reviewer-detailed.html`
- **Consequence**:reader 发链接即可,无切换 friction;文件 ≤300KB;reviewer 节 inline 占大头属于"核心产品自然占大头",不算失衡
- **Rejected alternatives**:三份文档(职责分离过度);双份完整(漂移风险);intro + reviewer-detailed(分册体验差)

### Decision 2:Part A 字符级保留 vs 全文重排(2026-05-22)
- **Context**:Part A 抒情调性 vs Part B 工程手册调性的张力
- **Decision**:Part A 字符级保留,Part B 末尾追加(两段式)
- **Consequence**:原诗篇审美完整保留;reader 跨过 A→B 分界时心智明显切换(视觉分界 R6 缓解)
- **Rejected alternatives**:全文重排(工作量大);节内嵌入(破坏诗意调性)

### Decision 3:高保真 vs 中保真(2026-05-22)
- **Context**:「发给别人看」 vs 文件大小 的张力
- **Decision**:高保真 self-contained(220-280KB,卡 300KB 上限)
- **Consequence**:reader 不依赖任何外部资源就能读完;源码漂移风险用 R8/R9 缓解;reviewer 节内部用 `<details>` 折叠次级长内容(S12 6 few-shot 只展开 1 个,其余折叠;S5 工作流默认折叠)
- **Rejected alternatives**:中保真(reader 要切到 GitHub,违背"发给别人看");低保真(几乎只剩概念图,失去价值)

### Decision 4:防漂移策略(2026-05-22)
- **Context**:高保真 → 源码改 → 文档过时
- **Decision**:接受漂移 + 声明(R8 文档头快照 + R9 节末源码链接,不上 pre-commit hook / build script)
- **Consequence**:维护成本最低;reader 知道有过时风险;不破坏 R2 自包含
- **Rejected alternatives**:pre-commit hook(误报多);build script(违背 R2)

### Decision 5:行号策略(2026-05-22)
- **Context**:原 PRD AC3.4「`scanForBlockers`(`run.ts:169`)」与 Risks「不写死行号」内部矛盾
- **Decision**:用**文件名 + 函数名 / 段落标题**作为锚点,**不写行号**
- **Consequence**:即使行号漂移,锚点仍能找到目标;reader 在 GitHub 上用文件名搜函数也能定位
- **Rejected alternatives**:写行号(漂移快);写 commit-specific permalink(URL 长且 reader 切到具体 commit 反而看不到 HEAD 最新)
