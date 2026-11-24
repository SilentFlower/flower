# 会话导航条执行计划

## 步骤

1. **纯逻辑与单测**：`W/ui/agent.js` 增加 `navigatorTurn`、`turnPreview` 并挂到 `agentUI`；新增 `testing/navigator.test.mjs`。
   - 验证：`node --test testing/navigator.test.mjs`。
2. **结构与集成**：`W/index.html` 增加 `#thread-navigator`；`thread()` 接收第五个参数，实现刻度重建、`syncNavigator`、预览卡、跳转、键盘；`W/renderer.js` 传入导航条。
   - 验证：`cd apps/desktop && npm test`（含 Markdown 与既有 thread 相关测试）。
3. **样式**：`W/style.css` 增加导航条、刻度、卡片、桥接、减弱动效与强制颜色规则。
   - 验证：`npx biome check apps/desktop`。
4. **浏览器夹具**：按 AC1～AC5 核对（2/3 轮阈值、窄窗 660、60 轮、悬停与键盘、点击跳转、切换会话、深浅色）。
5. **文档与交付**：更新 `W/ui/README.md` 组件表；打包 Windows 候选供用户试用；结果写入本任务 `verification.md`。

## 回滚点

- 步骤 2 之后任一阶段可整体撤下：`thread()` 第五个参数可选，去掉 `renderer.js` 的传参即恢复原行为。

## 开工前检查

- PRD 无待决问题；交互方案已由用户选定。
- 内联执行，`trellis-before-dev` 读取 `.trellis/spec/flower-desktop/frontend/` 规范（新增滚动容器与悬停浮层的注意事项）。
