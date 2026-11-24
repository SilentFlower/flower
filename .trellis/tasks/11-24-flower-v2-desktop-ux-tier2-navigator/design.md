# 会话导航条技术设计

行号以 2026-11-24 `v2`（`c88b732c`）为准。`W/` = `apps/desktop/workbench/`。

## 边界

- 纯渲染层功能：不新增 IPC、不改共享运行时与持久化。数据来自 `thread()` 已有的消息视图与记录。
- 导航条挂在 `.conversation-body` 上绝对定位，不进入 `#thread-scroll` 的文档流，不改变消息列宽度与阅读位置逻辑。

## 结构

`W/index.html` 在 `#thread-scroll` 后增加：

```html
<nav id="thread-navigator" class="thread-navigator" aria-label="会话导航" hidden>
	<ol class="navigator-ticks" id="navigator-ticks"></ol>
	<div class="navigator-card" id="navigator-card" hidden><strong></strong><p></p></div>
</nav>
```

`.conversation-body` 加 `position: relative`。导航条 `top`/`height` 由脚本对齐滚动区域可视范围，`left` 取消息列左侧留白的中线；容器 `pointer-events: none`，只有刻度列表与卡片接收指针，避免整条透明区域挡住留白处的点击。刻度列表纵向居中，最大高度为导航条的 60%，超出时自身纵向滚动。刻度列表只有 28 像素宽，`softScroll` 的 12 像素滑块会挤占命中区，因此改用 `scrollbar-width: none` 完全隐藏滚动条（不调用 `softScroll`），靠滚轮与当前刻度自动滚入视野定位。

## `ui/agent.js`

- `thread(root, scroll, actions, bottom, navigator)`：第五个参数可选，未传时行为不变（兼容现有调用与 Windows Markdown 脚本）。
- 纯函数（挂在 `agentUI` 上供单测）：
  - `navigatorTurn(tops, viewport, atBottom)`：`tops` 为各轮顶部相对视口的偏移。贴底（距底部小于 65 像素，与「回到底部」同一阈值）返回最后一轮；否则返回最后一个 `top <= viewport / 3` 的下标，都不满足时为 0；空数组返回 -1。
  - `turnPreview(record, replyText)`：返回 `{ title, body }`。`title` 取 `input` 去首尾空白，空时为附件名以「、」连接，再空为「（无文字）」；`body` 在 `replyText` 有内容时取压缩空白后的前 160 字，否则按状态：`queued`/`running` 为「正在处理…」，`failed` 为 `failure` 或「运行失败」，`cancelled` 为「已取消」，`interrupted` 为「上次运行已中断」，`denied` 为「未获授权」，其余为空。
- 刻度：`<li><button class="navigator-tick" data-request aria-label="第 N 轮：<title 前 40 字>" tabindex="-1">`，当前刻度 `aria-current="true"`、`tabindex="0"`（roving tabindex）。按请求 ID 复用刻度节点，新增轮次时不打断刻度上的键盘焦点。消息视图增加 `reply` 字段指向回复正文节点，供预览读取纯文本。
- 同步时机：
  - `update(records)` 末尾：轮次 ID 序列变化时重建刻度，否则只刷新 `aria-label`；随后 `syncNavigator()`。
  - `scroll` 事件经 `requestAnimationFrame` 合并后 `syncNavigator()`；`ResizeObserver` 观察滚动容器。
  - `reset()` 清空刻度并隐藏。
- `syncNavigator()`：显示条件为轮次 ≥ 3、`scrollHeight > clientHeight`、消息列左侧留白（`root` 内容区左缘，即左缘加左内边距，减滚动容器左缘）≥ 40 像素；计算当前轮次并更新高亮，当前刻度在导航条内 `scrollIntoView({ block: "nearest" })`。
- 预览卡：刻度 `pointerenter`/`focus` 时用 `turnPreview(record, 回复节点的 textContent)` 填充，`top` 对齐刻度；导航条 `pointerleave`、焦点离开导航条或 Esc 时隐藏。卡片是导航条的子元素，指针移入卡片仍在 `:hover` 范围内，透明 `::before` 桥接刻度与卡片间的空隙。
- 跳转：`scroll.scrollTo({ top: scroll.scrollTop + 该轮顶部相对视口偏移 - 12, behavior })`，`behavior` 按 `prefers-reduced-motion` 选 `auto` 或 `smooth`；焦点留在刻度。
- 键盘：在导航条上处理 ↑/↓/Home/End 移动焦点（同时更新 roving tabindex），Enter/Space 跳转，Esc 收起卡片。

## `W/renderer.js`

`agentUI.thread(...)` 调用处传入 `by("thread-navigator")`。

## 样式（`W/style.css`）

- 刻度按钮命中区约 28×8 像素，可见线条 12×2 像素，当前 20×3 像素；颜色普通 `--edge`、悬停 `--muted`、当前 `--ink`；聚焦用现有焦点环。
- 卡片宽 280 像素、`--surface` 背景、`--line` 边框与阴影；标题两行、正文三行截断。
- 减弱动效时无过渡；强制颜色模式下刻度用 `CanvasText`，当前刻度加粗。

## 测试

- 新增 `testing/navigator.test.mjs`（沿用 `composer.test.mjs` 的 vm 加载方式）：`navigatorTurn` 的空数组、贴底、阈值边界、全部在阈值下方；`turnPreview` 的文字提问、仅附件、运行中、失败带说明与不带说明、取消、中断、拒绝、长回复截断与空白压缩。
- 浏览器夹具（静态托管 `workbench/index.html` 并注入 `window.flower` 替身）：AC1～AC5 的显示条件、窄窗、60 轮滚动、悬停与键盘、点击跳转、切换会话、深浅色。

## 风险与回滚

- 改动集中在 `agent.js` 的 `thread()`、`index.html` 一处结构与 `style.css` 新增规则；回滚即去掉第五个参数与对应结构，阅读位置与回到底部逻辑不受影响。
- 滚动事件频繁：用 `requestAnimationFrame` 合并，每帧只读各轮 `getBoundingClientRect().top`，60 轮以内开销可忽略。
