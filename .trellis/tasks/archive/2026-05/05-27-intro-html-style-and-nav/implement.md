# Implement · intro.html 样式优化 + 快捷导航

## 执行检查清单(顺序执行)

### Phase A · 设计稿(Plan 阶段尾声)

- [ ] A1 调用 `frontend-design:frontend-design` skill,输入参数 = `design.md` § 7 摘要 + 现有 CSS token 表 + Part A/B 结构。子代理产出 Visual Spec 追加到 `design.md`(sidebar active 高亮配色、卡片化对比策略、chevron 字符/SVG、B2-1 outer panel 视觉、移动抽屉宽度与时长)
- [ ] A2 用户 review Visual Spec → 必要时调整 design.md → Phase 1.4 review gate → `task.py start` 切到 in_progress

### Phase B · CSS Token 与基础布局(Execute)

- [ ] B1 在 `<style>` 顶部 `:root` 追加 spacing/sidebar/card/z-index token(`--gap-1`~`--gap-8` / `--sidebar-w` / `--card-*` / `--z-*`),不动现有 token
- [ ] B2 添加 `html { scroll-behavior: smooth; }` + `section, .part-b details { scroll-margin-top: 24px; }`
- [ ] B3 添加 `.side-nav` / `.side-nav header` / `.side-nav .nav-group/h6/ul/a/.active/.nav-sub*` 完整样式
- [ ] B4 添加 `.doc-main { margin-left: var(--sidebar-w); }`,**收窄 `.wrap` max-width: 1180px → 920px**(注意现有 Part A 组件目视核对)
- [ ] B5 添加 `.nav-toggle` / `.nav-scrim` / hamburger 三杠样式
- [ ] B6 添加响应式 3 断点 @media 块(1180/768 两个 breakpoint)
- [ ] B7 现有所有 `grid-template-columns: 1fr 1fr` / `repeat(N, 1fr)` 处补 `@media (max-width: 767px) { grid-template-columns: 1fr }` fallback。预扫一次定位所有出现处

### Phase C · DOM 结构注入

- [ ] C1 `<body>` 顶部插入 `<button class="nav-toggle">` + `<aside class="side-nav" id="side-nav">` + `<div class="nav-scrim">`
- [ ] C2 sidebar 内 HTML 静态写完整 TOC:
  - Part A:按现有 section 顺序列出(架构 · 一座洋葱 / pi 是什么 / 同根不同枝 / 为什么这样设计 / 未来愿景 / 演进路径 / 工程手册标题占位)
  - Part B 三级:B0/B1(.1~.4) / B2(.1~.7,B2.1 下挂 S1~S12) / B3(.1~.4)
- [ ] C3 把原 `<body>` 直接子元素的 topbar / hero / section.A1~A6 / header#part-b / div.part-b / footer 全部移入 `<main class="doc-main">`
- [ ] C4 给 Part A 每个 section 检查 id 与 data-toc 标记(无 id 的补 `id="sec-X"`,如 `sec-arch` / `sec-pi` / `sec-same-root` / `sec-why` / `sec-vision` / `sec-evolution`)
- [ ] C5 校验所有 `<a href="#...">` 锚点链接的 target id 都存在(grep id="x" 与 href="#x" 对照)

### Phase D · Part B 卡片化 CSS

- [ ] D1 添加 `.part-b details` 卡片化(bg/border/border-radius/box-shadow/padding/margin/transition)
- [ ] D2 添加 `.part-b details:hover` 与 `.part-b details[open]` 的阴影/border 变化
- [ ] D3 添加 `.part-b summary` 样式(font/cursor/list-style:none + ::before chevron + 旋转 transition)
- [ ] D4 添加 `.part-b details details` 嵌套卡片样式(left border 墨绿 / 紧凑 padding / smaller summary font)
- [ ] D5 现有 nav.toc-b 改为简洁"目录卡片"形态(border + padding,不抢主导航戏)

### Phase E · 默认开闭重设

- [ ] E1 grep 所有 `<details open id="b...">`,按 PRD § R4.5 调整 open 属性:
  - **保留 open**:`#b1-1` / `#b2-1` / `#b2-1-s1` / `#b2-1-s2` / `#b2-1-s3`
  - **改为 close(去掉 open)**:`#b1-2` / `#b1-3` / `#b1-4` / `#b2-1-s6` / `#b2-1-s7` / `#b2-1-s8` / `#b2-1-s9` / `#b2-1-s11`
  - **已是 close,保持**:`#b2-1-s4` / `#b2-1-s5` / `#b2-1-s10` / `#b2-1-s12` / `#b2-2` ~ `#b2-7` / `#b3-1` ~ `#b3-4`
- [ ] E2 提示:b3-1~b3-4 PRD 标"默认 close",但若 design.md 反复斟酌后认为 b3-1(LLM 调用链)应保留 open,可在 frontend-design 后调整

### Phase F · JS 模块

- [ ] F1 `</body>` 前插入 `<script>` 块:scrollspy IIFE(IntersectionObserver,rootMargin 调优后留 `-10% 0px -70% 0px`)
- [ ] F2 同一 script 块续写:hamburger / scrim / close / 链接点击关闭(matchMedia 检测)
- [ ] F3 检查 noscript 兜底:script 失败时 sidebar 锚点仍可用,details 仍可点开

### Phase G · 验证

- [ ] G1 用 Playwright 或浏览器(Chromium headless)打开 `file:///abs/path/docs/intro.html`,目视:
  - 桌面 1280×800:sidebar 可见 + 主内容区不被遮挡
  - 平板 1024×768:sidebar 收窄到 200px + S 三级隐藏
  - 移动 375×812:hamburger 可见 + 点击展开抽屉 + scrim 可关
- [ ] G2 滚动测试:Part A 每节滚过 → sidebar active 跟随;Part B 进入 → B0/B1/B2/B3 高亮联动
- [ ] G3 锚点测试:点击 sidebar 中 5 个随机链接 + 测试现有 toc-b 中 5 个链接 + Ctrl-F 搜 "S4" 浏览器自动展开折叠
- [ ] G4 `git diff` 校验:Part A 文案字符级保留(只看 CSS / DOM 包裹差异),Part B 事实文本不变
- [ ] G5 浏览器 DevTools Issues 面板:无 HTML 错误,无 JS console error
- [ ] G6 `wc -l docs/intro.html` 与原 4118 行做差,预计新增 +400~+600 行(sidebar HTML + CSS token + 卡片化 CSS + JS),无大幅意外膨胀

### Phase H · 提交

- [ ] H1 `git add docs/intro.html` + commit `[FEAT] intro.html 样式优化 + 左侧 sidebar 快捷导航 + Part B 卡片化`
- [ ] H2 `git push origin doc/code-reviewer-detailed-html`
- [ ] H3 `task.py archive` + journal record(通过 `/trellis:finish-work`)

## 验证命令

```bash
# HTML 结构基础校验:无未闭合标签(浏览器即时反馈)
# 用 Playwright headless 截图三个 viewport:
# (前置:开发期跑 npx http-server ./docs)
npx http-server ./docs -p 8088 &
# 然后 manually 用 Chrome DevTools 切换 viewport 截图

# 锚点完整性:grep id 与 href 对照
grep -oE 'id="[^"]+"' docs/intro.html | sort -u > /tmp/intro-ids.txt
grep -oE 'href="#[^"]+"' docs/intro.html | sort -u > /tmp/intro-hrefs.txt
# 对比 /tmp/intro-hrefs.txt 中每个 href 是否在 ids.txt 中找到对应

# 事实文本不变验证:抽样关键句
grep -c "GitLab CI 里的「自动代码评审 agent」" docs/intro.html  # 应 = 1
grep -c "pi 是什么" docs/intro.html  # 应 = 现有出现次数
grep -c "洋葱式架构" docs/intro.html  # 应 = 现有出现次数
```

## Review Gates

- **G-A**(Phase A 后):frontend-design 出的 Visual Spec 用户必须 review,通过后 `task.py start` 才允许进入 Phase B+
- **G-G**(Phase G 后):浏览器目视回归全部通过 → 用户 ack → 才进入 Phase H 提交
- **G-H**(Phase H 后):git push 完成 → `/trellis:finish-work` 归档

## 回滚点

- **Checkpoint 1**:Phase B 完成后 git stash / commit `[WIP] CSS token only`,若后续 Phase C 大改 DOM 出问题可回 1
- **Checkpoint 2**:Phase C 完成后 commit `[WIP] DOM 结构 + sidebar HTML 静态`,若 Phase D/E/F 出问题可回 2
- **Checkpoint 3**:Phase F 完成后 commit `[WIP] 全部样式 + JS,待回归`
- 最终 squash 或保留 WIP 链由 Phase H1 决定
- 全任务回滚:`git revert <commit-hash>` 单 commit 即可(单文件改动,无 schema/数据)

## 关键风险与对策

| 风险 | 对策 |
| --- | --- |
| Part A 文案被无意中改 | Phase G4 `git diff` 抽样核对 + 提交前 `git diff --stat` 看修改集中在 CSS/新增 DOM |
| 锚点链接被破坏 | Phase G3 全量点击测试 + Phase C5 grep 对照 |
| Sidebar 占宽后 Part A 组件破版(洋葱图/axes) | Phase B4 完成后立即跑 Phase G1 桌面截图复核,出现破版回 design.md 调整 |
| IntersectionObserver 在 Safari 旧版有 bug | F1 加 `if (!('IntersectionObserver' in window)) return` 降级,sidebar 仍可点 |
| 移动抽屉 z-index 与 topbar 冲突 | CSS token 集中管理 `--z-*`,Phase B6 一处定调 |
| Ctrl-F 搜索 折叠节内容遗失 | 浏览器原生 `<details>` 支持搜索时自动展开,Phase G3 验证 |
| frontend-design 子代理输出方向跑偏 | Phase A2 用户 review gate 拦截,必要时重新调子代理 |
