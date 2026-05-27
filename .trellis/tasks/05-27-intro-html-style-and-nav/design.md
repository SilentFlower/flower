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

---

## 9 · Visual Spec v2(sidebar 重做 · by frontend-design)

### v2 美学方向(从 v1 调整)

v1 走的是 **brutalist editorial**(密集铺陈 + `§` 学术符号 + mono 技术清单 + dashed 连线)。用户反馈:零碎、机械、滚动条丑、TOC 太长。

v2 重定位为 **refined editorial · Library of America colophon × Paris Review 目录页**:
- *Library of America* 文集扉页 — 大字 italic serif 书名 + uppercase mono caption + 一道琥珀细线
- *Paris Review* 目录 — 罗马数字(I. II. III.)替代阿拉伯,serif italic 灰
- *Pelican Books 1960s* 装帧 — 留白主导,字号差不靠粗细而靠 family + letter-spacing
- *18 世纪学报手稿* — 一级标题上下用极细 ink-3 横线 + em-dash 收尾(章节书写笔触)

关键准则升级:
1. **垂直线退场** — 没有 dashed,没有 solid 长左条。层级靠 `padding-left` 阶梯 + prefix 编号。
2. **active 是红铅笔批注** — 一个 14px 高 × 2px 宽朱砂短条贴在文字旁,而不是占满行高的"左 rail"。这是 editor 真实笔触。
3. **prefix 是主角** — 罗马数字 / 章节号 / "S1" 单字符 用 serif italic 灰,把数字提升为视觉锚,章节名做注解。
4. **折叠是必需,不是奢侈** — 二级 B1/B2/B3 default close,scrollspy 自动展开当前阅读所在节,移出自动收起(限同时只一个 auto-opened)。用户手动 open 锁定保留。
5. **滚动条不可见,直到 hover** — paper-on-paper 透明,hover sidebar 才浮现极细灰 thumb。

### Spec A · 可折叠层级(同时只展开当前所在主节点)

**Decision**:用语义 `<details>` 不行(summary 内嵌 `<a>` 会和 toggle 冲突),改 **div + JS 控制 + CSS max-height 过渡** 方案。

```html
<nav class="side-nav-toc">

  <!-- Part A · 6 节,平铺无折叠(只有 6 项,不必收) -->
  <section class="nav-group">
    <h6>Part A · 愿景</h6>
    <ol class="nav-list">
      <li class="nav-item">
        <div class="nav-line">
          <a class="nav-link" href="#sec-arch" data-target="sec-arch">
            <span class="prefix"><em>I</em></span>
            <span class="chapter">架构 · 一座洋葱</span>
          </a>
        </div>
      </li>
      <li class="nav-item">
        <div class="nav-line">
          <a class="nav-link" href="#sec-pi" data-target="sec-pi">
            <span class="prefix"><em>II</em></span>
            <span class="chapter">pi 是什么</span>
          </a>
        </div>
      </li>
      <!-- III · IV · V · VI 同 -->
    </ol>
  </section>

  <!-- Part B · 主节点可折叠 -->
  <section class="nav-group">
    <h6>Part B · 工程手册</h6>
    <ol class="nav-list">

      <!-- B0 引子:无子节,纯 link -->
      <li class="nav-item">
        <div class="nav-line">
          <a class="nav-link" href="#b0-intro" data-target="b0-intro">
            <span class="prefix"><em>B0</em></span>
            <span class="chapter">引子</span>
          </a>
        </div>
      </li>

      <!-- B1:可折叠主节点,默认 close -->
      <li class="nav-item has-children" data-state="closed">
        <div class="nav-line">
          <a class="nav-link" href="#b1-pi" data-target="b1-pi">
            <span class="prefix"><em>B1</em></span>
            <span class="chapter">pi 框架深度分析</span>
          </a>
          <button type="button" class="nav-caret" aria-label="展开 B1" aria-expanded="false">›</button>
        </div>
        <ol class="nav-sub" aria-hidden="true">
          <li><a class="nav-link" href="#b1-1" data-target="b1-1">
            <span class="prefix">§ 1.1</span><span class="chapter">API 表面</span></a></li>
          <li><a class="nav-link" href="#b1-2" data-target="b1-2">
            <span class="prefix">§ 1.2</span><span class="chapter">内部运作机制</span></a></li>
          <li><a class="nav-link" href="#b1-3" data-target="b1-3">
            <span class="prefix">§ 1.3</span><span class="chapter">flower 怎么用 pi</span></a></li>
          <li><a class="nav-link" href="#b1-4" data-target="b1-4">
            <span class="prefix">§ 1.4</span><span class="chapter">设计哲学 · 同类对比</span></a></li>
        </ol>
      </li>

      <!-- B2:可折叠 + 内嵌 B2.1 二级折叠 -->
      <li class="nav-item has-children" data-state="closed">
        <div class="nav-line">
          <a class="nav-link" href="#b2-packages" data-target="b2-packages">
            <span class="prefix"><em>B2</em></span>
            <span class="chapter">7 个 package</span>
          </a>
          <button type="button" class="nav-caret" aria-expanded="false">›</button>
        </div>
        <ol class="nav-sub" aria-hidden="true">

          <!-- B2.1:再嵌一层 details(S1-S12) -->
          <li class="nav-item nav-item-inner has-children" data-state="closed">
            <div class="nav-line">
              <a class="nav-link" href="#b2-1" data-target="b2-1">
                <span class="prefix">§ 2.1</span>
                <span class="chapter">flower-code-reviewer <span class="star">★</span></span>
              </a>
              <button type="button" class="nav-caret" aria-expanded="false">›</button>
            </div>
            <ol class="nav-sub nav-sub-inner" aria-hidden="true">
              <li><a class="nav-link" href="#b2-1-s1" data-target="b2-1-s1">
                <span class="prefix"><em>S1</em></span><span class="chapter">一句话定位</span></a></li>
              <li><a class="nav-link" href="#b2-1-s2" data-target="b2-1-s2">
                <span class="prefix"><em>S2</em></span><span class="chapter">触发链路图</span></a></li>
              <!-- S3 ~ S12 同 -->
            </ol>
          </li>

          <!-- B2.2 ~ B2.7:平 link -->
          <li class="nav-item">
            <div class="nav-line">
              <a class="nav-link" href="#b2-2" data-target="b2-2">
                <span class="prefix">§ 2.2</span><span class="chapter">flower-providers</span></a>
            </div>
          </li>
          <!-- 2.3 ~ 2.7 同 -->
        </ol>
      </li>

      <!-- B3:可折叠主节点 -->
      <li class="nav-item has-children" data-state="closed">
        <div class="nav-line">
          <a class="nav-link" href="#b3-dataflow" data-target="b3-dataflow">
            <span class="prefix"><em>B3</em></span>
            <span class="chapter">跨包数据流</span>
          </a>
          <button type="button" class="nav-caret" aria-expanded="false">›</button>
        </div>
        <ol class="nav-sub" aria-hidden="true">
          <li><a class="nav-link" href="#b3-1" data-target="b3-1">
            <span class="prefix">§ 3.1</span><span class="chapter">LLM 调用链</span></a></li>
          <!-- 3.2 ~ 3.4 同 -->
        </ol>
      </li>

    </ol>
  </section>
</nav>
```

```css
/* nav-item / nav-line / nav-caret 基础 */
.side-nav .nav-list { list-style: none; padding: 0; margin: 0; }
.side-nav .nav-item { margin: 0; }
.side-nav .nav-line {
  display: flex;
  align-items: stretch;
  gap: 0;
  position: relative;
}
.side-nav .nav-link {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 12px 5px 24px;
  color: var(--ink-2);
  text-decoration: none;
  border: none;
  transition: color 0.15s ease;
  position: relative;
  line-height: 1.45;
}
.side-nav .nav-link:hover { color: var(--ink); background: transparent; }

/* caret 按钮(只在 has-children 时显示) */
.side-nav .nav-caret {
  flex: 0 0 auto;
  width: 28px;
  background: none;
  border: none;
  padding: 0 8px 0 0;
  cursor: pointer;
  font-family: var(--serif);
  font-size: 18px;
  font-weight: 400;
  color: var(--accent-3);            /* 琥珀,与 Part B 卡片化 chevron 同语 */
  line-height: 1;
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), color 0.15s ease;
  display: none;                      /* 默认隐藏,只在 has-children 显形 */
  align-items: center;
  justify-content: center;
}
.side-nav .nav-item.has-children > .nav-line > .nav-caret { display: inline-flex; }
.side-nav .nav-caret:hover { color: var(--accent-2); }
.side-nav .nav-item[data-state="open"] > .nav-line > .nav-caret { transform: rotate(90deg); }

/* sub-list 折叠 / 展开 */
.side-nav .nav-sub {
  list-style: none;
  padding: 0;
  margin: 0;
  overflow: hidden;
  max-height: 0;
  transition: max-height 0.24s cubic-bezier(0.4, 0, 0.2, 1);
}
.side-nav .nav-item[data-state="open"] > .nav-sub { max-height: 800px; }

/* 二级缩进 / 三级缩进 / 四级缩进 — 完全靠 padding,无 vertical line */
.side-nav .nav-sub > .nav-item > .nav-line > .nav-link {
  padding-left: 36px;
}
.side-nav .nav-sub-inner > .nav-item > .nav-line > .nav-link {
  padding-left: 52px;
}
```

**Why**:
- 不用 `<details>` 是因为 `<summary>` 内放 `<a>` 在多数浏览器会和 toggle 冲突(点 link 会同时 toggle details),需要 JS preventDefault — 与其打补丁,不如直接用 div + JS 控制干净。
- max-height transition 是 CSS-only 折叠动画的标配,800px 留余量;真实 max 仅 ~480px(B2 含 7 子节)。
- caret 用 Part B 内卡片化 chevron 的同款 `›` 琥珀 serif 字符,**两处视觉 echo**:sidebar 折叠的 caret 与正文 details 的 chevron 同源 — 读者会下意识知道"哪里能展开"。

### Spec B · 滚动条(默认透明,hover 浮现)

**Decision**:overlay 透明 + sidebar hover 时显形,Webkit thumb 6px 灰、Firefox thin 系统 fallback。永远不影响 layout(`overflow-y: scroll` 占位 6px,但 thumb 透明时看不见)。

```css
.side-nav {
  overflow-y: auto;
  /* Firefox:细 + 默认透明 */
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
  transition: scrollbar-color 0.2s ease;
}
.side-nav:hover {
  scrollbar-color: var(--line) transparent;
}

/* Webkit/Blink:更精细控制 */
.side-nav::-webkit-scrollbar {
  width: 6px;
  background: transparent;
}
.side-nav::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 0;
  transition: background 0.2s ease;
}
.side-nav:hover::-webkit-scrollbar-thumb {
  background: var(--line);
}
.side-nav:hover::-webkit-scrollbar-thumb:hover {
  background: var(--ink-3);
}
.side-nav::-webkit-scrollbar-track {
  background: transparent;
}
```

**Why**:editorial 学术手稿的纸面上不该有"机器化的灰条"。透明默认 = 不打扰阅读;hover 显形 = 必要时找得到。Webkit 的 thumb 6px 配 `--line` 米色调,从 paper 上"浮起"但不抢戏。

### Spec C · 去 dashed,改罗马数字 + 章节号 prefix

**Decision**:**留白阶梯 + serif italic prefix**(Paris Review 目录手法)。Part A 用罗马数字 I-VI;Part B 主节点用 mono "B0/B1/B2/B3";三级用 `§ 1.1` 等 mono;四级 S1-S12 用 serif italic。**完全不用 vertical line**。

```css
/* prefix 通用:左对齐 min-width,baseline 与 chapter 对齐 */
.side-nav .prefix {
  flex: 0 0 auto;
  min-width: 24px;
  display: inline-block;
  text-align: right;
  font-size: 11px;
  color: var(--ink-3);
  letter-spacing: 0;
}
.side-nav .prefix em {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--ink-3);
  font-size: 12px;            /* serif italic 数字稍大一点更优雅 */
}
.side-nav .nav-sub .prefix {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.02em;
  font-weight: 500;
}
.side-nav .nav-sub-inner .prefix em {
  font-family: var(--serif);
  font-style: italic;
  font-size: 11px;
  color: var(--ink-3);
}

/* chapter 文字 */
.side-nav .chapter {
  flex: 1;
  font-family: var(--sans);
  font-size: 13px;
  color: var(--ink);
  font-weight: 400;
  letter-spacing: 0;
}
.side-nav .nav-sub .chapter {
  font-size: 12px;
  color: var(--ink-2);
}
.side-nav .nav-sub-inner .chapter {
  font-size: 11.5px;
  color: var(--ink-2);
}
.side-nav .star {
  color: var(--accent-2);
  font-size: 0.85em;
  vertical-align: 0.05em;
  margin-left: 2px;
}
```

**Why**:
- Roman numerals(I-VI)serif italic 是 17~18 世纪学报章节经典手法,比阿拉伯数字更"古典文献感",和"洋葱 / pi / 同根不同枝"这类思想章节内容相匹配。
- mono 仅出现在 prefix(B0/B1/§ 1.1 等),不是 chapter 文字 — **prefix = 编号 = 技术坐标,用 mono;chapter = 章节名 = 散文,用 sans**。语义对齐让 mono 不再"console 感"。
- 阶梯靠 `padding-left: 24 / 36 / 52` 三档,无 vertical line。读者眼睛沿 padding 自然下移,不被横竖线分散。

### Spec D · 四级 S1-S12 — serif italic 数字 + sans 章节

**Decision**:候选 C — serif italic "S1"/"S2"... 数字 + sans 11.5px 章节文字(详见 Spec C 中 `.nav-sub-inner` CSS)。

**Why**:S 子节是"reviewer 操作手册"的具体小节,既要"按编号查找"(用 italic serif 古典数字标号)又要"扫读章节名"(sans 易扫描)。这两个目标分给 prefix 和 chapter 两个 span 各司其职,比 v1 全 mono 的"console 行"优雅得多。

### Spec E · active marker · 红铅笔批注

**Decision**:**朱砂字色 + 600 + 左侧 ::before 红铅笔短条**(14px 高 × 2px 宽,贴在 prefix 左边)。无 bg、无整行左 rail。

```css
.side-nav .nav-link.active {
  color: var(--accent-2);
  font-weight: 500;
}
.side-nav .nav-link.active .prefix,
.side-nav .nav-link.active .prefix em,
.side-nav .nav-link.active .chapter {
  color: var(--accent-2);
}
.side-nav .nav-link.active::before {
  content: "";
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 14px;
  background: var(--accent-2);
  border-radius: 0;
  /* 略微倾斜,像红铅笔斜划一道(可选) */
  /* transform: translateY(-50%) skewX(-6deg); */
}

/* 二级 nav-sub 的 active marker 位置微调(对齐到 prefix 起点左侧) */
.side-nav .nav-sub .nav-link.active::before { left: 24px; }
.side-nav .nav-sub-inner .nav-link.active::before { left: 40px; }
```

**Why**:整行 2px 左条是 SaaS "selected button" 美学;14px 短条是真实编辑用红铅笔在书页旁做的"我读到这里" 批注。短条紧贴 prefix 左侧空白处,与文字基线对齐,克制且 editorial。可选的 `skewX(-6deg)` 让短条略斜,模拟笔触的"运笔感"— 取决于实施时实际视觉。

### Spec F · brand 区(扉页 colophon)

**Decision**:**italic serif 28px "Flower" + uppercase mono 9.5px caption 0.28em + 极细琥珀 1px hr 收尾**。

```html
<header class="side-nav-head">
  <a href="#top" class="side-nav-brand">Flower</a>
  <div class="side-nav-caption">Architecture · Decisions · Vision</div>
  <div class="side-nav-meta">v0.1.0 — 2026·05</div>
  <button class="side-nav-close" aria-label="关闭导航">×</button>
</header>
```

```css
.side-nav-head {
  padding: 36px 24px 26px;
  position: relative;
}
.side-nav-head::after {
  content: "";
  position: absolute;
  left: 24px; right: 24px; bottom: 0;
  height: 1px;
  background: var(--accent-3);
  opacity: 0.55;
}
.side-nav-brand {
  display: block;
  font-family: var(--serif);
  font-style: italic;
  font-size: 28px;
  font-weight: 600;
  color: var(--ink);
  line-height: 1;
  letter-spacing: -0.01em;
  text-decoration: none;
  border: none;
  margin-bottom: 12px;
  transition: color 0.15s ease;
}
.side-nav-brand:hover { color: var(--accent-2); }
.side-nav-caption {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 6px;
  line-height: 1.4;
}
.side-nav-meta {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--ink-3);
  opacity: 0.7;
}
.side-nav-close {
  display: none;          /* 桌面隐藏,移动端 @media 显示 */
  position: absolute;
  top: 32px; right: 18px;
  background: none;
  border: none;
  font-size: 24px;
  line-height: 1;
  color: var(--ink-3);
  cursor: pointer;
  padding: 4px 8px;
}
.side-nav-close:hover { color: var(--accent-2); }
```

**Why**:Library of America 文集扉页就是这个版式 — 大字 italic serif 书名(Flower)+ 下方 UPPERCASE LATIN 字距 0.28em 子标题(Architecture · Decisions · Vision)+ 一道琥珀细线收尾。把 v1 那个 16px serif + 10px small 的"小气 brand"升级为"扉页 colophon",sidebar 顶部有了视觉锚,眼睛进入就有"我打开了一本书"的暗示。

### Spec G · § 朱砂前缀去掉,改 em-dash 收尾

**Decision**:**完全删除 h6::before 的 § 朱砂前缀**。一级 group label 改为:**上方 1px ink-3 横线 + mono uppercase 0.22em + 后置 serif italic em-dash 收尾**。

```css
.side-nav h6 {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin: 28px 24px 14px;
  padding-top: 16px;
  border-top: 1px solid var(--line);     /* 上方细线(取代 § 前缀的引导) */
  display: flex;
  align-items: center;
  gap: 12px;
}
.side-nav h6::after {
  content: "—";
  font-family: var(--serif);
  font-style: italic;
  font-weight: 400;
  font-size: 14px;
  color: var(--ink-3);
  letter-spacing: 0;
  opacity: 0.6;
  flex: 1;
  text-align: left;
}
```

**Why**:`§` 在 v1 是想"学术手稿装饰",但它在每个 h6 前面重复出现就像"商店挂的招牌"重了。删掉后,group label 上方一条极细 ink-3 横线代替 § 担任"引导视线" 的功能,后面 em-dash 像"章节书写完后的笔触收尾"(17 世纪手稿常见)— 比固定的 § 符号更有手作感。

### Spec H · 实施变更清单(相对 v1)

**CSS · 需要删除**(v1 中的):
1. `.side-nav h6::before { content: "§ "; ... }` — § 朱砂前缀
2. `.side-nav h6 { border-bottom: 1px solid var(--line); }` — 改为 border-top
3. `.side-nav .nav-sub { border-left: 1px dashed var(--line); }` — 删 dashed 连线
4. `.side-nav .nav-sub-2 { border-left: 1px dashed rgba(216,209,194,0.55); }` — 同上
5. `.side-nav a.active { background: var(--bg-2); border-left-color: var(--accent-2); }` — active bg 与 border-left 全删
6. `.side-nav .nav-sub-2 > li > a { font-family: var(--mono); ... }` — 四级 mono 字
7. v1 brand 区 16px serif "Flower" + small mono — 全替换

**CSS · 需要新增**:
1. `.side-nav-head` + `.side-nav-brand` + `.side-nav-caption` + `.side-nav-meta` + `.side-nav-head::after`(扉页 colophon)
2. `.side-nav .nav-item / .nav-line / .nav-link / .nav-caret`(替代旧 `a` 通用)
3. `.side-nav .nav-sub { overflow: hidden; max-height: 0; transition: max-height ... }` + `[data-state="open"]` 切换
4. `.side-nav .nav-link.active::before { width: 2px; height: 14px; ... }`(红铅笔短条)
5. `.side-nav .prefix` + `.chapter` + `.prefix em`(prefix 系统)
6. `.side-nav { scrollbar-width: thin; scrollbar-color: transparent transparent; }` + hover 显形 + Webkit
7. `.side-nav h6 { border-top + ::after em-dash }`(取代 § 前缀)

**HTML · 需要重构 sidebar 内**(line 1015-1100 区间):
1. brand 区:从 `<a class="brand"><small>...` 改为 `.side-nav-head` 三行结构(brand / caption / meta)
2. 每个 `<li><a href="...">...</a></li>` 改为 `<li class="nav-item"><div class="nav-line"><a class="nav-link" href="..." data-target="..."><span class="prefix">...</span><span class="chapter">...</span></a></div></li>`
3. Part A 6 节 prefix:`<em>I</em>` ~ `<em>VI</em>`(罗马数字 italic serif)
4. Part B 主节点:加 `class="nav-item has-children" data-state="closed"` + 后接 `<button class="nav-caret">›</button>` + 包 `<ol class="nav-sub" aria-hidden="true">`
5. B0 引子:`<em>B0</em>` 作为 prefix
6. B1/B2/B3:`<em>B1</em>` 等
7. B1 子节 1.1~1.4 prefix:`§ 1.1` ~ `§ 1.4`(无 em,纯 mono)
8. B2.1 嵌套:`class="nav-item nav-item-inner has-children"`,内部 `<ol class="nav-sub nav-sub-inner">`,prefix:`<em>S1</em>` ~ `<em>S12</em>`
9. B2.2~B2.7 prefix:`§ 2.2` ~ `§ 2.7`
10. B3 子节 prefix:`§ 3.1` ~ `§ 3.4`

**JS · 需要新增**(在 v1 scrollspy + hamburger 之外):
1. caret click handler:toggle `data-state="open"|"closed"` + `aria-expanded` + `aria-hidden`
2. scrollspy active 联动 auto-open:
   - 当 active 切到一个 nav-link 时,找它最近的 `.nav-item.has-children` 祖先(若有),`data-state="open"`,标记 `data-auto="true"`
   - 同时收起其它 `data-auto="true"` 的兄弟主节点(限同时只一个 auto-opened)
   - 用户手动点 caret 后,移除 `data-auto`,改为 `data-manual="true"`,scrollspy 不再 auto-close 它
3. **保留** v1 的 IntersectionObserver / hamburger / scrim / Escape / 链接点击关抽屉 逻辑

**JS 控制逻辑**(伪代码):
```js
// caret click
nav.querySelectorAll('.nav-caret').forEach(caret => {
  caret.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const item = caret.closest('.nav-item');
    const open = item.dataset.state === 'open';
    item.dataset.state = open ? 'closed' : 'open';
    caret.setAttribute('aria-expanded', String(!open));
    item.querySelector(':scope > .nav-sub')?.setAttribute('aria-hidden', String(open));
    item.dataset.manual = 'true';  // 锁定用户态
    delete item.dataset.auto;
  });
});

// scrollspy 中,activate(id) 改造:
function activate(id) {
  // ... 原逻辑切换 .active class ...
  const link = document.querySelector('.side-nav [data-target="' + id + '"]');
  if (!link) return;
  link.classList.add('active');

  // auto-open 当前 nav-link 的 has-children 祖先
  const item = link.closest('.nav-item.has-children');
  // 先 close 其它 data-auto 但非 manual 的兄弟主节点
  document.querySelectorAll('.nav-item.has-children[data-auto="true"]').forEach(el => {
    if (el !== item && !el.dataset.manual) {
      el.dataset.state = 'closed';
      delete el.dataset.auto;
      el.querySelector(':scope > .nav-line > .nav-caret')?.setAttribute('aria-expanded', 'false');
    }
  });
  if (item && item.dataset.state !== 'open') {
    item.dataset.state = 'open';
    item.dataset.auto = 'true';
    item.querySelector(':scope > .nav-line > .nav-caret')?.setAttribute('aria-expanded', 'true');
  }
}
```

**响应式 @media**:
- 移动端 (< 768px) `.side-nav-close { display: inline-block; }`(brand 区右侧 ×)
- 平板 (768~1180) sidebar 宽 200px 时,`.nav-link { padding-left: 18px; }` 缩进减小

---

**sidebar v2 Visual Spec 已写入 design.md § 9**。核心改动:删 dashed + 删 § 前缀 + 删 active bg → 加扉页 colophon + 罗马数字 prefix + 红铅笔批注 + 折叠 nav-sub + 透明滚动条。视觉转向 *Library of America × Paris Review* 杂志 left rail,从 v1 的"密集 docs reference"撤退到"克制 editorial 目录"。
