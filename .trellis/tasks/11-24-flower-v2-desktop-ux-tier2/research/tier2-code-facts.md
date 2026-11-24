# 第二档代码现状（2026-11-24）

路径缩写：W = `apps/desktop/workbench`，R = `packages/agent-runtime/src`，P = `node_modules/@earendil-works/pi-agent-core/dist`。行号以 2026-11-24 为准，实现前复核。

## §1 排队与插话

- 提交链路：发送按钮 W/renderer.js:1722-1769 只传文本 → preload `submit(session, input)` W/preload.cjs:44 → W/main.mjs:1089-1109（16000 字上限，附件取自 Main 草稿 `draftAttachments(owner)`，提交前清空草稿、失败恢复）→ worker W/worker.mjs:304-308 → `requestHistory.submit` W/request-history.mjs:46-65 → `SessionRunner.submit` R/index.ts:128-157。
- 运行中发送按钮不禁用（`syncSend` W/renderer.js:1030），再发即排队。队列就是 `snapshot.requests` 中 `status: "queued"` 的记录（R/index.ts:538-540），先进先出，`schedule` 取第一条（R/index.ts:313），操作经 `serialize` 串行（R/index.ts:201-211）。
- 没有改顺序、改文本的接口，只有 `cancelQueued`（R/index.ts:159-170）。排队请求在时间线中作为普通消息显示「已排队」（W/ui/agent.js:4、465），可取消（W/ui/agent.js:482、521）；`queued` 事件带 `position`，渲染层未使用（W/renderer.js:1051）。
- 停止运行后排队请求自动继续：`cancelRunning`（R/index.ts:172-182）结束后 `this.active = undefined; this.schedule()`（R/index.ts:440-441）。重启恢复时排队与运行中都标为 `interrupted`（R/index.ts:267-273）。
- Desktop 请求历史只允许「请求数不变」或「只追加一条 queued」（W/request-history.mjs:74-80）。
- pi `Agent` 支持运行中插话：`steer(message)` 在当前 assistant turn 结束后注入，`followUp(message)` 在本要停止时运行，另有 `clearSteeringQueue`、`peekQueuedMessages`、`steeringMode`（P/agent.d.ts:97-99，P/agent.js:187-215，P/agent-loop.js:191-197）。运行中直接 `prompt` 会抛错（P/agent.js:248）。agent-runtime 未使用：`RuntimeExecution` 只有 prompt、subscribe、abort、waitForIdle、getMessages、dispose（R/types.ts:71-84），`Agent` 封在 `createNativeExecution`（R/index.ts:504-536）。
- 参照 Qone：队列在客户端保存、持久化顺序，未发送前不进运行时；「插话」调用 steer 注入当前运行；编辑要求输入框为空；停止后队列暂停（`pauseAfterStop`），用户再次发送时恢复（QoneAgent `apps/desktop/src/lib/qone-message-queue.ts`、`components/assistant-ui/composer-queue.tsx`）。

## §2 选中引用

- 回复区无选中处理；只有「复制回复原文」「复制提问原文」按钮（W/ui/agent.js:472、483）。原生右键菜单 W/context-menu.mjs:15-31，选中文字时只有「复制」（:26）。
- 输入框 `#prompt`（W/index.html:171）。文本草稿在渲染层 `drafts` Map（W/renderer.js:11、933-944），不持久化；附件草稿在 Main `owner.attachments`，持久化（W/main.mjs:873-885）。

## §3 @ 提及与拖入

- `bindComposer`（W/ui/agent.js:306-345）处理 ↑/↓/Esc 召回、Enter 提交、输入法组合。没有补全弹层；`ui/select.js` 是主题下拉框（role=listbox，方向键导航，可借鉴结构）。
- 全量文件清单：`trackedFiles`（Git，W/workspace-git.mjs:64-67，3 MiB、12 秒）与回退 `walkFiles`（20000 项、深度 12，W/workspace.mjs:234-258），目前只在 `resolveMentionedPaths` 内部用，没有 IPC 把清单交给渲染层。
- 面板文件行不可拖动；`showDrop`/`panel-drop-zone` 是面板停靠（W/ui/workspace-panel.js:694-748）。文件加入对话靠行尾「+」或预览「加入对话」：`host.referenceFile` → `reference-file` → `addPaths(id, [path], true)`（W/ui/workspace-panel.js:161-169、257-262，W/main.mjs:932）。
- 输入框拖放只收系统文件（W/ui/attachments.js:104-127）→ `drop-files` → `addPaths`：每条消息最多 8 个附件；工作区内文件为 `file:<相对路径>` 引用，工作区外复制为 `asset:<sha256>`（W/attachment-drafts.mjs:4-6，W/attachment-assets.mjs:51-57）。工作区附件以「附件：<相对路径>」文本块进入模型（W/workspace.mjs:588-593）。

## §4 手动压缩与压缩位置

- 自动检查点：每次模型调用前投影超过输入预算即压缩（R/context-window.ts:316），目标 92%，溢出重试 0.73（:318、341-342）；切点 `chooseCut`（:132-156），摘要 `summarize` 分批滚动合并（:196-248）。成功后写 `contextCheckpoint { through, summary }`（R/index.ts:435，R/types.ts:165-168），只保留最新一份，不记录对应请求与时间。
- 没有手动入口：`prepare/summarize` 为内部函数；`SubjectRuntime` 公开 `submit, cancelQueued, cancelRunning, getSession, getContextUsage`（R/index.ts:103-109，R/types.ts:243-278）。运行成功会用该次运行的检查点覆盖快照（R/index.ts:417-435），手动压缩必须在会话空闲时执行。
- 事件与 `RequestRecord` 不带压缩信息。分隔线位置可由 `through` 与成功请求的 `userMessageIndex`（R/types.ts:131）推导；切点可能落在一轮内部（当前用户消息被钉住，R/context-window.ts:107）。
- 摘要失败抛 `ContextWindowError`，请求标为失败；取消标为取消；两者都保留旧检查点（R/index.ts:394-395、422-437）。
- 圆环数据：`refreshContextUsage` → `flower:context-usage` → `runtime.getContextUsage` → `estimateRuntimeUsage`（W/renderer.js:843-853，W/main.mjs:1045-1050，R/context-window.ts:258-273）。W/renderer.js:820 注释「90% 接近自动压缩」不准：实际阈值约为窗口的 72%～89%。
- code-reviewer 只用 submit/cancel，走 `createExecution` 授权且删除检查点（R/index.ts:373、436）；新增公开方法需像 `getContextUsage` 一样处理无 `model` 的授权。双宿主测试 `packages/agent-runtime/test/dual-host.test.ts`。
- 文档中没有「手动压缩」的纳入或排除记录（`11-23-flower-v2-desktop/context-continuity.md`、`verification.md:132-136` 只覆盖自动压缩）。

## §5 会话正文搜索

- 侧栏元数据在 `userData/local-workbench/workbench.json`（W/main.mjs:105-114），每会话一个 `sessions/<id>.json` 快照（含 `requests`、`messages`、`contextCheckpoint`、`desktopMessages{requestId→{input,file}}`），整文件原子替换（W/storage.mjs:31-40）。无会话数量上限；本机样本最大 635 KB（工具结果在 requests 与 messages 各存一份）。
- `state()` 返回的会话项不含正文（W/main.mjs:150-187）。侧栏搜索在渲染层：`matchingSessions` 只比对标题、工作区、路径与「待批准」（W/renderer.js:466-477），`renderSessions` W/renderer.js:494-525，Ctrl+K W/renderer.js:727。
- 历史 IPC `flower:history`（W/main.mjs:1039-1044 → W/worker.mjs:232-263）返回 `input, attachments, requestId, status, text, failure, artifacts, steps, startedAt, endedAt`。经 worker 读取会让 `SessionRunner` 常驻该快照且与提交共用串行队列（R/index.ts:80、92-100），跨会话搜索应由 Main 直接读文件（已有先例 W/main.mjs:891、1006）。
- 跳转：导航条 `jump(index)`（W/ui/agent.js:615-621）为内部函数，`thread()` 只返回 `reset/update`（:772-811）；消息节点带 `data-request`（:467）。切换会话后首次 `update` 会恢复上次阅读位置（:780、799-803），跳转须在历史渲染后执行。
- 无 SQLite 或全文索引依赖。

## §6 中断恢复

- 退出时 `before-quit` 直接关闭 worker（W/main.mjs:1242），关窗确认文案「下次打开时显示为已中断」（W/main.mjs:1190-1213）。
- 中断是懒修正：首次访问会话时 `SessionRunner.restore` 把 queued/running/cancelling 改为 `interrupted` 并写工具回执（R/index.ts:251-276），不发事件、无 `endedAt`。启动 `loadLocal` 只读 workbench.json（W/main.mjs:193-236），要知道哪些会话中断须逐个读会话文件。
- 重试 `retry-request`（W/main.mjs:1075-1118）以原输入与原附件新建请求，与原请求无关联字段。未成功请求的工具回执（每项 ≤2048 字，提示避免重复外部写入）会进入后续上下文（R/index.ts:437、566-580，R/context-window.ts:40）；部分回复正文只显示，不进上下文（R/index.ts:424-437）。W/ui/agent.js:487 注释「未进入模型上下文」不准确。

## §7 交付卡片

- 交付物只有固定三种：`Flower-分析-<uuid>/` 下的 `分析报告.md`、`汇总.xlsx`、`核对报告.md`（W/workspace.mjs:32-36）。`analyze` 结果含 `{sheet, rows, skipped, total, groups, artifacts}`（W/workspace.mjs:721-759）。没有 PDF 或 DOCX 产物。
- worker `history()` 只从工具结果 JSON 取 `artifacts` 路径数组（W/worker.mjs:232-262）；`SessionSnapshot.artifacts` 声明未填（R/types.ts:186）。实时 `tool_result` 文本被 Main 清空（W/main.mjs:416），终态后 `reloadHistory` 才拿到交付物（W/renderer.js:1078-1087）。
- 卡片显示 XLSX/MD 标签、文件名、预览、打开、右键菜单（W/ui/agent.js:421-463）。
- 能力：exceljs 4.4.0、pdfjs-dist 6.5.438（apps/desktop/package.json:12-19）；`workbookEvidence` 已能给出工作表名与有值行数（W/attachment-reader.mjs:41-57）；`workbook()` 有 16 MB 上限（W/workspace.mjs:421-430）；Node 端 `pdfEvidence` 可取 `numPages`（W/attachment-reader.mjs:96-143）。

## §8 Toast

- `flowerUI.feedback` 只设 `data-tone` 与文字（W/ui/foundation.js:40-43），调用点全在 renderer.js。
- 瞬时提示（宜改 Toast）：复制成功（W/renderer.js:318、325，显示在输入框下 `#feedback`）；通用 `action()` 的错误（:405、410，覆盖切换会话、置顶、重命名、删除、移除附件、取消、打开产物、重试、编辑、选工作区、拖入粘贴、新建会话、发送）；读取历史失败（:795）。
- 宜保留内联：草稿超长（:749）、写入审批（:985、1006）、模型弹层与设置表单（:1191-1322、1456-1668）。
- 破坏性操作：删除会话、移除工作区有确认框（W/renderer.js:106-130、171-177），Main 立即 `cleanDeleted` 物理删除（W/main.mjs:773-824）；移除草稿附件无确认且立即删除未引用的导入副本（W/main.mjs:985-997）。

## §9 全局指令

- 系统提示是 worker 中的固定中文字符串（W/worker.mjs:215-216），每次排队前 `authorize` 重新组装 grant（W/worker.mjs:165-218，R/index.ts:242-249、315），上下文估算也计入（R/index.ts:195），下一轮即生效。传参可仿照模型设置的 `init`/`configure` 帧（W/runtime-host.mjs:145，W/worker.mjs:288，W/main.mjs:474）。
- 设置入口：侧栏 `#theme-open` 与模型弹层 `#settings` 都打开 `#model-dialog`（W/index.html:117、308、320-399），内有「外观」子对话框（W/ui/theme-settings.js）。持久化：model.json、workbench.json、外观 localStorage、window-state.json，没有通用设置 IPC。
- 「部门口径」只出现在研究对照中，参照 Qone 个人设置页「全局提示」（写入用户级 Qone.md）。v2 规划明确开源桌面本地自配，组织策略归 `v2-company`；Desktop 无企业下发机制。
