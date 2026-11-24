# 第一档执行计划

开工前：复核 [research/tier1-code-facts.md](research/tier1-code-facts.md) 引用的行号（2026-11-24 11:10 哈希见该文件开头），工作树应只有本任务目录的改动。

## 步骤

1. **运行时契约**（R1.5）：`packages/agent-runtime/src/types.ts` 增加 `ToolStep`、`RequestRecord.startedAt/endedAt/steps`、事件头 `at`、`tool_started.target`、`SessionGrant.describeTool`；`index.ts` 的 `recordProgress`、`started`、终态提交写入上述字段。补运行时测试，`npm run build -w @flower-ai/agent-runtime`。
   - 验证：`npm test -w @flower-ai/agent-runtime`；`apps/code-reviewer` 测试通过。
2. **Desktop 步骤展示**（R1.1–R1.3、R1.5）：worker `describeTool` 与附件名映射、`history()` 返回步骤与时间；`workspace.mjs` 统一 `analyze_excel` 名称；`ui/agent.js` 动作映射、等待态、运行中展开与终态摘要；renderer 合并持久化步骤。
   - 验证：Desktop `npm test`；真实 pi 回环任务重启后历史含步骤。
3. **推理旁路**（R1.4）：worker 按会话绑定 `streamFn`、累积并节流发送 `reasoning` 帧；runtime-host、Main 转发；renderer 状态行显示与清除。回环模型增加 `reasoning_content`。
   - 验证：推理只出现在运行中；会话文件写入次数不因推理增加。
4. **多任务提醒**（R2）：Main `attention` 与 `indicator`、`started` 时 `announce()`、通知与 `flashFrame`、`focus-session`、关闭确认、`setAppUserModelId`；侧栏状态点；假 electron 模块补 `Notification`。
   - 验证：Main 处理器测试覆盖 indicator 派生与已读规则；Desktop `npm test`。
5. **消息操作**（R3）：抽出 `submitRequest`；新增 `retry-request`、`restore-request-draft`、`copy-text` 与 preload；消息头与用户消息按钮。
   - 验证：处理器测试覆盖状态限制、附件归属、非当前会话拒绝；`request-history.test.mjs` 回归。
6. **阅读位置**（R4）：`thread` 记忆与恢复、回到底部按钮。
   - 验证：浏览器或 Electron 中长会话切换回原位置。
7. **路径与右键菜单**（R5、R6）：`markdown.js` 路径/图片渲染与委托、renderer `resolvePath` 与图片缓存、`show-path-menu`、`context-menu`、面板文件行与交付卡右键。
   - 验证：`markdown.test.mjs` 新用例；处理器测试覆盖路径越界拒绝。
8. **长粘贴与历史召回**（R7、R8）：`importAttachmentText`、`paste-text`、paste 阈值；`bindComposer` 召回。
   - 验证：阈值与召回状态纯函数测试；附件进入模型请求的回环断言。
9. **窗口状态**（R9）：`window-state.mjs`、创建前读取、防抖保存、外扩扣除。
   - 验证：`window-state.test.mjs`；面板外扩测试回归。
10. **全量检查**：根目录 `npm run build`、类型检查、`npx biome check apps/desktop packages/agent-runtime`、`npm test`。更新 `apps/desktop/workbench/ui/README.md` 的组件表（新增状态与交互）。
11. **Windows 实机**：打包候选，按 AC1–AC13 复验并记录到本任务 `verification.md`，toast 是否显示如实记录。

## 回滚点

- 步骤 1 独立可回滚；回滚后 Desktop 去掉对新字段的读取即可退回本窗口内存步骤。
- 步骤 3、4、9 各自独立，出现平台问题可单独撤下。

## 开工前检查

- PRD 待决问题已清空；`implement.jsonl`、`check.jsonl` 已登记研究与规范文件。
- 确认 Windows 实机验收环境（打包脚本 `npm run package:windows -w @flower-ai/flower-desktop`）可用；不可用时在交付中说明，仅完成 Linux 侧验证。
