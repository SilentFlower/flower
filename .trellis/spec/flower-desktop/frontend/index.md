# Frontend Development Guidelines

> `@flower-ai/flower-desktop` Windows 桌面工作台（Electron 45，原生 DOM）开发规范。

---

## Overview

| 层 | 位置 | 职责 |
|---|---|---|
| Main | `workbench/main.mjs` | 窗口、原生菜单与通知、preload IPC 处理器；逐项复核发送窗口、当前会话、请求归属与工作区路径 |
| Host | `workbench/runtime-host.mjs` | 管理 worker 子进程，转发事件、模型流与写入审批 |
| Worker | `workbench/worker.mjs` | 装配共享运行时、工作区工具与附件读取；推理预览等瞬时信息在此旁路 |
| Renderer | `workbench/renderer.js`、`workbench/ui/*.js` | 界面与交互；组件目录见 [workbench/ui/README.md](../../../../apps/desktop/workbench/ui/README.md) |

渲染层的权限请求一律被拒绝，CSP 只允许 `self` 与 `blob:` 图片：剪贴板、通知、右键菜单、文件定位都经 Main IPC 完成，图片用 blob URL 显示。

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Windows Verification](./windows-verification.md) | Playwright `_electron` 实机验收脚本：私有桌面运行、主进程替身、收尾与超时、前台焦点的限制 |
| [Workbench Contracts](./workbench-contracts.md) | 回复路径核对 IPC、推理档位「关闭思考」的请求字段映射、本机排队消息与插话、侧边追问会话、@ 补全文件清单、正文搜索与中断恢复 |

> 共享运行时的事件持久化契约见 [agent-runtime backend spec](../../agent-runtime/backend/index.md)。

---

## Pre-Development Checklist

- 新增 Main 的 electron 具名导入（如 `Notification`）时，同步补到 `testing/workspace-panel.test.mjs` 的假 electron 模块导出列表，否则该测试在导入阶段失败。
- 新的滚动容器调用 `flowerUI.softScroll(node)` 使用自动隐藏细滚动条，不要再写 `scrollbar-width: thin`：Chromium 中标准属性 `scrollbar-width` 一旦设置，`::-webkit-scrollbar` 样式整体失效，Windows 上会回到带箭头的原生滚动条。
- 窄到放不下 12 像素滑块的滚动容器（如 28 像素宽的会话导航刻度列表 `.navigator-ticks`）不调用 `softScroll`，用 `scrollbar-width: none` 完全隐藏滚动条，靠滚轮与 `scrollIntoView({ block: "nearest" })` 让当前项可见；Windows 经典滚动条占布局宽度，挂 `softScroll` 会挤占命中区。
- Markdown 渲染出的滚动容器（代码块、`.markdown-table-scroll`）不要调用 `softScroll`：由 `ui/markdown.js` 在 HTML 中直接输出 `soft-scroll` 类，`style.css` 的 `:where(pre, .markdown-table-scroll).soft-scroll:hover` 显示滑块。脚本切换的 `data-scrolling` 会让流式更新时 `updateBlocks` 的 `isEqualNode` 不相等，反复替换节点并丢失横向滚动位置。表格单元格不要设 `white-space: nowrap`，用 `overflow-wrap: anywhere` 加 `min-width`（`border-box` 下 4.5em 约三个汉字）。
- 悬停显示的浮层（如上下文详情卡、会话导航预览卡）不要设 `pointer-events: none`，与触发元素之间有空隙时用浮层的透明伪元素（`::after`/`::before`）桥接，否则指针移向浮层途中就失去 `:hover`。只有覆盖大片区域的透明定位容器（如 `.thread-navigator`）可设 `pointer-events: none`，其中的触发元素与浮层显式恢复 `auto`；脚本收起浮层时用容器的 `pointerleave` 与 `matches(":hover")`，点击浮层前用 `mousedown` 的 `preventDefault()` 保住触发元素的焦点。
- `.conversation-body` 是 `position: relative` 且 `overflow: auto`：挂在其上的绝对定位浮层（导航条、预览卡）要把位置收在 `#thread-scroll` 的可视范围内（`offsetTop`/`clientHeight`），超出会让会话区本身出现滚动条。
- `.conversation-body` 同时是尺寸查询容器（`container-type: inline-size`）。会话版式（消息列正文最宽 914、`.timeline`/`.composition` 的 `--gutter` 50，输入区内边距 `--gutter - 10`）按 `@container (max-width: 699px)` 收到 20，不要改用视口媒体查询：侧栏折叠与右栏并排时会话区宽度与窗口宽度不成比例。首页编辑卡由 `.workbench[data-home="true"] .composition` 覆盖 `--gutter`、`max-width` 与 `padding-inline`，改会话版式时保持首页尺寸不变。
- 在会话区（`#timeline` 等）新增 `contextmenu` 监听时先判断 `event.defaultPrevented`：路径链接与交付卡片已在子元素上 `preventDefault` 并弹出自己的菜单，祖先再弹会出现两个菜单。回复选区菜单还要求右键目标与选区相交（`range.intersectsNode`）。
- 替换共用选择器的样式块时连同逗号前的选择器一起检查，例如 `.sidebar-heading, .session-list h2 { … }`，只替换后半段会把前一个选择器接到新规则上。
- 新增 preload 接口要在 `preload.cjs` 与 `main.mjs` 的 `handle` 两侧同时出现，处理器先校验会话为当前选中会话、路径经 `workspace.mjs` 的 `locate` 校验。
- 改动后运行 `cd apps/desktop && npm test`、`npx biome check apps/desktop`；涉及 Windows 行为时按 [Windows Verification](./windows-verification.md) 打包并实机验收。
- 浏览器夹具或源码直接启动时，`marked` 从仓根异步加载，首屏贴底后回复由纯文本重排变高，滚动停在离底部数千像素处且「回到底部」不出现；核对贴底、当前轮次等依赖滚动位置的行为前先显式滚到底部。正式包从应用本地 `node_modules` 同步加载，不受影响，不要据此改动阅读位置逻辑。
