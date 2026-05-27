# Design · intro.html 样式优化 + 快捷导航

## 1 · 总览

把 `docs/intro.html` 从「单列长文 + 静态 toc-b」演进到「**左固定 sidebar + 主滚动区 + Part B 卡片化 details**」三块布局,并补全响应式 3 断点与锚点遮挡修复。新增 ~120 行 vanilla JS(scrollspy + hamburger),纯 inline,无构建/无依赖。

```
┌──────────────────────────────────────────────────────────────┐
│ aside.side-nav (260px / 200px / drawer)                       │
│   ├─ <header> 文档名 + 回顶                                   │
│   ├─ <nav>                                                    │
│   │   Part A (7 sections — 按 section[data-toc] 自动收集)     │
│   │   Part B                                                  │
│   │     ├ B0 引子                                             │
│   │     ├ B1 pi 框架 (B1.1~B1.4 三级)                          │
│   │     ├ B2 7 个 package                                     │
│   │     │   ├ B2.1 reviewer (展开 S1~S12)                     │
│   │     │   └ B2.2~B2.7 其它 6 包(不下钻)                    │
│   │     └ B3 跨包数据流 (B3.1~B3.4)                            │
│   └─ <footer> 版本/日期 caption                                │
└──────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ main.doc-main (margin-left: 260px)                            │
│   .topbar / .hero / section.section-a × N (Part A 原样)        │
│   header#part-b / nav.toc-b(降为正文卡片)                      │
│   div.part-b → section × 4 (b0/b1/b2/b3, 各含 details 卡片群) │
│   footer                                                       │
└──────────────────────────────────────────────────────────────┘
                              ▲
                   移动端:hamburger 按钮 (top-left fixed) → 抽屉
```

## 2 · DOM 结构变更

### 2.1 新增 `<aside class="side-nav">`(放在 `<body>` 顶部)

```html
<aside class="side-nav" id="side-nav" aria-label="文档导航">
  <header>
    <a href="#top" class="brand">Flower · 工程手册</a>
    <button class="side-nav-close" aria-label="关闭导航">×</button>
  </header>
  <nav>
    <div class="nav-group">
      <h6>Part A · 愿景</h6>
      <ul>
        <li><a href="#sec-arch" data-target="sec-arch">01 架构 · 一座洋葱</a></li>
        <!-- ... 自动按 section[data-toc] 注入,见 §3.2 ... -->
      </ul>
    </div>
    <div class="nav-group">
      <h6>Part B · 工程手册</h6>
      <ul>
        <li><a href="#b0-intro" data-target="b0-intro">B0 · 引子</a></li>
        <li>
          <a href="#b1-pi" data-target="b1-pi">B1 · pi 框架深度分析</a>
          <ul class="nav-sub">
            <li><a href="#b1-1" data-target="b1-1">B1.1 API 表面</a></li>
            <!-- B1.2~B1.4 -->
          </ul>
        </li>
        <li>
          <a href="#b2-packages" data-target="b2-packages">B2 · 7 个 package</a>
          <ul class="nav-sub">
            <li>
              <a href="#b2-1" data-target="b2-1">B2.1 reviewer ★</a>
              <ul class="nav-sub nav-sub-2">
                <li><a href="#b2-1-s1" data-target="b2-1-s1">S1 · 一句话定位</a></li>
                <!-- S2~S12 -->
              </ul>
            </li>
            <li><a href="#b2-2" data-target="b2-2">B2.2 providers</a></li>
            <!-- B2.3~B2.7 -->
          </ul>
        </li>
        <li>
          <a href="#b3-dataflow" data-target="b3-dataflow">B3 · 跨包数据流</a>
          <ul class="nav-sub">
            <li><a href="#b3-1" data-target="b3-1">B3.1 LLM 调用链</a></li>
            <!-- B3.2~B3.4 -->
          </ul>
        </li>
      </ul>
    </div>
  </nav>
</aside>
```

> sidebar TOC 用 **HTML 静态写死**(不在 runtime 反射 section/details 标题),避免 JS 失败时导航整体丢失。文案与现有 toc-b 对齐,后续追加章节需手动同步两处(权衡选择:简单胜过自动)。

### 2.2 新增 hamburger 按钮(移动端,fixed)

```html
<button class="nav-toggle" aria-label="打开导航" aria-controls="side-nav" aria-expanded="false">
  <span></span><span></span><span></span>
</button>
<div class="nav-scrim" aria-hidden="true"></div>
```

### 2.3 主内容区包裹 `<main class="doc-main">`

把原 `<body>` 下的 topbar/hero/section/.../footer 全部移入 `<main class="doc-main">`。`<aside>` + `<main>` 平级,`<aside>` 用 `position: fixed`,`<main>` 用 `margin-left: 260px`(桌面)。

### 2.4 给 Part A 的 `<section>` 加 `data-toc` 标记(用于 scrollspy 与可能的自动生成)

每个原 section 加 `data-toc="..."` 与 `id="sec-arch"` 等(若无 id 则补);TOC 中 `data-target` 与 section id 一一对应,IntersectionObserver 通过 id 索引高亮项。

### 2.5 Part B `<details>` 加卡片 wrapper(可选)

最小侵入版:**不加 wrapper,直接给 `.part-b details` 应用卡片化 CSS**。B2-1 的 outer wrapper 用现有 `<details open id="b2-1">` 本身,在 CSS 上区分 `.part-b > section > details`(顶层 = 大卡片)与 `.part-b details details`(嵌套 = 小卡片)。

## 3 · CSS 系统扩展

### 3.1 新增 spacing token

```css
:root {
  /* 现有 token 保留 ... */
  --gap-1: 4px;
  --gap-2: 8px;
  --gap-3: 16px;
  --gap-4: 24px;
  --gap-5: 32px;
  --gap-6: 48px;
  --gap-7: 64px;
  --gap-8: 96px;

  --sidebar-w: 260px;
  --sidebar-w-md: 200px;
  --sidebar-bg: var(--paper);
  --sidebar-border: var(--line);

  --card-radius: 6px;
  --card-shadow: 0 1px 2px rgba(26,29,26,0.04);
  --card-shadow-hover: 0 2px 8px rgba(26,29,26,0.08);

  --z-sidebar: 50;
  --z-toggle: 51;
  --z-scrim: 49;
}
```

### 3.2 sidebar 样式

```css
.side-nav {
  position: fixed;
  top: 0; left: 0; bottom: 0;
  width: var(--sidebar-w);
  background: var(--sidebar-bg);
  border-right: 1px solid var(--sidebar-border);
  overflow-y: auto;
  z-index: var(--z-sidebar);
  font-family: var(--sans);
  font-size: 13px;
  padding: var(--gap-4) 0;
}
.side-nav header { padding: 0 var(--gap-4) var(--gap-4); border-bottom: 1px solid var(--line); }
.side-nav .brand { font-family: var(--serif); font-size: 16px; color: var(--ink); }
.side-nav .nav-group { padding: var(--gap-4) var(--gap-3) 0; }
.side-nav h6 {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--ink-3);
  margin: 0 var(--gap-2) var(--gap-2);
}
.side-nav ul { list-style: none; padding: 0; margin: 0; }
.side-nav a {
  display: block;
  padding: var(--gap-2) var(--gap-3);
  color: var(--ink-2);
  border: none;
  border-left: 2px solid transparent;
  text-decoration: none;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.side-nav a:hover { color: var(--ink); background: var(--bg-2); }
.side-nav a.active {
  color: var(--accent-2);
  background: var(--bg-2);
  border-left-color: var(--accent-2);
  font-weight: 600;
}
.side-nav .nav-sub { margin-left: var(--gap-3); border-left: 1px dashed var(--line); }
.side-nav .nav-sub-2 { margin-left: var(--gap-3); }
.side-nav-close { display: none; }
```

### 3.3 主内容区 margin

```css
.doc-main { margin-left: var(--sidebar-w); }
.wrap { max-width: 920px; margin: 0 auto; padding: 0 var(--gap-5); }
```

### 3.4 Part B `<details>` 卡片化

```css
.part-b details {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--card-radius);
  box-shadow: var(--card-shadow);
  padding: var(--gap-4) var(--gap-5);
  margin-bottom: var(--gap-3);
  transition: box-shadow 0.18s, border-color 0.18s;
}
.part-b details:hover { box-shadow: var(--card-shadow-hover); border-color: var(--line-strong); }
.part-b details[open] { box-shadow: var(--card-shadow-hover); }

.part-b summary {
  cursor: pointer;
  font-family: var(--serif);
  font-size: 17px;
  font-weight: 600;
  color: var(--ink);
  list-style: none;
  padding-left: 28px;
  position: relative;
  user-select: none;
}
.part-b summary::-webkit-details-marker { display: none; }
.part-b summary::before {
  content: "▸";
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%) rotate(0);
  font-size: 12px;
  color: var(--accent);
  transition: transform 0.2s ease;
}
.part-b details[open] > summary::before { transform: translateY(-50%) rotate(90deg); }

/* 嵌套 details(B2-1 内的 S1~S12)用更紧凑的卡片 */
.part-b details details {
  border-left: 3px solid var(--accent);
  margin-top: var(--gap-3);
  margin-left: 0;
  padding: var(--gap-3) var(--gap-4);
}
.part-b details details summary { font-size: 15px; }
```

### 3.5 hamburger + 抽屉 + 蒙层

```css
.nav-toggle {
  display: none;
  position: fixed;
  top: var(--gap-2); left: var(--gap-2);
  width: 44px; height: 44px;
  background: var(--paper);
  border: 1px solid var(--line-strong);
  z-index: var(--z-toggle);
  cursor: pointer;
}
.nav-toggle span {
  display: block;
  width: 22px; height: 2px;
  background: var(--ink);
  margin: 4px auto;
  transition: transform 0.2s, opacity 0.2s;
}
.nav-toggle[aria-expanded="true"] span:nth-child(1) { transform: translateY(6px) rotate(45deg); }
.nav-toggle[aria-expanded="true"] span:nth-child(2) { opacity: 0; }
.nav-toggle[aria-expanded="true"] span:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }

.nav-scrim {
  display: none;
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: var(--z-scrim);
}
.nav-scrim.show { display: block; }
```

### 3.6 响应式 3 断点

```css
/* 平板 768~1180px:sidebar 收窄 */
@media (max-width: 1180px) and (min-width: 768px) {
  :root { --sidebar-w: var(--sidebar-w-md); }
  .side-nav .nav-sub-2 { display: none; } /* 隐藏 S1~S12 三级 */
}

/* 移动 <768px:sidebar 退化为抽屉 */
@media (max-width: 767px) {
  .side-nav {
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    width: min(280px, 80vw);
    box-shadow: 4px 0 12px rgba(0,0,0,0.15);
  }
  .side-nav.show { transform: translateX(0); }
  .side-nav-close { display: inline-block; float: right; background: none; border: none; font-size: 24px; cursor: pointer; }
  .doc-main { margin-left: 0; padding-top: 56px; /* 给 hamburger 让位 */ }
  .nav-toggle { display: block; }

  /* 现有 grid 全部回退单列 */
  .arch { grid-template-columns: 1fr; }
  .hero .axes { grid-template-columns: 1fr; }
  /* 其它出现 1fr 1fr / repeat(N) 的 grid 同样 fallback,见实施清单 */
}
```

### 3.7 锚点遮挡修复

```css
html { scroll-behavior: smooth; }
section, .part-b details { scroll-margin-top: 24px; }
@media (max-width: 767px) {
  section, .part-b details { scroll-margin-top: 64px; /* 给 hamburger 留 */ }
}
```

## 4 · JS 模块(vanilla,放在 `</body>` 前)

### 4.1 Scrollspy

```js
(function() {
  const ids = Array.from(document.querySelectorAll('.side-nav [data-target]')).map(a => a.dataset.target);
  const targets = ids.map(id => document.getElementById(id)).filter(Boolean);
  if (!('IntersectionObserver' in window)) return; // 降级:不做高亮

  const activate = (id) => {
    document.querySelectorAll('.side-nav a.active').forEach(a => a.classList.remove('active'));
    const link = document.querySelector(`.side-nav [data-target="${id}"]`);
    if (link) {
      link.classList.add('active');
      // 滚动 sidebar 让 active 项可见(可选)
      link.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  };

  // 取「viewport 顶部最近的进入元素」为 active
  let lastActive = null;
  const io = new IntersectionObserver((entries) => {
    // 收集当前在视口内的目标
    const visible = entries
      .filter(e => e.isIntersecting)
      .map(e => e.target.id);
    if (visible.length > 0) {
      // 选择 DOM order 最靠前的那个
      const next = ids.find(id => visible.includes(id));
      if (next && next !== lastActive) { lastActive = next; activate(next); }
    }
  }, { rootMargin: '-10% 0px -70% 0px', threshold: 0 });

  targets.forEach(t => io.observe(t));
})();
```

### 4.2 Hamburger / 抽屉

```js
(function() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('side-nav');
  const scrim = document.querySelector('.nav-scrim');
  const close = document.querySelector('.side-nav-close');
  if (!toggle || !nav) return;

  const open = () => {
    nav.classList.add('show');
    scrim.classList.add('show');
    toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  };
  const closeFn = () => {
    nav.classList.remove('show');
    scrim.classList.remove('show');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  };

  toggle.addEventListener('click', () => {
    toggle.getAttribute('aria-expanded') === 'true' ? closeFn() : open();
  });
  scrim.addEventListener('click', closeFn);
  if (close) close.addEventListener('click', closeFn);

  // 点 TOC 链接后自动关闭(移动端)
  nav.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 767px)').matches) closeFn();
  }));
})();
```

## 5 · 数据流 / 交互序列

```
读者滚动
  └─> IntersectionObserver 触发
        └─> 过滤 visible entries + 取 DOM order 最靠前
              └─> activate(id) 切换 .active class
                    └─> sidebar 高亮 + scrollIntoView(局部)

读者点 sidebar 链接
  └─> 默认锚点跳转 + scroll-behavior:smooth
        └─> 浏览器滚动 + 自动展开折叠节(若锚点指向 details 内部,Ctrl-F 同理)
              └─> IntersectionObserver 重新触发 → sidebar 同步高亮

读者点 hamburger(移动端)
  └─> open() → sidebar.show + scrim.show + body 锁滚动
读者点 scrim / close / 链接
  └─> closeFn() → 恢复
```

## 6 · 兼容性与回滚

- 浏览器要求:Chrome 90+ / Safari 14+ / Firefox 88+(IntersectionObserver + `:has()` 不用 / `inset` shorthand 支持)
- JS 失败兜底:scrollspy 不工作时 sidebar 仍可用(纯锚点)
- 锚点 id **零删除零改名**,只新增 `data-toc` / `data-target`,外链引用不破
- Part A 文案 / Part B 事实文本 **零改动**,只动 CSS class + 加新容器
- 回滚:`git revert <commit>` 即可,无 schema/数据迁移影响

## 7 · frontend-design 子代理输入摘要

需要子代理产出的视觉决策(后续在 Phase 1.2/1.3 调用 frontend-design skill 时使用):

- sidebar 内左条 active 颜色与宽度(朱砂 vs 墨绿 vs 琥珀,2px vs 3px)
- 卡片化 details 在 paper 底色上的对比策略(底色微差 vs 阴影 vs border)
- chevron 字符 vs SVG 选型(单文件无依赖约束)
- B2-1 outer panel 的"S1~S12 子节"小标视觉(头部标签 vs 左侧脊柱标签)
- 移动端抽屉宽度(280px vs 80vw)与开启动画时长
- 顶部 hamburger 在桌面是否显示(默认隐藏,仅 sticky 主滚动时反向?— 简化:桌面始终隐藏)

frontend-design 输出物:`design.md` 末尾追加 "Visual Spec(by frontend-design)" 段;实施阶段照搬。

---

## 8 · Visual Spec(by frontend-design)

### 美学方向(锚定)

**Editorial · Letterpress Manuscript**(学术期刊 / 编辑红笔 / 印刷直角)。这不是 SaaS docs(Stripe/Linear),也不是现代极简(Vercel),而是 *Lapham's Quarterly* + *The New Yorker* 内文 + 旧学报排版 + brutalist letterpress 标记的现代演绎。

关键准则:
1. **克制压过响亮** — active / hover 要明确但不能像 button 跳出来,用 letter-spacing / 字体切换 / dashed 连线建立层级,而不是大面积 saturation。
2. **5 色语义不滥用** — 朱砂 = 当前焦点 / 墨绿 = 共享归组 / 琥珀 = 展开 & 强调 / 靛青 = 未来 / 紫罗兰 = 协议。本次新增 UI 元素严格沿用这套语义,不引入第 6 色。
3. **印刷直角 + offset 硬阴影** — 不用 Material soft shadow,圆角 ≤ 2px。需要"浮起"时用 letterpress 风的 offset 硬阴影(如 `2px 2px 0 0 var(--ink)`),按下时归零。
4. **手稿批注笔触** — `↳`、`›`、`§`、dashed border-left、mono uppercase letter-spacing 0.18em+ 都是"编辑批注"语汇,优先用它们做层级,而不是阴影/saturation。

### Spec 1 · sidebar Active 高亮

**Decision**:朱砂 2px 左条 + `--bg-2` 背景 + 朱砂文字 + 600 字重。

```css
.side-nav a {
  display: block;
  padding: 6px var(--gap-3);
  color: var(--ink-2);
  text-decoration: none;
  border: none;
  border-left: 2px solid transparent;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}
.side-nav a:hover {
  color: var(--ink);
  background: rgba(216,209,194,0.25);  /* --line 25% */
}
.side-nav a.active {
  color: var(--accent-2);
  background: var(--bg-2);
  border-left-color: var(--accent-2);
  font-weight: 600;
}
```

**Why**:朱砂 (`--accent-2`) 在系统里就是"当前焦点 / 决策位置"语义(`.hero h1 em` / `.sec-num` / `.now-focus` 左边都是它),`active = 读者当前所在`完美对应。2px 而非 3px,呼应克制底色;13px 字号下 3px 会显粗笨。

### Spec 2 · sidebar 四级层级

**Decision**:用 **字体族切换** + 字距递增 + 字号递减建立层级,而非颜色跳跃。S 子节(四级)切到 mono 字体,让其呈"技术清单条目"感与 Part A 章节(sans)区分。

```css
/* 一级:Part A / B group 标题 */
.side-nav h6 {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin: var(--gap-4) var(--gap-3) var(--gap-2);
  padding-bottom: var(--gap-2);
  border-bottom: 1px solid var(--line);
}
.side-nav h6::before {
  content: "§ ";
  color: var(--accent-2);
  font-family: var(--serif);
  font-weight: 600;
}

/* 二级:章节(Part A 01~07,Part B B0/B1/B2/B3) */
.side-nav > nav > div > ul > li > a {
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}

/* 三级:子节(B1.1/B1.2/.../B2.1/B2.7/B3.1~B3.4) */
.side-nav .nav-sub > li > a {
  font-family: var(--sans);
  font-size: 12px;
  font-weight: 400;
  color: var(--ink-2);
  padding-left: calc(var(--gap-3) + 10px);
}

/* 四级:B2.1 内 S1~S12 — 切到 mono,呈"目录章节卡"感 */
.side-nav .nav-sub-2 > li > a {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 400;
  color: var(--ink-3);
  padding-left: calc(var(--gap-3) + 22px);
  letter-spacing: 0.02em;
}
.side-nav .nav-sub-2 > li > a.active {
  color: var(--accent-2);
  background: var(--bg-2);
}

/* 连接线:用更精致的 dashed,不让 sidebar 显得线条乱 */
.side-nav .nav-sub {
  list-style: none;
  margin: 0 0 var(--gap-2) calc(var(--gap-3) + 6px);
  padding: 0;
  border-left: 1px dashed var(--line);
}
.side-nav .nav-sub-2 {
  margin-left: calc(var(--gap-3) + 4px);
  border-left: 1px dashed rgba(216,209,194,0.55);  /* --line 55%,更轻 */
}
```

**Why**:四级若全用 sans + 颜色递浅,会成"字号阶梯"乏味设计;切到 mono 给 S1~S12 一个"代码片段索引/章节卡"的视觉提示,与正文内容(reviewer 操作手册细节)语义对应。`§` 字符是学术手稿章节符号,放在一级标题首位强化"这是一本论著"的感受。

### Spec 3 · Part B `<details>` 卡片对比

**Decision**:**Border 主导 + open 顶部黑实线**。完全弃用 Material soft shadow,改为"翻开页签"的印刷语言。

```css
.part-b details {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 2px;            /* 接近直角,印刷感 */
  padding: 20px 28px;
  margin-bottom: 14px;
  transition: border-color 0.2s ease, background 0.2s ease;
  position: relative;
}

/* close 态:仅细边框,贴底 */
.part-b details:not([open]) {
  background: var(--paper);
}

/* hover:边框变深(用 ink-3 而非 line-strong,避免一跳就纯黑) */
.part-b details:hover {
  border-color: var(--ink-3);
}

/* open 态:顶部 2px 黑实线 + 边框微深 = "翻开的页签" */
.part-b details[open] {
  border-color: var(--ink-3);
  border-top: 2px solid var(--ink);
  background: var(--paper);
}

/* 嵌套 details(若 details 内有更深 details):墨绿左条 + 透明底 */
.part-b details details {
  border: none;
  border-left: 2px solid var(--line);
  border-radius: 0;
  padding: var(--gap-3) var(--gap-4);
  margin-top: var(--gap-3);
  background: transparent;
}
.part-b details details[open] {
  border-left-color: var(--accent);                /* 嵌套展开 → 墨绿(共享/既有) */
  background: rgba(44,93,63,0.025);                 /* 极薄墨绿底,几乎不可见 */
}
```

**Why**:Material soft shadow 会让卡片看起来"飘浮"于纸面之上 — 与 editorial 学术手稿底色冲突。改用 1px line border + open 时顶部 2px ink 实线,模拟"翻开的纸折页",这是 *The New Yorker* 部门 header 与古典书籍章节起首的常见印刷标记。直角 (`border-radius: 2px`) 强化印刷感。

### Spec 4 · summary chevron

**Decision**:Unicode `›` (U+203A · SINGLE RIGHT-POINTING ANGLE QUOTATION MARK) + serif 字体 + 琥珀色 + open 态 rotate 90°,hover 切朱砂。

```css
.part-b summary {
  cursor: pointer;
  list-style: none;
  font-family: var(--serif);
  font-size: 17px;
  font-weight: 600;
  color: var(--ink);
  padding-left: 30px;
  position: relative;
  user-select: none;
  line-height: 1.4;
}
.part-b summary::-webkit-details-marker { display: none; }
.part-b summary::before {
  content: "›";                                    /* U+203A 法式引号箭头,优雅且 editorial */
  position: absolute;
  left: 6px;
  top: 50%;
  transform: translateY(-55%) rotate(0);           /* 微调 -55% 因 › 几何重心偏上 */
  transform-origin: 50% 55%;
  font-family: var(--serif);                       /* serif 的 › 更圆润 */
  font-size: 24px;
  font-weight: 400;
  color: var(--accent-3);                          /* 琥珀:展开/强调语义 */
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), color 0.15s ease;
}
.part-b details[open] > summary::before {
  transform: translateY(-55%) rotate(90deg);
}
.part-b summary:hover { color: var(--ink); }
.part-b summary:hover::before { color: var(--accent-2); }  /* hover 时 chevron 切朱砂提示可点 */
```

**Why**:`▸` 实心三角与 editorial 调性冲突(过于实);`+/−` 太工程师;inline SVG 过度工程。`›` 是字面的"编辑/引文"符号,本就是 editorial 词汇。serif 字族让 chevron 与 summary 标题(serif)同根,视觉一气。颜色琥珀(展开语义) + hover 朱砂(可点击/焦点)— active sidebar 高亮也是朱砂,语义统一为"点这里 = 你要去的地方"。

### Spec 5 · B2-1 outer panel(reviewer S1~S12 群)

**Decision**:**左侧 3px 墨绿脊柱 + 顶部琥珀 mono small-caps `§ S1—S12 · reviewer 操作手册` 标签 + 右侧 12 节计数 + open 态顶 2px 黑实线**。视觉上像「编辑出版社的特别章节」。

```css
/* B2-1 外层 details 覆盖通用规则 */
.part-b details#b2-1 {
  border: 1px solid var(--ink-3);
  border-left: 3px solid var(--accent);   /* 墨绿脊柱 = 共享/归组语义 */
  background: var(--paper);
  padding: 24px 32px 32px;
  margin-bottom: var(--gap-5);
  border-radius: 2px;
}
.part-b details#b2-1[open] {
  border-top: 2px solid var(--ink);
  border-left-color: var(--accent);
}

/* 外层 summary 加 star 颜色 */
.part-b details#b2-1 > summary {
  font-size: 19px;
}
.part-b details#b2-1 > summary .star {
  color: var(--accent-2);                  /* ★ 切朱砂 */
  font-size: 0.85em;
  margin-left: 4px;
  vertical-align: 0.05em;
}

/* 新增 .panel-label 元素:置于 summary 之后,内含 12 节计数 */
.part-b .panel-label {
  margin: var(--gap-3) 0 var(--gap-4);
  padding: 0 0 var(--gap-2);
  border-bottom: 1px dashed var(--line);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent-3);                  /* 琥珀 */
  display: flex;
  align-items: baseline;
  gap: var(--gap-3);
}
.part-b .panel-label::before {
  content: "§";
  font-family: var(--serif);
  font-size: 18px;
  letter-spacing: 0;
  color: var(--accent);                    /* § 符号墨绿,呼应脊柱 */
  line-height: 1;
}
.part-b .panel-label .count {
  margin-left: auto;
  color: var(--ink-3);
  letter-spacing: 0.04em;
  font-size: 10px;
}

/* B2-1 内的所有 sub-details(S1~S12)用紧凑卡片 */
.part-b details#b2-1 > details {
  border: 1px solid var(--line);
  border-left: 2px solid var(--line);
  border-radius: 2px;
  background: var(--paper);
  padding: 16px 24px;
  margin: 12px 0;
}
.part-b details#b2-1 > details[open] {
  border-left-color: var(--accent);        /* S 节展开 → 左条墨绿(归属于 reviewer 群) */
  border-top-color: var(--ink-3);
  background: rgba(44,93,63,0.02);
}
.part-b details#b2-1 > details > summary {
  font-size: 15px;
  padding-left: 26px;
}
.part-b details#b2-1 > details > summary::before {
  font-size: 20px;
}
```

**HTML 用法**(在现有 `<details open id="b2-1">` 内 summary 之后插入):

```html
<details open id="b2-1">
  <summary>B2.1 flower-code-reviewer <span class="star">★</span></summary>
  <div class="panel-label">
    <span>S1 — S12 · reviewer 操作手册</span>
    <span class="count">12 节 · 默认仅 S1 / S2 / S3 展开</span>
  </div>
  <p style="font-size: 14px; color: var(--ink-3); margin-top: 0;">
    <em>本节是 flower-code-reviewer 的完整操作手册 ...</em>
  </p>
  <!-- S1~S12 12 个 <details> 不变 -->
</details>
```

**Why**:墨绿脊柱(`--accent` 共享/归组语义)从外卡片贯穿到内 S 子卡片(open 时左条墨绿),整组视觉绑成"reviewer 编年史";琥珀 mono uppercase + `§` 字符是 17~18 世纪学报章节标记的现代延伸,刚好让 reader 意识到"这是 12 节连读的特别章节";12 节计数提供 meta 提示。这一组合让 B2.1 在 7 个 package 中保有"主角光环"而不喧宾夺主。

### Spec 6 · 移动抽屉

**Decision**:宽度 `min(280px, 80vw)` / 240ms / `cubic-bezier(0.32, 0.72, 0, 1)`(iOS spring-out)/ 蒙层 `rgba(26,29,26,0.35)` 无 backdrop-filter。

```css
@media (max-width: 767px) {
  .side-nav {
    width: min(280px, 80vw);
    transform: translateX(-100%);
    transition: transform 240ms cubic-bezier(0.32, 0.72, 0, 1);
    box-shadow:
      1px 0 0 0 var(--line-strong) inset,           /* 右侧装订硬线(inset) */
      8px 0 24px rgba(26,29,26,0.12);               /* 微弱外阴影 */
    z-index: var(--z-sidebar);
  }
  .side-nav.show {
    transform: translateX(0);
  }
  .nav-scrim {
    background: rgba(26,29,26,0.35);                /* ink 35%,克制 */
    opacity: 0;
    pointer-events: none;
    transition: opacity 240ms cubic-bezier(0.32, 0.72, 0, 1);
    /* 不用 backdrop-filter — 性能 + 米色底透出会浑浊 */
  }
  .nav-scrim.show {
    opacity: 1;
    pointer-events: auto;
  }
}
```

**Why**:280px 在小屏(360px+)上够展示 TOC,80vw 在 320px 屏不撑满留 20% 关闭区;240ms 比 iOS 默认 250ms 微缩,微觉 "snappy";cubic-bezier(0.32, 0.72, 0, 1) 是 iOS spring-out 曲线,出场有微弹但收住;蒙层 0.35 比 0.4 克制呼应米色基调;inset 1px 黑硬线模拟"纸张装订线",是学术手稿装帧感。

### Spec 7 · hamburger 按钮

**Decision**:44×44 / 方角 0 radius / paper 底 / 1px `--line-strong` 边框 / 三杠 2px `--ink` / **2px offset 硬阴影 letterpress** / active 时 offset 归零 = 按压感。

```css
.nav-toggle {
  display: none;
  position: fixed;
  top: var(--gap-3);
  left: var(--gap-3);
  width: 44px;
  height: 44px;
  background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: 0;                                 /* 方角:brutalist editorial */
  padding: 0;
  cursor: pointer;
  z-index: var(--z-toggle);
  box-shadow: 2px 2px 0 0 var(--ink);               /* letterpress offset 硬阴影 */
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.nav-toggle:hover { background: var(--bg-2); }
.nav-toggle:active {
  transform: translate(2px, 2px);
  box-shadow: 0 0 0 0 var(--ink);                   /* 按压归零 — 印章感 */
}

.nav-toggle span {
  display: block;
  width: 22px;
  height: 2px;
  background: var(--ink);
  margin: 4px auto;
  transform-origin: center;
  transition: transform 0.22s ease, opacity 0.22s ease;
}
.nav-toggle[aria-expanded="true"] span:nth-child(1) {
  transform: translateY(6px) rotate(45deg);
}
.nav-toggle[aria-expanded="true"] span:nth-child(2) {
  opacity: 0;
  transform: scaleX(0);
}
.nav-toggle[aria-expanded="true"] span:nth-child(3) {
  transform: translateY(-6px) rotate(-45deg);
}

@media (max-width: 767px) {
  .nav-toggle { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; }
}
```

**Why**:圆角 0 + offset 硬阴影 = letterpress / brutalist 编辑印章美学(对照硅谷圆角软按钮),按下 offset 归零给出明确触觉反馈 —— 这是 70 年代印刷机械的视觉延伸,完美呼应 editorial / 学术手稿主题。22px 三杠粗 2px 与 sidebar 中 active 左条同粗,形成跨组件的"边线宽度"统一语言。

### Spec 8 · 整体节奏与 Part 分隔

#### 8a · section padding 不对称(顶<底,营造"换气")

```css
section { padding: 80px 0 96px; }              /* 桌面 */
@media (max-width: 1180px) {
  section { padding: 64px 0 80px; }            /* 平板 */
}
@media (max-width: 767px) {
  section { padding: 48px 0 56px; }            /* 移动 */
}
.wrap { padding: 0 var(--gap-5); }             /* 桌面 32px */
@media (max-width: 767px) {
  .wrap { padding: 0 20px; }
}
```

**Why**:editorial / 杂志页 section padding 常有不对称(顶 80 / 底 96),让"这章节首贴上一章尾,但章节尾 generous 留白让读者放气"。

#### 8b · Part A↔Part B 的"翻页"分隔

`<header class="part-divider">` 改造为"墨色扉页 + 琥珀厚底边",像翻到新书章节:

```css
.part-divider {
  background: var(--ink);
  color: var(--paper);
  padding: 120px 0 96px;
  margin: 0;
  border-top: 1px solid var(--line-strong);
  border-bottom: 8px solid var(--accent-3);        /* 琥珀厚边 = 期刊章节标识 */
  position: relative;
}
.part-divider::before {
  content: "PART B";
  position: absolute;
  top: var(--gap-5);
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.4em;                            /* 极大字距 = 印刷扉页 */
  color: var(--accent-3);
}
.part-divider h2 {
  font-family: var(--serif);
  font-size: clamp(56px, 8vw, 96px);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.05;
  margin: 0 0 var(--gap-4);
}
.part-divider .sub {
  font-size: 19px;
  color: rgba(251,248,243,0.78);                    /* paper 78% */
  max-width: 640px;
}
@media (max-width: 767px) {
  .part-divider { padding: 80px 0 64px; border-bottom-width: 6px; }
}
```

**Why**:从米色 Part A 进入墨色 Part B = 翻开"新书"的扉页 (`hero` 的米色和这里墨色形成强反差);琥珀 8px 厚底边 + uppercase mono `PART B` letter-spacing 0.4em = *LRB / Lapham's Quarterly* 杂志章节起首的常见标记。

#### 8c · 卡片密度与首屏节奏

close 态卡片高度目标:**80px**(`padding: 20px 28px` + summary line-height 1.4 + margin-bottom 14 ≈ 80)。

每屏(viewport 800px 高,扣除 sec-head ~120px):内容区约 680px,可见 close 态卡片约 7~8 张。

但实际首次进入 Part B,读者期待"看到 Part B 整体地图":
- B0 引子(section 不是 details,~200px)
- B1 标题 + B1.1 open(~400px)
- B2 标题 + B2.1 open(panel-label 可见,S1 open)

首屏(~3 张主卡片) → 滚一屏到 B2.1 内 S2~S3 → 滚两屏看到 S4~S12 close 列表 + B2.2~B2.7 close 列表 = **3 屏建立全局地图**,这是合适的密度。

```css
/* Part B section 整体节奏更紧凑(因为 details 已经分块,section padding 不需大) */
.part-b > section { padding: 64px 0 80px; }
.part-b > section > .wrap > .sec-head { margin-bottom: var(--gap-5); }  /* 32px,而非 56 */
.part-b > section > .wrap > p { margin: 0 0 var(--gap-3); }
```

#### 8d · sidebar 内部节奏

sidebar 内 `padding: var(--gap-5) 0 var(--gap-4);` 顶部留 32px 给 brand,group 间留 24px。一级 h6 之间用 `border-bottom: 1px solid var(--line)`(在 8b 已加)而非空白,呼应学报手稿的"刻线分章"。

---

**Visual Spec 已写入 design.md § 8**。8 个 Spec 全部给出 Decision + CSS 草模 + Why,实施阶段可直接复用,无任何外部依赖,纯用现有 token + 单文件 inline。
