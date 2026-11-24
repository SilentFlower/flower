# Research: Flower Desktop 第一档交互打磨 · 代码现状事实

- **Query**: 运行过程可读化 / 多任务提醒 / 消息操作 / 回复中的文件路径 / 右键菜单 / 长粘贴 / 历史输入召回 / 窗口状态持久化，以及相关测试与约束
- **Scope**: internal（apps/desktop、packages/agent-runtime、node_modules/@earendil-works/pi-*）
- **Date**: 2026-11-24
- **读取时间点**: 2026-11-24 11:04 – 11:11（本机时间）。另一个 Codex 窗口在并发修改 `apps/desktop/workbench` 与 `packages/agent-runtime`，以下行号以该时间点为准。读取开始与结束时文件哈希一致（md5 前 8 位）：
  `main.mjs 71777df3`、`renderer.js 01251218`、`worker.mjs 9f9ac6e7`、`runtime-host.mjs b7ab9a8f`、`preload.cjs fb64d259`、`ui/agent.js f410f4a3`、`ui/markdown.js d274757c`、`ui/workspace-panel.js 1b283800`、`packages/agent-runtime/src/index.ts 2d028014`。
  `apps/desktop/` 与 `packages/agent-runtime/` 在 git 中均为未跟踪目录（`git status` 显示 `??`），无法用 git 历史比对。
- 下文路径均相对仓库根 `/root/project/flower`。`W/` = `apps/desktop/workbench/`，`R/` = `packages/agent-runtime/src/`。

---

## 0. 端到端数据链路总览

```
pi Agent(pi-agent-core) ──AgentEvent──▶ agent-runtime SessionRunner.recordProgress ──commit(落盘)──▶ RuntimeEvent
  └ worker.mjs bindSubject 回调 send({kind:"event"}) ──utilityProcess──▶ runtime-host.mjs child.on("message") onEvent
  └ main.mjs prepare().onEvent（维护 activeRequests、裁剪 tool_result.text）──webContents.send("flower:update")──▶
  └ preload.cjs subscribe ──▶ renderer.js receive() ──▶ timeline.requests ──▶ ui/agent.js thread/message/toolSteps
模型调用反向：worker streamModel ─send({kind:"model"})─▶ runtime-host modelRequest ─▶ main gateway() ─▶ gateway.mjs openModelStream(pi-ai streamSimple)
```

- 运行时事件类型（共享核心对外唯一协议）只有 7 种：`queued / started / cancelling / text_delta / tool_started / tool_result / terminal`（`R/types.ts:184-197`）。
- 共享核心每发一个事件都先 `store.save` 整份会话快照再通知观察者（`R/index.ts:276-297`），包括每个 `text_delta`（`R/index.ts:452-466`）。桌面 store 的 `writeJson` 使用临时文件 + `flush: true` + rename（`W/storage.mjs:31-40`，`W/request-history.mjs:42`）。**即每个流式分片都触发一次整份 JSON 落盘。**

---

## 1. 运行过程可读化

### 1.1 工具步骤 label / state 的产生链路

| 层 | 位置 | 行为 |
|---|---|---|
| pi-agent-core | `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:483-500` | `tool_execution_start {toolCallId, toolName, args}`；`tool_execution_end {toolCallId, toolName, result, isError, durationMs?}` |
| agent-runtime | `R/index.ts:434-467` `recordProgress` | 只转成 `tool_started {toolName, toolCallId}`（**丢弃 args**，`R/index.ts:438-439`）与 `tool_result {toolName, toolCallId, text, isError}`（**丢弃 durationMs**，`R/index.ts:440-447`）；`tool_result` 同时追加进 `RequestRecord.toolResults` 落盘（`R/index.ts:457-464`） |
| worker | `W/worker.mjs:190-196` | 原样 `send({kind:"event", event})`；同时用 `started/terminal` 维护 `running` Map（存本轮附件 refs，供 `attachment:` 引用解析，`W/worker.mjs:98,161`） |
| runtime-host | `W/runtime-host.mjs:123-125` | `case "event": onEvent(frame.event)` 原样转发 |
| main | `W/main.mjs:348-362` | 维护 `activeRequests`；`tool_result` 事件被改写为 `{...event, text: []}`（**工具结果正文在此被丢弃**，`W/main.mjs:359`）后 `send({kind:"event"})` |
| renderer | `W/renderer.js:824-831` | `tool_started` → `record.tools.push({id, label: toolLabels[toolName] ?? "调用工具", state:"running"})`；`tool_result` → `done`/`error`；`terminal` 时仍为 running 的改 `stopped`（`W/renderer.js:836-838`） |
| UI | `W/ui/agent.js:207-231` `toolSteps` | `<details class="step-list">`，summary 为 `工具步骤 · N 项[ · 进行中]`，每行 = label + `stepStates`（`进行中/完成/出错/已结束`，`W/ui/agent.js:13`）；用 `JSON.stringify(steps)` 去重渲染 |

### 1.2 当前所有工具名与中文 label 来源

工具定义在 `W/workspace.mjs:658-738` `workspaceTools`，共 5 个。renderer 用自带映射 `toolLabels`（`W/renderer.js:4-10`），**不使用** AgentTool 自身的 `label` 字段（事件里没有 label）。两处存在不一致：

| toolName | 参数（schema） | renderer `toolLabels` | AgentTool `label`（workspace.mjs） |
|---|---|---|---|
| `list_workspace` | `{directory}`（`:664`） | 查看目录 | 查看目录（`:662`） |
| `read_text_file` | `{path}`（`:681`） | 读取文件 | 读取文件（`:679`） |
| `inspect_excel` | `{path}`（`:693`） | 检查工作簿 | 检查工作簿（`:691`） |
| `analyze_excel` | `{path, sheet?, groupColumn, valueColumn, createOutputs}`（`:711-720`） | **汇总工作簿** | **分析 Excel**（`:709`） |
| `write_report` | `{markdown, input?}`（`:730-732`） | 写入核对报告 | 写入核对报告（`:727`） |
| 其他 | — | 兜底「调用工具」（`W/renderer.js:825`） | — |

### 1.3 工具调用参数是否可得、在哪层丢弃

- **pi 层有**：`tool_execution_start.args`（pi-agent-core `types.d.ts:483-487`）。
- **agent-runtime 丢弃**：`recordProgress` 只取 `toolName/toolCallId`（`R/index.ts:438-439`），`RuntimeEvent.tool_started` 类型也没有 args 字段（`R/types.ts:194`）。`RequestRecord.toolResults` 也不存 args（`R/types.ts:84-89`）。
- **持久化里间接存在（仅成功轮次）**：成功请求的完整 pi messages 落入 `snapshot.messages`（`R/index.ts:413-425`），其中 assistant 消息的 `toolCall` 内容块带 `arguments`（`R/context-window.ts:166` 摘要时就读取 `part.arguments`）。失败/取消/中断轮次的 messages **不落盘**（只追加 `flowerToolReceipt` 文本回执，`R/index.ts:426, 516-530`），其 args 不可恢复。
- **路径参数可能是 `attachment:<64hex>`**：会话附件以该编号作为工具 path（`W/worker.mjs:107, 163-175`），展示时需要映射回附件名（worker 内 `running.get(session).refs` 有 `{id,name}`，`W/worker.mjs:98`）。
- `write_report.markdown` 参数最大 64 KiB（`W/workspace.mjs:730`），属于大参数。
- 工具结果正文（例如 `inspect_excel` 返回的工作表名 JSON）在 worker 侧完整存在，在 main 被清空（`W/main.mjs:359`）。

### 1.4 thinking / reasoning 流式事件

- **pi-ai 会产生**：`AssistantMessageEvent` 有 `thinking_start/thinking_delta/thinking_end`（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:610-623`）。Desktop 实际使用 `@earendil-works/pi-ai/api/openai-completions` 的 `streamSimple`（`W/gateway.mjs:1, 88`），该实现从 `reasoning_content / reasoning / reasoning_text` 字段产出 `thinking_delta`（`pi-ai/dist/api/openai-completions.js:376-400`）。是否真有 reasoning 流取决于网关返回。
- **Host 透传到 worker**：`runtime-host.mjs` 的 `modelRequest` 把所有模型事件原样 `send({type:"model-event"})`，只对 `error` 事件替换 errorMessage（`W/runtime-host.mjs:88-102`）；worker 推入 `AssistantMessageEventStream`（`W/worker.mjs:221-227`）。
- **context-window 只做缓冲**：`start/text_start/thinking_start` 在首个实质事件前缓冲（`R/context-window.ts:345-348`），不丢弃。
- **在 agent-runtime 丢弃**：`recordProgress` 只识别 `message_update` 中的 `text_delta`（`R/index.ts:436-437`），其余（含 `thinking_*`、`message_start`、`toolcall_*`）直接 `return`（`R/index.ts:448-450`）。**Desktop 当前对 thinking 是“丢弃”**。
- thinking 内容会作为 assistant 消息的 `thinking` 块随成功轮次 messages 落盘（`R/index.ts:416`；类型 `pi-ai/dist/types.d.ts:264-272, 382-384`），但 `worker.history()` 不返回（`W/worker.mjs:213-214`）。
- 摘要请求显式关闭推理（`W/worker.mjs:53` `reasoningOff: purpose === "summary"`，`W/main.mjs:376`）。
- 测试桩 `apps/desktop/testing/mock-model.mjs` 只回写 `reasoning_effort`（`:56, 64`），**不产出 reasoning_content 流**。

### 1.5 开始 / 结束时间与耗时

- `RuntimeEvent` 只有 `sequence`，无时间戳（`R/types.ts:184-189`）；`RequestRecord` 无 createdAt/startedAt/endedAt（`R/types.ts:101-113`）。
- pi 的 `AssistantMessage.timestamp`（请求开始毫秒，`pi-ai/dist/types.d.ts:405-406`）与用户消息 `timestamp`（`R/index.ts:503`）只存在于成功轮次的 `snapshot.messages`。
- `tool_execution_end.durationMs` 被 runtime 丢弃（`R/index.ts:440-447`）。
- renderer 记录对象（`W/renderer.js:801-807`）无时间字段。结论：**目前无法从协议算耗时**；若只在 renderer 收到 `started/terminal` 时本地打点，仅对本窗口在线期间有效，重启/切换后丢失。

### 1.6 首个内容到达前 renderer 显示什么

- 提交后 `queued` 事件先于 submit 返回到达（核心先 commit 再 resolve，`R/index.ts:147-153`），`receive` 新建 `input:""` 的记录（`W/renderer.js:801-807`），此时用户气泡因 `prompt.hidden = !record.input` 隐藏（`W/ui/agent.js:303`），submit 返回后再合并 input（`W/renderer.js:1494-1503`）。
- 回复区：头部 = 头像 + 「Flower」+ 状态文字（`已排队/运行中`，`W/ui/agent.js:3-12, 306-308`）+「取消任务」按钮（queued/running 显示，`:309`）；正文 `root.hidden = !source`（`W/ui/markdown.js:87`）、工具步骤 `hidden = steps.length === 0`（`W/ui/agent.js:219`）。**没有占位/动画**；CSS 只给 `.status[data-state=running|queued|cancelling]` 着色（`W/ui/components.css:303-307`），无 keyframes。
- 会话历史读取期间显示 `#history-status`「正在读取会话…」（`W/index.html:127`，`W/renderer.js:266`）。

### 1.7 工具步骤是否落盘、重启后是否丢失

- `worker.history()` 返回字段只有 `input, file, attachments, requestId, runId, status, text, failure, artifacts`（`W/worker.mjs:200-216`），**无工具步骤**。
- `reloadHistory` 合并时：本窗口内存中已有的 `tools` 保留（`W/renderer.js:561-566`），否则为 `[]`。
- `pruneTimelines` 只保留“当前会话 + 最近一个会话 + 仍有活动请求的会话”的 timeline（`W/renderer.js:243-247`），终态时也会调用（`W/renderer.js:841`）。
- 结论：**工具步骤只存在于当前窗口内存**；重启、刷新、或切换到第三个会话后再回来都会丢失（README 原文 `W/ui/README.md:17` 一致）。
- 可用于重建的落盘数据：`RequestRecord.toolResults`（toolName/toolCallId/text/isError，按完成顺序，`R/index.ts:457-464`），以及成功轮次 messages 里的 toolCall 参数；`tool_started` 但未完成的步骤无落盘。

---

## 2. 多任务提醒

### 2.1 主进程的会话状态追踪

- `activeRequests: Map<requestId, {session, runId, running}>`（`W/main.mjs:116`），由事件维护：`queued`（首次）/`started` 写入，`cancelling` 置 `running=false`，`terminal` 删除（`W/main.mjs:350-357`）。
- `approvals: Map<id, {prompt, finish}>`：写入前询问模式下的待批准项（`W/main.mjs:121, 318-339`）。
- `state()` 给 renderer 的每个会话只有 `awaitingWrite`（有待批准）与 `busy`（有排队或运行请求）两个状态位（`W/main.mjs:156-167`，`sessionBusy` 见 `:270-272`）；全局 `modelBusy`（`:143`）。
- **完成/失败/取消在 main 不留状态**，只随事件透传；`announce()` 只在“新入队”与 `terminal` 时推送 state（`W/main.mjs:361`），`started` 不推送。
- 进程重启后未结束的请求在该会话首次被访问时才由核心标为 `interrupted`（懒恢复，`R/index.ts:249-274`），侧栏在此之前不知道。
- 工作进程退出时 `activeRequests.clear()` + `runtimeRevision++` + `gatewayError`（`W/main.mjs:363-371`），renderer 据 `runtimeRevision` 变化清空活动集并标记历史失效（`W/renderer.js:627-635`）。

### 2.2 renderer 侧栏会话行的状态标记

- 会话行只渲染：标题、`待批准` 徽标（`awaitingWrite`）、置顶图标、`aria-current`（`W/ui/agent.js:122-137`）。工作区分组折叠时显示组级 `待批准`（`W/ui/agent.js:70-77, 148-154`）。
- `busy` **不在行上显示**，仅用于筛选「进行中」（`W/renderer.js:40-48`）。
- renderer 收到所有会话的事件（main 不按会话过滤），但只为当前会话重绘（`W/renderer.js:846-853`）；后台会话 terminal 若无 timeline 直接忽略（`W/renderer.js:797`），有 timeline 的处理后多半被 `pruneTimelines` 回收。
- **没有“已读/未读”概念**（全仓 grep `unread|未读|已读|seen` 无结果）。

### 2.3 窗口焦点 / 通知 / 任务栏 / 关闭

- `Notification`、`flashFrame`、`setOverlayIcon`、`setProgressBar`、`Tray`、`setAppUserModelId`、窗口 `focus/blur` 监听：**均未使用**（grep 无结果）。
- 已注册的窗口事件：`render-process-gone` / `closed` → `dismissApprovals()`；`unmaximize` / `leave-full-screen` → `restorePendingPanel`；`will-navigate` 阻止；`dom-ready` 初始化（`W/main.mjs:1010-1026`）。
- `second-instance` → 还原并聚焦（`W/main.mjs:1030-1033`）。
- **关闭行为**：无 `close` 拦截。关窗 → `closed`（拒绝待批准写入）→ `window-all-closed` → `app.quit()` → `before-quit` → `host.close()`（`W/main.mjs:1034-1037`）→ `child.kill()` 并中止所有模型流与写入授权（`W/runtime-host.mjs:35-49`）。运行中/排队的请求在下次访问该会话时被标为 `interrupted`（`R/index.ts:265-272`），前端显示「上次运行已中断」（`W/ui/agent.js:11`）。**无确认提示。**
- 所有 Chromium 权限请求一律拒绝：`setPermissionRequestHandler(... callback(false))`（`W/main.mjs:1027`）→ 渲染层 HTML5 `Notification`、`navigator.clipboard` 写入等需要权限的 Web API 不可依赖，需走主进程 IPC。
- 打包为 Electron 45.3.2 解压版（`apps/desktop/scripts/package-windows.mjs:18-20`），无安装器、无开始菜单快捷方式；用户数据目录 `%APPDATA%\Flower Desktop Open`（`W/main.mjs:86-90`）。

---

## 3. 消息操作

### 3.1 提交接口（renderer → preload → main → worker → runtime）

- renderer：`ui.submit(selected, text)` 只传文本（`W/renderer.js:1493`），发送前清空输入框，失败且输入框仍空时回填（`W/renderer.js:1487-1511`）。
- preload：`submit: (session, input) => invoke("submit", session, input)`（`W/preload.cjs:41`）。
- main `handle("submit", (id, text))`（`W/main.mjs:936-960`）：
  - 校验 `text.trim()` 非空且 `≤16000`；需已配置模型；
  - `draftOwner(id)` 要求 **id 必须是当前选中会话**（`W/main.mjs:765-769`）；
  - **附件不由 renderer 传入**，取自会话草稿 `draftAttachments(owner)`（`W/main.mjs:944`）；含图片且模型不支持图片时报错（`:946-950`）；提交前清空草稿，失败回写（`:951-958`）；
  - **模型**是 main 全局当前模型（`model`），**权限**是会话 `owner.writeMode`，在写入发生时由 `authorizeWrite` 读取（`W/main.mjs:316-317`）；运行/排队期间禁止改模型（`requireModelChange`，`:404-407`）与改权限（`:598`）。
- worker `case "submit"` → `requestHistory.submit(session, {input, file}, prompt => runtime.submit(session, prompt, frame.attachments))`（`W/worker.mjs:256-261`）；送模型的 prompt 是 `input.trim()`（`W/request-history.mjs:52`），原话存入快照的 `desktopMessages[requestId]`（`W/request-history.mjs:36-42`）。
- 共享核心 `submit` 追加 `RequestRecord`（status `queued`）并调度（`R/index.ts:126-155`）。
- worker 的命令异常一律回成泛化文案「工作区任务未能执行，请检查模型设置或文件状态。」（`W/worker.mjs:273-274`）。

### 3.2 失败请求在历史与模型上下文里的状态

- `RequestRecord.status = "failed"`，`failure = {code, message}`；已流出的部分正文保留在 `record.text`（`R/index.ts:406-427, 456`）。取消为 `cancelled`，重启为 `interrupted`。
- **不进入 pi 会话历史**：只有 `succeeded` 才把本轮 messages 写回 `snapshot.messages` 并更新检查点（`R/index.ts:413-425`）。失败/取消/中断只在有工具结果时追加一条 `flowerToolReceipt`（`R/index.ts:426, 516-530`），投影给模型时转成 user 文本消息（`R/context-window.ts:40-42`）。**失败轮的用户输入与部分回复不进入模型上下文，检查点不变。**
- renderer 展示：状态「未完成」+ 红色 `failure` 文案（`W/ui/agent.js:9, 312-313`）。

### 3.3 “重试失败请求”的可行性事实

- 原 `input` 可得：`timeline.requests` 记录的 `input`（来自 `desktopMessages` 原话，`W/request-history.mjs:15-19`）。
- 原附件 refs 可得：历史行带 `attachments`（`W/worker.mjs:213-214`），main 有 `historyReference(snapshot, requestId, key)` 校验 ref 属于该请求（`W/attachment-history.mjs:9-16`）。
- `asset:` 附件快照在被任一历史请求引用时不会被回收（`discardUnused` 读全部 `requests[].attachments`，`W/main.mjs:784-791`），所以失败请求的外部附件仍可复用；`file:` 附件在执行时重新读取工作区文件（`W/worker.mjs:108-109`），内容可能已变。
- **现有 submit IPC 不接受附件参数**，只取草稿（`W/main.mjs:944`）。重试带附件要么先把 refs 写回草稿（`writeDraft`/`mergeAttachments`，`W/main.mjs:770-782`、`W/attachment-drafts.mjs:17-22`），要么新增 IPC。
- 原失败记录无法删除：核心与桌面 store 都是追加式（见 3.4），只能在 UI 层折叠/标注。

### 3.4 “编辑最后一条并重跑（替换上一轮）”是否支持截断

- `SubjectRuntime` 只有 `submit / cancelQueued / cancelRunning / getSession / getContextUsage`（`R/types.ts:213-248`），**没有截断/回退 API**。
- 桌面 store 的 `save` 强制“请求数只能 +1 且新请求为 queued 且有 pending 原话”，否则抛「无法关联桌面请求与原始输入」（`W/request-history.mjs:33-41`）——**减少请求数会直接失败**。
- worker 内 `SessionRunner` 缓存 `this.snapshot`（`R/index.ts:115, 219`），不能绕过它直接改 JSON 文件。
- 可用于定位切点的数据：成功请求的 `userMessageIndex`（`R/types.ts:108-109`，写入于 `R/index.ts:417-423`）；检查点 `contextCheckpoint.through`（`R/types.ts:136-140`）若大于截断后的消息数会被 `validCheckpoint` 丢弃（`R/context-window.ts:85-96`），若小于则摘要可能仍含被删轮次的内容。
- 被替换轮次已写到工作区的产物（`Flower-分析-*`）不会随截断回收。
- `sentImage`/`messageForRequest` 依赖“成功请求 ↔ user 消息”对齐（`W/attachment-history.mjs:18-88`），截断需同时保持该对齐。
- `packages/agent-runtime` 还被 `apps/code-reviewer/src/review-execution.ts` 使用（`:16-20, 60, 90-97`），新增运行时 API 影响双宿主。

### 3.5 用户消息复制现状

- 回复有复制按钮：`copy-reply` IPC 由 main 读 worker history 再 `clipboard.writeText(record.text)`（`W/main.mjs:927-934`；按钮 `W/ui/agent.js:285-288`，运行中隐藏 `:310`；成功反馈 `W/renderer.js:201-205`）。
- **用户消息无复制按钮**；`.user-message-text` 未禁用选择（`W/ui/components.css:266-273`；仅 `.desktop-chrome` 等设 `user-select:none`，`W/style.css:44-49`），可手动选中。
- 应用菜单被置空（`Menu.setApplicationMenu(null)`，`W/main.mjs:987`），无原生右键菜单。

---

## 4. 回复中的文件路径

### 4.1 markdown.js 对链接、图片、行内代码的处理

- 自定义 marked 渲染器（`W/ui/markdown.js:16-44`，`gfm: true`）：
  - `html` → 转义后字面显示（`:18-21`）；
  - `image` → 原文字面 `<span class="markdown-literal">`（`:22-24`），**不渲染图片**；
  - `link` → 仅 `safeLink` 通过（`http/https`、≤2048、无控制字符/反斜杠、无 userinfo，`:5-14`）才生成 `<a href="#" data-markdown-url>`，否则**输出原始 markdown 文本**（`:25-31`）。相对路径链接（如 `[报告](Flower-分析-…/核对报告.md)`）和 `file://` 都是字面文本；
  - `code`（代码块）→ `<pre tabindex=0><code>` 转义（`:36-38`）；
  - **行内代码 `codespan` 未自定义**，走 marked 默认 `<code>` 转义（测试断言 `<code>notes\.txt</code>`，`apps/desktop/testing/markdown.test.mjs:35`）。
- 增量更新：每次 `parse` 整段后用 `isEqualNode` 逐块替换（`W/ui/markdown.js:63-76, 84-101`），后加的节点级监听会随块替换丢失；链接点击是 root 上的事件委托，且要求 `event.isTrusted`（`:103-108`）。
- 同一 `flowerMarkdown.view` 也用于工作区面板的 Markdown 预览（`W/ui/workspace-panel.js:127-136`）。

### 4.2 openLink 实现与校验

- renderer `openLink: (url) => action(() => ui.openReplyLink(url))()`（`W/renderer.js:200`）→ preload `open-reply-link`（`W/preload.cjs:40`）→ main `shell.openExternal(replyLink(value).href)`（`W/main.mjs:935`）；`replyLink` 复核 http(s)、长度、控制字符/反斜杠、hostname、无 userinfo（`W/main.mjs:60-67`）。
- 窗口导航与新窗口全部阻止（`W/main.mjs:1010, 1015`）。

### 4.3 工作区面板对外接口（交付文件「预览」路径）

- `createWorkspacePanel(host)` 返回：`setSession(next, initialized)`、`browseFiles(id, trigger)`、`previewAttachment(ref, request, trigger)`、`preview(path, trigger)`（`W/ui/workspace-panel.js:734-791`）。
- 交付文件「预览」：`deliverables` 的「预览」按钮 → `actions.preview(path, trigger)`（`W/ui/agent.js:258`）→ `workspacePanel.preview(path, trigger)`（`W/renderer.js:199`）→ 按 `/` 或 `\` 拆成 folders + file 并打开面板（`W/ui/workspace-panel.js:782-790`）→ `load()` 调 `host.previewWorkspaceFile(selected.id, path)`（`:409-410`）→ main `preview-workspace-file`（`W/main.mjs:759-764`）→ `previewWorkspaceFile`（`W/workspace.mjs:399-430`）。
- 「打开 ↗」走 `open-artifact`：要求路径在该请求 history 的 `artifacts` 内且匹配 `Flower-分析-<uuid>/(分析报告.md|汇总.xlsx|核对报告.md)`（`W/main.mjs:975-983`，正则 `W/workspace.mjs:28, 745-748`），再 `shell.openPath`。
- `preview(path)` 对**任意**工作区相对路径都可用（不限产物），是“回复中路径 → 面板预览”的现成入口。

### 4.4 渲染层显示工作区本地图片

- 现成 IPC：
  - `previewWorkspaceFile(session, path)`：图片返回 `{kind:"image", mime, bytes}`（png/jpg/jpeg/jpe/jfif/gif/webp/bmp，签名校验，≤16 MiB，`W/workspace.mjs:58-118, 403-406`）；
  - `attachmentImage(session, request, key)`：仅限草稿/历史附件图片（`W/main.mjs:886-913`，preload `:35`）。
- 渲染方式：`Blob` + `URL.createObjectURL`（面板 `W/ui/workspace-panel.js:93-117`；大图 `W/ui/image-viewer.js:168-195`；缩略图 `:237-276`，懒加载 IntersectionObserver）。
- **CSP 只允许 `img-src 'self' blob:`，不允许 `data:`**（`W/index.html:6`）→ 生成 data URL 显示图片会被拦截，必须用 blob URL。
- `previewWorkspaceFile` 一次返回整文件字节（≤16 MiB），无缩略/尺寸参数。

### 4.5 路径授权边界

- 工作区读取只允许**当前选中会话**：`readSelectedWorkspace` 检查 `id === workbench.selected`，并在切会话时用 AbortSignal 作废旧结果（`W/main.mjs:236-253`）。
- `locate`：只接受相对路径（拒绝绝对路径、Windows 盘符、`:*?"<>|`、控制字符、`.`/`..`、尾随点空格、保留设备名，`W/workspace.mjs:173-197`），realpath 必须等于拼接路径且位于根内、非符号链接（`:199-210`），并复核工作区 dev/ino 身份（`checkRoot`，`:164-171`）。WSL UNC 路径有专门比较（`:119-138`）。
- 附件：草稿 refs 或 `historyReference` 校验属于该请求（`W/main.mjs:891-898`）；`asset:` 快照位于 `sessions/attachment-assets/<session>/<sha256>/<name>`，读取时重算哈希比对（`W/attachment-assets.mjs:114-130`）。
- 外部打开：仅 http(s) 链接（`openExternal`）与登记过的产物（`openPath`）。
- 回复里模型写出的路径若是绝对路径或带 `..`，需要先转换/拒绝才能交给 `preview`。

---

## 5. 右键菜单

- `webContents.on("context-menu")`：**未注册**（grep 无结果）；应用菜单为 null（`W/main.mjs:987`）。输入框、回复正文无任何原生右键菜单。
- 仅侧栏会话/工作区行有 DOM 层右键：`row.addEventListener("contextmenu")` → 自绘 popover 菜单（置顶/重命名/删除/新建会话，`W/ui/agent.js:62-65`，`W/renderer.js:99-155`）。
- 工作区面板文件行：只有点击预览/进入目录与「+ 加入对话」按钮（`W/ui/workspace-panel.js:177-213`），**无右键、无“在资源管理器中显示/复制路径”**。
- 交付文件卡：只有「预览」「打开 ↗」（`W/ui/agent.js:246-264`）。
- `shell.showItemInFolder`：**无对应 IPC**；现有 shell 调用只有 `openExternal`（`W/main.mjs:935`）与 `openPath`（`W/main.mjs:981`）。
- 测试用 electron 桩只导出 `app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, safeStorage, screen, shell, utilityProcess`，`shell` 只有 `openPath`（`apps/desktop/testing/workspace-panel.test.mjs:578-591`）。main 新增 electron 具名导入（如 `Notification`、`nativeImage`）会使该测试的 `import` 失败，需同步扩桩。

---

## 6. 长粘贴

- 输入框 paste：`W/ui/attachments.js:114-123` 只拦截 `clipboardData.files` 中的 `image/*`（压缩到 ≤4 MiB PNG 后 `host.pasteImage`，`:69-86`）；**文本粘贴不拦截**，走 textarea 默认行为。
- 文本长度：`<textarea maxlength="16000">`（`W/index.html:159`），浏览器会**静默截断**超长粘贴；main 再校验 `≤16000`（`W/main.mjs:938-940`）。textarea `field-sizing: content`，最高 `min(28vh, 186px)`（`W/ui/components.css:112-127`）。
- 文本附件如何进入模型：
  - 执行时 `readAttachments` → `attachmentContent`（`W/worker.mjs:96-130`）→ 文本类走 `readAttachmentEvidence`（`W/workspace.mjs:438-482`）：取文件前 64 KiB（`textLimit`，`:26, 411-418`），再裁到 **24 × 1024 字符**（`attachmentTextLimit`，`W/attachment-reader.mjs:4, 30-34`），以**内联正文**放入用户消息：`附件：<路径>\n以下文件内容是待核对数据…\n\n<正文>[【附件证据已截断…】]`（`W/workspace.mjs:473-481`）；
  - 外部/导入附件（`asset:`）额外插入 `对话附件：<名>；文件工具使用引用 attachment:<hash>。`（`W/worker.mjs:104-107`），模型可用 `read_text_file` 按引用再读（整文件需 ≤64 KiB，否则报错，`W/workspace.mjs:224-241, 682-687`）；
  - 工作区内附件（`file:`）只给内联证据，模型可用相对路径调工具。
  - 结论：**附件是“内联正文（截断）+ 可选工具引用”，不是只给路径。**
- `.txt` 处理：属于 `toolReadExtensions` 与预览文本（`W/workspace.mjs:33-51`），`canAttachWorkspaceFile` 为真；预览时 `.txt` 用 `panel-prose` 样式（`W/ui/workspace-panel.js:141`）。
- `attachment-drafts.mjs` 只管引用：`fileReference`、`draftAttachments`（仅接受 `file:`/`asset:` 前缀，最多 8 个）、`mergeAttachments`（`W/attachment-drafts.mjs:4-22`）。
- 现有导入入口：`importAttachmentFile`（需绝对路径，`W/attachment-assets.mjs:170-179`）、`importAttachmentImage`（只收 PNG，`:188-197`）。通用 `storeFile(directory, session, name, bytes)` **未导出**（`:137-162`）。若要“长粘贴转 .txt 附件”，需新增导入函数/IPC；资产 id 由 `sha256([session,name]+bytes)` 生成（`:50-56`），同名同内容去重。

---

## 7. 历史输入召回

- renderer 可直接拿到：`timelines.get(session).requests`（`Map<requestId, record>`，按持久化顺序合并，`W/renderer.js:555-571`），每条有 `input`（原话，来自 `desktopMessages`；旧记录回退到核心 `RequestRecord.input`，`W/request-history.mjs:15-19`）和 `attachments`。
- 只有已加载的 timeline（当前会话、最近会话、活动会话）在内存（`W/renderer.js:243-247`）；跨会话召回需逐会话调 `ui.history(id)`，该 IPC 经 `serializeTaskChange` 与提交串行，并会向 worker 注册会话（`W/main.mjs:460-465, 915-920`）。
- `bindComposer(input, submit)`（`W/ui/agent.js:179-205`）：只处理 Enter（无 Shift/Alt/Ctrl/Meta、非组合态、`keyCode !== 229`、非 repeat 时点击发送）；组合态由 `compositionstart/end/blur` 维护。**无 ArrowUp/ArrowDown 处理**，签名里也拿不到历史数据。
- 草稿机制：`drafts: Map<sessionId, text>`，仅在切换会话时保存/恢复（`W/renderer.js:18, 693-705`），**不持久化**；提交时清空，失败回填（`W/renderer.js:1487, 1506-1511`）。以代码改 `prompt.value` 不会触发 `input` 事件，需要手动 `syncSend()`（参见首页建议的写法 `W/renderer.js:528-541`）。
- 全局 `keydown`：Ctrl/⌘+K 打开搜索（`W/renderer.js:515-520`），搜索框自身处理 Enter/Escape（`:503-514`）。

---

## 8. 窗口状态持久化

### 8.1 BrowserWindow 参数

`W/main.mjs:989-1009`：`width 1282, height 801, useContentSize: true, minWidth 640, minHeight 560`，`backgroundColor` 随系统主题；win32 下 `titleBarStyle:"hidden"` + `titleBarOverlay`（高 45，`:76-78`）；`sandbox/contextIsolation: true`。**未传 x/y，未保存/恢复尺寸、位置、最大化状态**；无 `resize/move/maximize` 监听（仅 `unmaximize/leave-full-screen`）。

### 8.2 window-fit 面板外扩与“未外扩基准”

- 面板外扩记录 `panelExpansion = {before, after, contained, open}`（`W/main.mjs:119-120, 501`）：`before` 是外扩前外框，`after` 是外扩后外框；`open=false` 表示最大化/全屏期间已收起、待还原（`:505-523`）。
- `restoredBounds` 只撤销外扩差值并保留用户在展开期间的移动/调宽（`W/window-fit.mjs:37-45`）；`expandedBounds` 先占右侧空余再向左平移（`:21-28`）；`roundingCorrection` 补偿分数缩放的 ±2 DIP 取整（`:52-58`，`W/main.mjs:479-487`）。
- 若保存窗口尺寸，应保存“去掉外扩”的外框：外扩期间 = `restoredBounds(panelExpansion, getBounds(), minWidth, areaOf)` 的结果（或至少 `width - (after.width - before.width)`、`x + before.x - after.x`）。面板每次启动都是收起的（`W/index.html:184` `hidden`），`dom-ready` 时还会先撤销上一页留下的外扩（`W/main.mjs:1019-1022`）。
- renderer 侧在外扩期间用 `--layout-vw` 按 `innerWidth - granted` 冻结布局（`W/ui/workspace-panel.js:447-452, 466-500`）。

### 8.3 多显示器 / 缩放下恢复的坑（代码事实 + 外部常识）

- 代码已有：按 `screen.getDisplayMatching(bounds).workArea` 求所在屏（`W/main.mjs:481, 497, 517`）、`containsBounds` 判断是否完整可见（`W/window-fit.mjs:6-13`）、分数缩放取整补偿（`W/main.mjs:483-486`）。
- `useContentSize: true`：构造参数的 width/height 是内容区；`getBounds()` 返回外框。直接把 `getBounds()` 存下再作为构造 width/height 传回会有差异（win32 隐藏标题栏时二者接近，其他平台不同）。可用 `setBounds` 或 `getContentBounds` 保持口径一致。
- 外部常识（未在本仓验证）：Electron 在 Windows 上跨不同 DPI 显示器 `setBounds`/构造时可能出现尺寸按错误缩放换算；保存的显示器被拔掉后坐标可能落在屏外；最大化时应取 `getNormalBounds()` 而非 `getBounds()`。

### 8.4 现有本机偏好存储

- 主进程 JSON（`userData/local-workbench/`）：`workbench.json`（`{workspaces, deletions, sessions[{id,title,workspace,writeMode,pinned,attachments}], selected, draftWriteMode}`，`W/main.mjs:96-102, 176-227`）、`model.json`（模型库，Key 经 `safeStorage` 加密，`W/main.mjs:98, 210`）、`sessions/<id>.json`（核心快照 + `desktopMessages`）。全部用 `writeJson` 原子写（`W/storage.mjs:31-40`）。
- **时序约束**：`workbench.json` 在 `dom-ready` 后才由 `loadLocal()` 读取（`W/main.mjs:1024`），晚于 `new BrowserWindow`（`:989`）；窗口外框若存这里会读得太晚。`record()` 每次写都会 `announce()`（`:221-227`）。
- 渲染层 `localStorage`（主进程创建窗口前不可读）：
  - `flower.desktop.sidebar.collapsed`、`flower.desktop.sidebar.view`（`W/renderer.js:29-30, 363-368, 387-400`）；
  - `flower.desktop.appearance.v1`（主题，JSON，`W/ui/theme-preload.js:3, 116, 122`）；
  - `flower.workspace-panel.width`、`flower.workspace-panel.side`（`W/ui/workspace-panel.js:557-573, 598-625`）。

---

## 9. 相关现有测试与运行命令

### 9.1 Node 单测（`apps/desktop/testing/*.test.mjs`，假 electron 桩，无需 Electron）

| 文件 | 覆盖点（与本档相关） |
|---|---|
| `workbench.test.mjs` | 模型设置/发现/鉴权；写入权限（只读/拒绝/中止零产物）；真实 pi + 回环 SSE 分析工作簿，断言有 `text_delta`、`toolResults`（`:148-281`） |
| `workspace-panel.test.mjs` | 草稿引用恢复（`:32`）；目录/预览/图片/PDF/附件证据与截断（`:50-317`）；**真实 preload + main 处理器**：当前会话限制、窗口来源校验、重启后读取、`setPanelExpansion` 外扩/还原/最大化/取整补偿（`:518-706`）；Git（`:708`） |
| `window-fit.test.mjs` | `expandedBounds/restoredBounds/roundingCorrection` 纯函数：反复开关不漂移、左补、第二显示器、保留用户移动、分数缩放（`:8-74`） |
| `markdown.test.mjs` | 中文强调/列表/引用/行内代码/代码块/表格；HTML、图片、`file://` 与带账号 URL 字面显示，http(s) 只生成 `data-markdown-url`（`:28-55`） |
| `request-history.test.mjs` | 并发提交原子保存原话与附件；历史截图按成功轮次恢复；失败回执不挤占截图位置（`:11-150`） |
| `attachment-assets.test.mjs` | 外部文件快照、并发去重、PNG 跨进程读取、越权拒绝（`:30-147`） |
| `context-continuity.test.mjs` | Desktop 子进程经真实 pi、附件、摘要后重启续接（`:47`） |
| `theme.test.mjs` | 外观偏好 localStorage 持久化与恢复（`:30-61`） |
| `model-library.test.mjs` | 模型库/推理档位持久化 |
| `preview/demo.test.mjs` | 预览样例的只读工具、流式、取消恢复（断言 `tool_started`、`terminal`，`:8-50`） |

命令（2026-11-24 11:10 本地实跑：42 项全过，约 5.5 s）：

```bash
cd apps/desktop && npm test
# 等价：node --test testing/*.test.mjs testing/preview/demo.test.mjs   （apps/desktop/package.json scripts.test）
# 根目录：npm test -w @flower-ai/flower-desktop
```

### 9.2 Windows 真机验收脚本（Playwright `_electron`，只在 win32 运行，需打包 EXE）

用法形如 `node testing/verify-xxx-windows.mjs <EXE> <新证据目录> <Playwright 目录> [...]`（各文件 `:7-13` 的 assert 文案）。相关的：

| 文件 | 相关覆盖 |
|---|---|
| `verify-windows.mjs` | 主流程：真 pi 工具、取消、执行中展开「工具步骤」summary（`:788-795`）、窗口 `setSize` 窄窗 |
| `verify-sidebar-windows.mjs` | 侧栏平铺/分组、搜索、待批准运行与排队期间切换、重启恢复（`:128-259`） |
| `verify-write-permission-windows.mjs` | 待批准徽标 `.session-approval`、进程退出后 `interrupted`（`:262-341`） |
| `verify-markdown-windows.mjs` | 复制回复原文、`openExternal` 被替换验证链接（`:131-136, 250, 282`） |
| `verify-panel-layout-windows.mjs` | 真窗口外框、最大化、多显示器 workArea/scaleFactor（`:55-63, 97-111, 217-227`） |
| `verify-attachments-windows.mjs` | 剪贴板截图、合成 paste 事件（`:138-141, 337`） |
| `verify-preview-windows.mjs` | 「上次运行已中断」显示（`:157`） |

打包：`npm run package:windows -w @flower-ai/flower-desktop`（`apps/desktop/package.json`，Electron 45.3.2）。

### 9.3 共享运行时测试

- `packages/agent-runtime`：`npm test -w @flower-ai/agent-runtime`（vitest）。`test/dual-host.test.ts:300-308` **精确断言事件类型序列** `["queued","started","tool_started","tool_result","text_delta","text_delta","terminal"]`，新增事件种类会影响该断言。
- Desktop 通过 `node_modules/@flower-ai/agent-runtime → packages/agent-runtime` 的 **`dist/index.js`** 引用（`packages/agent-runtime/package.json` `main/exports`）。改 `src/*.ts` 后需 `npm run build -w @flower-ai/agent-runtime`（tsc）Desktop 才生效；读取时 dist 与 src 同为 10:53 生成，`dist/index.js:365-388` 与 src 一致。

---

## 10. 对第一档实现最关键的约束与风险

1. **事件协议在共享核心收窄**：工具参数、`durationMs`、thinking 都在 `R/index.ts:434-450` 被丢弃，`RuntimeEvent` 无时间戳。要展示这些必须改 `packages/agent-runtime`（含 types、dist 重建），并顾及 code-reviewer 宿主与 `dual-host.test.ts:300` 的精确事件序列断言。
2. **每个运行事件都整份落盘**（`commit` → `store.save` → `writeJson` flush，`R/index.ts:276-297`、`W/storage.mjs:35`）。若把 thinking 分片也走 `recordProgress/commit`，落盘次数会成倍增加；只做展示的瞬时事件需要不经 commit 的通道（当前没有）。
3. **工具步骤只存在于窗口内存**，`history()` 不返回、`pruneTimelines` 会回收。要“重启可见”只能从 `toolResults`（无 args、无未完成步骤）或成功轮次 messages 重建，失败轮的 args 不可恢复。
4. **main 主动清空 `tool_result.text`**（`W/main.mjs:359`）是有意的数据最小化；把结果或参数暴露给渲染层时，要对路径参数（含 `attachment:` 引用）和大参数（`write_report.markdown` ≤64 KiB）做裁剪/映射。
5. **提交接口只收文本，附件取自当前选中会话的草稿**（`W/main.mjs:936-960`、`765-769`）；重试/编辑重跑需要新 IPC 或回写草稿，且只能作用于当前选中会话。
6. **共享核心与桌面 store 都是追加式**：无截断 API，桌面 `store.save` 遇到请求数减少会直接抛错（`W/request-history.mjs:33-41`）。“替换上一轮”涉及 messages、`userMessageIndex`、检查点、`desktopMessages`、截图回读对齐与已写产物，第一档里改动面很大。
7. **渲染层权限全拒**（`W/main.mjs:1027`）且 CSP `img-src 'self' blob:`（`W/index.html:6`）：通知、剪贴板、右键菜单、显示图片都要走主进程 IPC + blob URL，不能用 Web Notification/`navigator.clipboard`/data URL。新增 electron 具名导入须同步 `workspace-panel.test.mjs:590` 的假模块导出。
8. **关窗即退出并杀掉 worker**（`W/main.mjs:1034-1037`、`W/runtime-host.mjs:35-49`），运行中任务会变成 `interrupted` 且无确认；做提醒/托盘/关闭确认会改变这一生命周期。Windows toast 依赖 AppUserModelId，当前未设置，且为免安装解压版（外部常识，需真机验证）。
9. **路径预览只认当前会话工作区的相对路径**（`readSelectedWorkspace` + `locate`，`W/main.mjs:243-253`、`W/workspace.mjs:173-210`）；回复中的绝对路径、`..`、反斜杠混用、后台会话里的路径都需要先归一或拒绝。markdown 每次流式更新会替换变化的块（`W/ui/markdown.js:63-76`），路径交互要用 root 级事件委托 + data 属性。
10. **窗口外框持久化的时序与口径**：`workbench.json` 在窗口创建后才加载（`W/main.mjs:1024`），localStorage 主进程不可读；保存时必须扣除面板外扩（`panelExpansion`）、最大化取 normal bounds，并注意 `useContentSize: true` 与 `getBounds()` 口径不同、多显示器/分数缩放的恢复越界。

## Caveats / Not Found

- 未找到：`webContents 'context-menu'`、`shell.showItemInFolder`、`Notification`、`flashFrame`、`setOverlayIcon`、`Tray`、`setAppUserModelId`、窗口 `close`/`focus`/`blur` 处理、已读/未读、窗口尺寸持久化、历史输入召回、长文本转附件。
- 未验证（需 Windows 真机）：`Menu.setApplicationMenu(null)` 下 textarea 的 Ctrl+C/V 快捷键行为（Chromium 在 Windows 通常原生处理）；Electron 45 在免安装解压版上的 toast 显示条件；跨 DPI 显示器恢复外框的误差。
- 本次没有外部网页检索（当前环境无 web 搜索工具），第 8.3 与第 10.8 条的外部常识需另行核实。
- 由于 Codex 并发修改，实现前请先重新核对本文件引用的行号。
