# 第二档执行计划

需求 [prd.md](prd.md)，方案 [design.md](design.md)。三批顺序执行，每批结束跑本批验证并单独提交；后一批开始前复核前一批改动过的行号。

## 开始前

- 复核 [research/tier2-code-facts.md](research/tier2-code-facts.md) 中将要改动的行号。
- 读 `.trellis/spec/agent-runtime/backend/event-persistence.md`、`.trellis/spec/flower-desktop/frontend/index.md`、`workbench-contracts.md`、`apps/desktop/workbench/ui/README.md`。
- 确认 Windows 打包脚本 `npm run package:windows -w @flower-ai/flower-desktop` 可用；不可用时在交付中说明，仅完成 Linux 侧与浏览器夹具验证。

## 第一批 输入区（R2 排队与插话、R1 选中引用与侧边追问、R5 @ 提及与拖入、R8 Toast 组件）

Toast 组件先做，后续各项的提示直接使用。

1. **Toast 组件**（R8.1）：`ui/toast.js`、样式、`index.html` 容器；`renderer.js` 的复制成功、`action()` 错误、读取历史失败改用 Toast。
   - 验证：新增 `testing/toast.test.mjs`（上限 3 条、去重重计时、悬停暂停、错误常驻更久、操作按钮回调）。
2. **运行时插话**（R2.5）：`types.ts` 增加 `steers`、`steered` 事件、`RuntimeExecution.steer?`、`SubjectRuntime.steer`；`index.ts` 实现送达记录。`npm run build -w @flower-ai/agent-runtime`。
   - 验证：`npm test -w @flower-ai/agent-runtime`（新增插话送达、未送达不记录、无 `steer` 执行体拒绝、非当前 runId 拒绝）；`dual-host.test.ts` 补 `steered`；`npm test -w @flower-ai/flower-code-reviewer`。
3. **Main 队列**（R2.1–R2.4）：会话记录 `queue`/`queuePaused`，`submit` 分流、终态派发、取消暂停、启动暂停、行内编辑、删除、排序、插话标记与回队首；preload 与处理器成对新增。
   - 验证：`testing/workbench.test.mjs` 或新增 `testing/queue.test.mjs` 覆盖分流、派发顺序、暂停与恢复、插话送达与回队首、重启后暂停、附件归还。
4. **队列条与插话显示**（R2）：输入框上方队列条（行、拖动、上移下移、编辑、删除、插话、继续）；时间线去掉「已排队」消息；回复按 `textOffset` 插入插话气泡。
   - 验证：`testing/composer.test.mjs` 补队列交互；浏览器夹具检查窄窗 660、深浅色、键盘操作。
5. **选区工具条与引用**（R1.1、R1.2）：选区检测、浮动工具条、引用插入、回复区右键菜单 IPC。
   - 验证：`testing/context-menu.test.mjs` 补回复菜单项；`composer.test.mjs` 补引用格式与 16000 字上限。
6. **侧边追问**（R1.3）：Main 隐藏会话（`parent`、分叉写文件、替换与关闭、随父删除）、worker `readOnly` 授权、右栏「侧边追问」页与精简输入框、选区与队列入口。
   - 验证：新增 `testing/side-chat.test.mjs`（分叉内容只含已完成消息、只读工具集、关闭删除文件、父会话删除连带、无成功请求时拒绝）；真实 worker 回环一轮侧边追问。
7. **@ 提及与拖入**（R5）：`workspace-files` IPC 与缓存、补全浮层、面板文件行拖动、输入框接收。
   - 验证：`workspace-panel.test.mjs` 补清单排序、上限与越界拒绝；`composer.test.mjs` 补 @ 触发、输入法组合不触发、补全时方向键不召回。
8. **第一批检查与提交**：`cd apps/desktop && npm test`、`npm test -w @flower-ai/agent-runtime`、`npm test -w @flower-ai/flower-code-reviewer`、根 `npm run build` 与类型检查、`npx biome check apps/desktop packages/agent-runtime`。

## 第二批 检索与上下文（R3 手动压缩、R4 正文搜索、R6 中断恢复）

9. **运行时手动压缩**（R3）：`context-window.ts` 导出 `compactHistory`；`SubjectRuntime.compact`、压缩期间阻止调度与取消。
   - 验证：`context-window.test.ts` 补手动压缩（全量摘要、无新增消息时不调用模型、取消与失败保留旧检查点、运行或排队时拒绝、无 `model` 授权拒绝）。
10. **压缩接入与分隔**（R3）：worker `compact` 帧、Runtime Host 可选超时、Main 压缩期间视为忙碌、`history()` 返回 `compactedBefore`、详情卡按钮与时间线分隔。
    - 验证：`context-continuity.test.mjs` 补自动与手动压缩后的 `compactedBefore`；浏览器夹具检查分隔与按钮停用状态。
11. **正文索引与搜索**（R4）：Main 索引（mtime 复用、删除移除、排除侧边会话）、`search-sessions` IPC、侧栏片段、`thread().reveal`。
    - 验证：新增 `testing/session-search.test.mjs`（2 字起搜、大小写、片段截取、上限、索引复用与失效）；`navigator.test.mjs` 或新测试覆盖 `reveal` 在历史渲染后执行。
12. **中断识别与继续**（R6）：启动扫描、`state().interrupted`、`resume-interrupted`、侧栏横幅、会话内「继续任务」。
    - 验证：测试覆盖磁盘上未修正的运行中状态也被识别、继续后从列表移除、忽略后本次运行不再显示。
13. **第二批检查与提交**：同第 8 步。

## 第三批 零散体验（R7 交付卡片、R8 撤销删除、R9 全局指令）

14. **交付卡片元信息**（R7）：`artifact-info` IPC 与缓存、卡片填充。
    - 验证：`workspace-panel.test.mjs` 补 xlsx 工作表与行数、md 字数、归属校验拒绝。
15. **撤销删除会话**（R8.2）：Main `pendingDeletes`、8 秒定时、撤销、退出前立即删除；侧栏删除去掉确认框、移除工作区保留确认。
    - 验证：测试覆盖撤销恢复原位置与内容、过期物理删除、退出时立即删除、运行中会话先取消。
16. **全局指令**（R9）：`workbench.json.instructions`、设置区、`configure` 下发、worker 读取 `FLOWER.md`、系统提示拼接、详情卡提示。
    - 验证：测试覆盖拼接顺序与标题、4000 与 8000 字上限、`FLOWER.md` 缺失或读取失败、侧边追问同样附加；回环请求体中的系统提示含两段指令。
17. **收尾**：更新 `apps/desktop/workbench/ui/README.md` 组件表、`.trellis/spec` 相关规范（插话事件、队列与侧边会话契约）；修正 `ui/agent.js:487` 与 `renderer.js:820` 不准确的注释。
18. **第三批检查与提交**：同第 8 步；Windows 打包后按 [Windows Verification](../../spec/flower-desktop/frontend/windows-verification.md) 新增 `testing/verify-ux-tier2-windows.mjs`，回归工作台主流程。

## 回滚点

- 每批一个提交，可单独回退。第一批的运行时改动（插话）与 Desktop 队列在同一提交内，回退时一起回退。
- `workbench.json` 新字段都可缺省，回退后旧版本忽略这些字段。
