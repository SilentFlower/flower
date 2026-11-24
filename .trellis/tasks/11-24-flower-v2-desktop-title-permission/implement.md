# Implement — Desktop 权限改名与会话自动标题

1. 权限改名：`index.html` 菜单与按钮文案；`verify-write-permission-windows.mjs` 结果文案。核对 `syncWriteControls` 读取后的按钮文字与 `aria-label`。
2. `session-title.mjs` 纯函数与 `testing/session-title.test.mjs`：临时标题（空白、40 码点、省略号、emoji 不截半）、两种上下文（截断长度、第一轮 + 最近 8 轮、分隔符）、`cleanTitle`（引号、书名号、句号、换行、空结果、超长）、`generateTitle`（done 文本、error 事件、非 stop、超时）。
3. Main：`createSession` 写 `titlePending`；`loadLocal` 保留；`submit` 首条命名与后台生成；rename 清标记；`rename-session-ai` 处理器；preload `renameSessionWithAI`。
4. 渲染层：会话菜单「用 AI 重命名」（图标沿用 `pencil` 或新增），成功 Toast，失败走 `action` 的错误提示。
5. `mock-model.mjs` 支持按系统提示识别标题请求并记录请求体；集成测试（新文件 `testing/session-title-flow.test.mjs`，经 `desktop-harness.mjs`）：首条命名、失败保留、手动改名不被覆盖、旧会话不命名、AI 重命名与空会话报错、请求无推理字段。
6. 文档：`ui/README.md` 组件表；`.trellis/spec/flower-desktop/frontend/workbench-contracts.md` 新场景「会话自动标题」。
7. 验证：`cd apps/desktop && npm test`、`npx biome check apps/desktop`；浏览器夹具看菜单与文案；Windows 组装候选包，扩展 `verify-ux-tier2-windows.mjs` 或新增脚本覆盖 AC1–AC5，跑写入权限与第二档回归。

回滚点：权限改名与标题功能相互独立，可分别回退；`titlePending` 为可选字段，回退无需迁移。
