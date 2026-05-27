# intro.html 样式优化 + 快捷导航(工程手册区域信息密度治理)

## Goal

提升 `docs/intro.html` 的阅读体验:

1. 给全页加 **快捷导航 UI**,让读者在 4118 行单文件长文档内能在 Part A(诗意/愿景)与 Part B(工程手册:b0 引子 / b1 pi 框架 / b2 7 个 package / b3 跨包数据流)之间快速跳转,并实时感知"我当前在哪一节"。
2. 重点治理 **Part B 工程手册区域** 的信息密度与视觉层级,减轻"杂乱"感(当前 23 个 `<details>` 折叠节扁平堆叠在 section 下,默认开闭状态混杂,无视觉分组/卡片化包装)。

不是要重写视觉风格(Part A 已经是成熟的"编辑风/学术手稿"系统),而是在它之上 **打磨 + 补全**。

## Background / Known Context

### 文件现状

- 路径:`docs/intro.html`,4118 行,**单文件**(纯 inline CSS + HTML + `<details>`,无外部资源)
- head meta:`viewport=device-width,initial-scale=1` 已设;`lang=zh-CN`
- 当前分支:`doc/code-reviewer-detailed-html`(同分支前序任务 `code-reviewer-detailed-html` 已归档)
- 关联包归属:`flower-code-reviewer`

### 已有设计系统(line 17-1537)

- **调色板**(`:root` CSS 变量):
  - 中性:`--bg #f5f1ea`、`--bg-2 #ebe5da`、`--paper #fbf8f3`、`--ink/--ink-2/--ink-3`、`--line / --line-strong`
  - 强调:`--accent #2c5d3f` 墨绿(共享/既有)、`--accent-2 #d24b2a` 朱砂(决策/关键)、`--accent-3 #c89b3c` 琥珀(强调)、`--accent-4 #335e8a` 靛青(未来/愿景)、`--accent-5 #6b3d8a` 紫罗兰(协议/上游)
- **字体栈**:`--serif`(思源宋体)、`--sans`(苹方/PingFang)、`--mono`(JetBrains Mono / SF Mono)
- **布局容器**:`.wrap { max-width: 1180px; margin: 0 auto; padding: 0 32px; }`
- **Part A 成熟组件**:`.hero`(clamp 大标题 + 双色径向渐变 + .axes 三轴线)、`.onion`(嵌套层级架构图)、`.bridge`(章节桥接句,左 4px 琥珀色边)、`.now-focus`(深底+脉冲点状态横幅)、`.arch-notes .bullets`(↳ 列表)

### Part B 现有结构(line 1539+)

- `<header class="part-divider" id="part-b">` 分隔标题"工程手册"
- `<nav class="toc-b">`(line 1551):**静态 ul**,放在 Part B 起点,无 sticky / scrollspy
- `<div class="part-b">` 包裹 Part B 全部 section:
  - `#b0-intro`:引子
  - `#b1-pi`:含 `#b1-1`/`#b1-2`/`#b1-3`/`#b1-4` 4 个 details
  - `#b2-packages`:含 `#b2-1` 大节,内嵌 `#b2-1-s1`~`#b2-1-s12` 12 个子 details;`#b2-2`~`#b2-7` 各 1 个 details(共 6 个其它 package)
  - `#b3-dataflow`:含 `#b3-1`~`#b3-4` 4 个 details
- **合计 23 个 `<details>` 折叠节**扁平堆叠
- 默认开闭混杂:b2-1 内 S1/S2/S3/S6/S7/S8/S9/S11 默认 `open`,S4/S5/S10/S12 默认折叠
- Part B 已有专属 CSS:`.part-b pre.code .kw/.str/.cmt`(深底代码高亮)等

### 响应式陷阱(已发现)

- 多处 `grid-template-columns: 1fr 1fr`(`.arch` / `.hero .axes` repeat(3) 等),桌面下漂亮,但**没有移动端 fallback**,小屏会挤压

## Assumptions(待用户确认 / 验证)

- Part A 视觉保留,**不改既有组件外观**(母任务 `intro-html-deep-enhance` 的字符级保留约定延伸)
- 快捷导航需要 **sticky/follow** + **scrollspy 当前位置高亮**
- Part B 治理只动 **版式 / 分组 / 折叠默认值**,**不改文字事实内容**(尊重 `intro-html-deep-enhance` 母任务已落地的事实口径)
- 单文件 inline CSS + JS 不拆分(保持文档可独立浏览、可直接 file:// 打开)
- 加少量 vanilla JS 是允许的(scrollspy / 移动端抽屉 toggle)

## Decisions(已收敛)

- **[2026-05-27] 改动边界**:全页统一打磨(含 Part A 组件调整)。
  - **Context**:用户原话"优化下 intro.html 的页面样式 ...... 尤其工程手册那一块",兼顾全页 + Part B 重点。
  - **Decision**:全页 scope。以 Part A 现有调色板为系统基线,允许细调 hero/洋葱图/bridge/now-focus 等组件细节;统一 spacing/节奏系统;补全所有响应式 fallback。但**事实文本一字不改**。
  - **Consequences**:scope 较大,需要 frontend-design 子代理产出系统设计稿先收口;Part A 的回归测试范围扩大。

- **[2026-05-27] 快捷导航形态**:左侧固定 sidebar(含全量 TOC)。
  - **Context**:4118 行单文件,Part A 7 节 + Part B 4 大节(B0/B1/B2/B3),其中 B2 有 7 个 package + 12 个 S(reviewer)。容量与浏览性都需要全量铺开。
  - **Decision**:240~280px 左侧固定 sidebar。Part A 7 节 + Part B 三级折叠(B2 展开 7 packages + 12 S)。Scrollspy 高亮当前节。桌面主推,移动端折叠成抽屉/汉堡按钮。
  - **Consequences**:桌面正文 max-width 需收窄(原 `.wrap` 是 1180px,加 sidebar 后内容区约剩 880px,需要重新核对);移动端需要 hamburger 按钮 + 蒙层。

- **[2026-05-27] Part B 治理策略**:卡片化 + chevron + 收住默认折叠。
  - **Context**:23 个 `<details>` 扁平堆叠,默认开闭混杂,"杂乱"的根源是缺视觉分组与开闭节奏。
  - **Decision**:给 `<details>` 加卡片化外壳(border-radius / 软阴影 / hover 微动效);`<summary>` 加 chevron(▸/▾)指示开闭;B2-1 reviewer 的 12 个 S 用 outer panel 包裹成一个独立卡片群;默认开闭重新设计 — **仅 S1/S2/S3 + b2-2~b2-7 首段预览默认 open**,其余全部默认 close。读者按需深潜。
  - **Consequences**:用户首次进入 Part B 信息量大幅下降;深读需要点击;Ctrl-F 仍能搜到折叠节内容(浏览器自动展开)。

- **[2026-05-27] 设计协作**:调用 frontend-design 子代理产出整页设计稿。
  - **Context**:全页 scope + 卡片化新组件 + 左侧 sidebar 新交互,需要系统的设计稿先收口。
  - **Decision**:Phase 1 在 brainstorm 收敛后,调 frontend-design skill 产出:整页视觉系统(spacing/节奏/卡片规范)、左 sidebar HTML/CSS 草模、Part B 卡片化 details 草模、响应式断点表。我拿草模再集成回 `docs/intro.html`。
  - **Consequences**:多一个设计阶段;但实现阶段方向明确,减少返工。

- **[2026-05-27] Edge cases 入 MVP**:响应式 3 断点 + 移动抽屉 / `scroll-margin-top` 修复锚点遮挡。
  - **Decision**:`prefers-reduced-motion` 退化、打印样式、Part C/D 未来扩展、暗色模式 — 全部进 Out of Scope。
  - **Consequences**:MVP 聚焦"看得到 + 跳得准 + 移动可用",其它"可访问性边角"留待后续单独任务。

- **[2026-05-27] 分支策略**:沿用当前分支 `doc/code-reviewer-detailed-html`。
  - **Context**:分支已 ahead origin by 2 commits(archive + journal),内容也都围绕 intro.html 演进。
  - **Decision**:本任务的 work commits 接在此分支上,最后一起 push。
  - **Consequences**:分支名与本任务内容不完全对齐(分支名带 reviewer-detailed-html),但避免不必要的分支切换。push 时 PR 描述需说明本分支累积了两个任务的工作。

## Open Questions

(无 — 已全部收敛)

## Requirements

### R1 · 全页快捷导航(左侧固定 sidebar)

- R1.1 `<aside class="side-nav">` 固定左侧,桌面 (≥1180px) 宽 260px,贴顶贴底
- R1.2 sidebar 内含完整 TOC:
  - Part A 章节(架构 · 一座洋葱 / pi 是什么 / 同根不同枝 / 为什么这样设计 / 未来愿景 / 演进路径,以及 Part A 收尾 — 按现有 section 顺序自动列出)
  - Part B 三级折叠:B0 引子 / B1 pi 框架(B1.1~B1.4) / B2 7 个 package(B2.1 默认展开列 S1~S12,B2.2~B2.7 不再下钻) / B3 跨包数据流(B3.1~B3.4)
- R1.3 **Scrollspy 当前章节高亮**:用 IntersectionObserver 监听 section + 一级 details,当前可视章节在 sidebar 高亮(背景 + 左条着色,沿用 `--accent-2` 朱砂)
- R1.4 sidebar 顶部:`<a href="#top">` 文档名(回顶按钮)+ Part A / Part B 二选一过滤(可选,先不做)
- R1.5 sidebar 自身滚动条:当 TOC 内容溢出 viewport 时 sidebar 内部可滚,主滚动不被劫持
- R1.6 平滑滚动:点击 TOC 链接 `scroll-behavior: smooth`(html 元素)

### R2 · 响应式 3 断点

- R2.1 桌面 (≥1180px):sidebar 常驻 + 主内容区右移 (margin-left: 260px) + `.wrap` max-width 收窄到 920px
- R2.2 平板 (768~1180px):sidebar 仍常驻但收窄 (200px),三级子节点(B2.1 的 S1~S12)默认折叠
- R2.3 移动 (<768px):sidebar 退化,左上角 hamburger 按钮 (≥44×44 触控区),点击弹抽屉(从左侧 slide-in)+ 全屏蒙层 (rgba(0,0,0,0.4)),蒙层点击关闭
- R2.4 现有 `grid-template-columns: 1fr 1fr` / repeat(3) 处全部加 `@media (max-width: 768px)` fallback (单列堆叠)

### R3 · 锚点跳转修复

- R3.1 所有可被链接的元素(section / details)加 `scroll-margin-top: 24px`(留出气息空间)
- R3.2 hamburger 按钮在移动端 sticky,需保证不遮挡内容 — 内容 padding-top 加 8px 缓冲

### R4 · Part B 卡片化 + chevron + 默认折叠重设

- R4.1 所有 Part B 的 `<details>` 加卡片化外壳:`border: 1px solid var(--line)` / `border-radius: 6px` / `box-shadow: 0 1px 2px rgba(0,0,0,0.04)` / `padding: 20px 24px` / `margin-bottom: 16px`
- R4.2 `<summary>` 加 chevron:用 CSS `::before` 加 `▸` 字符(open 态切到 `▾`,可配合微旋转 90deg 过渡动画 200ms ease)
- R4.3 hover 态:`box-shadow: 0 2px 8px rgba(0,0,0,0.08)` + `border-color: var(--line-strong)`
- R4.4 B2.1(flower-code-reviewer)的 S1~S12 用 `<div class="s-panel">` outer wrapper 包裹,wrapper 顶部加一行"S1~S12 子节"小标 + 当前展开数计数(可选)
- R4.5 **默认开闭状态重设**:
  - 默认 `open`:`#b0-intro` 整段(本身是 section 不是 details);`#b1-1`(pi API 表面);`#b2-1`(reviewer 大节,作为 outer wrapper)/ `#b2-1-s1` / `#b2-1-s2` / `#b2-1-s3`(reviewer 核心三节)
  - 默认 `close`:`#b1-2`/`#b1-3`/`#b1-4`、`#b2-1-s4`~`#b2-1-s12`(除 s1/s2/s3 外全收)、`#b2-2`~`#b2-7`、`#b3-1`~`#b3-4`
  - Ctrl-F 浏览器原生搜索仍能命中折叠节内容(`<details>` 标准行为)

### R5 · Part A 细调(不动事实文本)

- R5.1 统一 spacing scale:基于 `--gap-*` token 系统(4 / 8 / 16 / 24 / 32 / 48 / 64 / 96 px)
- R5.2 `.hero` / `.axes` / `.arch` / `.bridge` / `.now-focus` / `.onion` 各组件在新 sidebar 布局下视觉密度复核(可能需要微调 padding/font-size)
- R5.3 现有 1180px max-width 收到 920px 后,各组件不应破版

### R6 · 现有 nav.toc-b 处理

- R6.1 现有 `<nav class="toc-b">`(line 1551)**不删除**,改为正文内的"目录卡片"形态(纯导航锚点列表,作为 Part B 起点的内容导航,与左侧 sidebar 并存,不冲突)
- R6.2 视觉上 toc-b 改为简洁卡片(border + padding),不再扮演主导航(主导航在 sidebar)

## Acceptance Criteria

- [ ] AC1 桌面 (≥1180px) 打开 `intro.html`,左侧 sidebar 可见,显示完整 TOC(Part A + Part B 三级)
- [ ] AC2 任意章节滚动,sidebar 中对应条目高亮(朱砂色背景或左条);Part B details 展开/折叠时,sidebar 中三级条目可联动展开/折叠(可选)
- [ ] AC3 移动端 (<768px) 左上角 hamburger 可见,点击展开抽屉,蒙层可点击关闭;抽屉内可点 TOC 跳转
- [ ] AC4 所有现有 id 锚点(`#part-b` / `#b0-intro` / `#b1-1`~`#b1-4` / `#b2-1` / `#b2-1-s1`~`#b2-1-s12` / `#b2-2`~`#b2-7` / `#b3-1`~`#b3-4` / `#part-a`-style)外链可达,跳转后不被 sticky 元素遮挡
- [ ] AC5 Part B `<details>` 显示卡片化外壳 + chevron 指示;hover 态有微动效
- [ ] AC6 默认开闭符合 R4.5 — 首次进入 Part B 时只看到 b0+b1.1+b2.1(含 s1/s2/s3)
- [ ] AC7 Part A 文案字符级保留(diff 验证)
- [ ] AC8 Part B 事实文本不变(diff 验证)
- [ ] AC9 移动 + 平板 viewport 无横向滚动
- [ ] AC10 HTML 在浏览器 DevTools Issues 面板无 error;`intro.html` 单文件无新增外部依赖

## Definition of Done

- 浏览器目视回归:Chrome / Safari / 移动 viewport(DevTools 模拟 iPhone 12 / iPad)
- 所有锚点链接逐一点击验证可达
- `git diff` 验证 Part A 与 Part B 的事实文本未变(用 `grep -c "原句"` 抽样核对)
- `docs/intro.html` 单文件依然自包含
- 默认开闭策略落地符合 R4.5

## Out of Scope(explicit)

- 不拆分 `intro.html` 成多文件
- 不引入构建工具 / 打包(Vite / webpack / Tailwind 等)
- 不引入 npm 依赖、不引入 CDN(图标用 unicode chevron 或 inline SVG)
- 不动 Part A 与 Part B 的 **事实文本** 内容
- 不改 `intro-html-deep-enhance` 母任务规划的章节结构与 id 体系
- 不做 `prefers-reduced-motion` 退化(留待后续单独任务)
- 不做 `@media print` 打印样式
- 不做 SEO / 暗色模式 / 国际化
- 不做 Part C/D 的"未来导航 dynamic generation"预留

## Research References

(若需要,后续补充)
