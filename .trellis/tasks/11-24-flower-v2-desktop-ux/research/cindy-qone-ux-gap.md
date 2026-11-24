# Cindy 与 QoneAgent 的 UI/交互差距对照

调研时间 2026-11-24。只读对照，未执行第三方代码。

- Cindy 0.1.143：`D:\cindy\resources\app.asar`，渲染层抽取到 `/tmp/cindy-asar-JD1IKF/.vite/renderer/main_window/assets/`，简体中文文案包为 `common-yhtwbGXK.js`。
- QoneAgent：`/root/project/QoneAgent` 提交 `c4788b2`，桌面端位于 `apps/desktop/src`、`apps/desktop/electron`，设计分析在 `docs/codex-*.md`。
- Flower 基线：`apps/desktop/workbench`，对照时读取的行号会随并发修改漂移。

★ 表示 Cindy 与 Qone 都实现。

## Flower 基线中的关键缺口（调研时实测）

- 工具步骤只有 `工具步骤 · N 项 · 进行中` 与名称加状态，推理事件不展示。`apps/desktop/workbench/ui/agent.js:221`
- 回复操作只有“复制回复原文”和“取消任务”。`apps/desktop/workbench/ui/agent.js:283-287`
- 切换会话时 `thread.reset()` 把滚动位置归零。`apps/desktop/workbench/ui/agent.js:328`
- Markdown 图片按原文输出。`apps/desktop/workbench/ui/markdown.js:22`
- 主进程 `Menu.setApplicationMenu(null)` 且未注册 `context-menu`，输入框右键无反应。`apps/desktop/workbench/main.mjs:987`
- 窗口每次固定 1282 宽打开。`apps/desktop/workbench/main.mjs:992`
- 侧栏搜索只匹配标题、工作区、路径和“待批准”。`apps/desktop/workbench/renderer.js:263-270`

## 第一档：小改动、高价值

| # | 借鉴点 | 参照证据 |
|---|---|---|
| 1 ★ | 运行过程可读化：首包前“正在思考”；工具语义标签“正在读取 X / 已读取 X”；一轮折叠为“已工作 N 分 · 读取 5 个文件”；推理只露最新一句或“思考 12s” | Qone `src/components/assistant-ui/tool-action-summary.ts:52-110`、`assistant-waiting-phase.ts:7`、`reasoning-preview.ts:5-9`、`assistant-execution.tsx:58-63,187-195`；Cindy `chat.workGroup.*`、`agentActions.part.*`、`ccAgent.agentStatus.*`、`chat.thinking` |
| 2 ★ | 多任务提醒：侧栏运行中/等你处理/完成未读/出错状态与优先级排序；后台时系统通知、任务栏闪烁或角标；有任务时关闭/更新前确认 | Qone `project-section.tsx:32-33,80`、`store.ts:610-611`、`electron/sidecar.ts:157-166`（每次完成都弹、不看焦点，不宜照搬）；Cindy `ccAgent.sidebar.status.*`、`filterSortByTip.priority`、`settings.notifications`、`appBadge.attentionCount`、`titleBar.closeConfirm` |
| 3 ★ | 消息操作：失败重试（Cindy 显示自动重试 2/5）、编辑最后一条重发、用户消息复制 | Qone `message-actions.tsx:11-23,44-57,60-70`、`App.tsx:231-249`；Cindy `chat.errorBanner.*`、`messageActionBar.*` |
| 4 ★ | 按会话记住阅读位置；“N 条新消息”回到底部 | Qone `lib/thread-scroll-state.ts:4-16`、`thread-scroll-to-bottom.tsx:17-34`；Cindy `newMessageIndicator` |
| 5 ★ | 回复中文件路径可点击（右栏预览、在文件夹中显示、复制路径），本地图片内联 | Qone `markdown-file-link.tsx:13-39`、`lib/markdown-file-reference.ts:11`、`markdown-local-media.tsx:11-18`；Cindy `markdownRenderer.*`、`settings…linkOpen` |
| 6 | 原生右键菜单按目标生成（输入框剪切粘贴、选中复制、图片复制保存） | Qone `electron/native-menus.ts:30-51` |
| 7 ★ | 长粘贴折叠：Qone ≥2000 字转附件；Cindy >4000 字或 24 行折成可预览编辑的 chip | Qone `lib/long-paste.ts:3-21`；Cindy `newChat.pastedText.*`、`CCAgentSessionView` 阈值 |
| 8 ★ | 空输入框 ↑/↓ 召回本会话已发输入，回到底部恢复草稿，避开输入法组合态 | Qone `lib/composer-history.ts:1-2`、`composer-history.tsx:170,206,239`；Cindy `CCAgentSessionView` ArrowUp 逻辑 |
| 9 | 窗口位置、尺寸、最大化状态持久化 | Qone `electron/main.ts:106-152` |

## 第二档：中等改动

- ★ 选中回复文字引用到输入框追问；Cindy 另有侧边追问。Qone `selected-text-actions.tsx:36-42`；Cindy `chat.quote.*`、`chat.sideChat.*`
- ★ 队列移到输入框上方，可编辑、删除、拖序、插话，停止后暂停。Qone `composer-queue.tsx:42-96,178`、`lib/qone-message-queue.ts:32,52,135`；Cindy `sendButton.*`、`pendingQueue.*`、`sendDelivery.*`
- ★ 上下文用量环与手动压缩，压缩位置留分隔。Qone `assistant-context.tsx:17-31`；Cindy `contextRingPanel.*`、`chat.compact.*`。注意：另一窗口的 `11-23-flower-v2-desktop/context-continuity.md` 已在做占用估算与检查点，第二档应在其基础上做展示。
- ★ 会话正文搜索、命中片段与跳转。Qone `packages/database/src/repos.ts:32-55`；Cindy `ccAgent.search.*`
- @ 提及工作区文件、从文件面板拖入输入框。Cindy `newChat.atMention.*`、`composerMentionDrag`
- 中断恢复：应用退出导致中断后“继续任务”，启动时批量续跑。Cindy `interruptedBanner`、`interruptedResumeDialog`
- 交付卡片元信息：PDF 页数、Excel 工作表与行数。Cindy `generatedFiles.summary`
- Toast 体系：最多 3 条、去重、悬停暂停、可撤销。Cindy toast chunk
- ★ 全局指令（部门口径）。Qone `settings/personalization-section.tsx:81-107`；Cindy `settings.personalization`

## 第三档：大改动

- 本轮文件变更卡与撤销（非 Git 工作区需写入前快照）。Cindy `turnChanges.*`、`lastTurnChangedFiles`
- 编辑重发、回到此处、从此处分叉。Cindy `messageActionBar.*`、`userMessage.edit*`、`rewind.dialog.*`
- 结构化提问卡。Cindy `askUserQuestion.*`
- 导出 HTML、复制为 Markdown、多选复制为图片。Cindy `sessionMenu.*`、`shareImage.*`、`useCopyAsImage`
- 应用内更新面板。Qone `settings/general-section.tsx:11-64`、`electron/updater.ts:239-264`；Cindy `update.*`

## 不跟进

终端、内置浏览器、子代理与后台任务、Goal 模式、语音输入、全局截图、AgentIsland、机器人、计费、技能市场、远程控制。
