# 第二档技术方案

需求见 [prd.md](prd.md)，代码现状见 [research/tier2-code-facts.md](research/tier2-code-facts.md)（§n）。

## 1. 分层与改动面

| 层 | 新增或改动 |
|---|---|
| `packages/agent-runtime` | `steer`、`compact` 两个公开方法；`RequestRecord.steers`；`steered` 事件；`RuntimeExecution.steer?`；`context-window.ts` 导出手动摘要函数 |
| Worker | `register` 帧带 `readOnly`；`steer`、`compact` 帧；系统提示追加全局指令与 `FLOWER.md`；`history()` 返回压缩边界与插话 |
| Runtime Host | `call(type, fields, timeout)` 可选超时，压缩用 10 分钟 |
| Main | 会话队列与暂停状态、侧边追问会话、正文索引（搜索与中断识别共用）、延迟删除与撤销、全局指令持久化、文件清单与交付物元信息 IPC |
| Renderer | 选区工具条、队列条、@ 补全、右栏侧边追问页、搜索片段与跳转、中断横幅、Toast、设置「全局指令」、上下文详情卡的压缩按钮与指令提示 |

code-reviewer 走 `createExecution` 授权：`steer` 在无 `execution.steer` 时拒绝，`compact` 在无 `model` 授权时拒绝，均与 `getContextUsage` 一样不影响其现有路径。

## 2. 排队与插话（R2）

### 2.1 队列移到 Main

- 队列不再依赖运行时的 `queued` 记录（§1）。Main 在会话记录上保存 `queue: [{ id, input, attachments, createdAt }]` 与 `queuePaused`，随 `workbench.json` 原子写入。
- `submit` 处理器：会话有运行中、排队中或待批准的请求，或队列非空、已暂停时，把文本与当前草稿附件（复用现有「提交前清空草稿、失败恢复」）追加到队列，返回队列快照；否则照旧直接提交给运行时。重试、编辑重发共用这一入口。
- 派发：Main 收到某会话请求的 `terminal` 事件、且该会话没有其他活动请求、未暂停时，取队首提交。提交失败（如模型未配置）时队首保留并暂停，Toast 提示原因。
- 暂停：用户取消运行中的请求时置 `queuePaused = true`；启动加载时有队列的会话一律暂停（上次运行已中断）。「继续」或再次发送时清除暂停；再次发送的新消息排到队尾，随后派发队首。
- 编辑在队列行内进行：文字可改、附件可移除（不可新增），保持原位置。进入编辑时经 `hold-queue-item` 请 Main 暂缓派发该条（队首正在编辑时不派发），保存、放弃、切换会话或页面重新加载时解除并补派发，避免把修改前的原文发出。删除时归还附件：工作区引用直接丢弃；导入副本若不再被引用则按现有规则清理（§3、§8）。
- 排序：拖动行或「更多」菜单的上移、下移；IPC `reorder-queue(session, ids)` 校验集合一致后整体替换顺序。
- 运行时内部的排队逻辑保留（code-reviewer 依赖）；Desktop 同一会话同一时刻最多一条活动请求。

### 2.2 插话

- 运行时：`SubjectRuntime.steer(sessionId, runId, steerId, input, attachments?)`。在串行区内核对 `active.runId`，执行体须提供 `steer`。原生执行体读取附件后调用 pi `agent.steer({ role: "user", content, timestamp })`（§1：在当前 turn 结束后注入，最后一个 turn 结束时也会继续一轮）。
- 送达：`recordProgress` 订阅 pi 的用户消息 `message_start`，按顺序与待送达的 `steerId` 对应，在记录上追加 `steers: [{ steerId, input, attachments?, at, textOffset }]`（`textOffset` 为送达时 `record.text` 的长度），提交新事件 `{ type: "steered", steerId }`。
- 未送达（运行失败、取消或重启）不写入记录。Main 在送达前把队列项标为「插话中」不删除；收到 `steered` 删除该项，收到 `terminal` 时仍未送达的项回到队首并暂停。
- 成功运行后 pi 的消息序列已包含插话的用户消息，后续上下文自然包含它；`userMessageIndex` 仍指本轮首条用户消息。
- 显示：回复正文按 `textOffset` 切段，在切点插入「插话」气泡（原文与附件名）。早期记录无 `steers`。
- 事件种类新增 `steered`：同步更新 `dual-host.test.ts` 与 code-reviewer 对未知事件的处理核对，更新 [Event Persistence](../../spec/agent-runtime/backend/event-persistence.md)。

## 3. 选中引用与侧边追问（R1）

### 3.1 选区

- 渲染层监听 `selectionchange`（防抖），选区完全位于同一条回复的 `.reply` 正文内时，在选区末端上方显示浮动工具条「引用」「侧边追问」；滚动、失焦、Esc 时隐藏。
- 引用：把选中文本逐行加 `> ` 前缀，前后补空行，插入 `#prompt` 光标处并聚焦，触发输入事件以保存草稿与刷新发送按钮。超出 16000 字时提示，不截断。
- 右键：在回复选区上 `contextmenu` 时渲染层改走 IPC `show-reply-menu(text)`，Main 弹出「复制」「引用」「侧边追问」；其他位置维持现有原生菜单。实现时核实 `preventDefault` 能抑制 `webContents` 的 `context-menu` 事件，若不能则在 Main 端按「最近一次 reply-menu 请求」去重。

### 3.2 侧边追问会话

- 侧边追问是一个隐藏会话：`workbench.json` 会话项带 `parent` 字段，不进入侧栏、搜索、中断横幅与附件草稿流程。
- 打开：Main 读取父会话快照文件，要求至少有一条成功请求；以父会话的 `workspaceId`、`messages`、`contextCheckpoint` 与 `lastSequence: 0`、空 `requests` 写出侧边会话文件，记录 `forkedThrough`（父会话消息数）。父会话运行中也可打开：文件中的消息只到上一条成功请求为止（运行时成功时才替换 `messages`，§1）。
- 已有侧边追问时打开新的先确认替换；替换、关闭、删除父会话时停止其运行（取消活动请求）并删除文件。
- 只读：Main `register` 侧边会话时带 `readOnly: true`，worker 授权时去掉 `write_report` 并拒绝 `analyze_excel` 的 `createOutputs`，系统提示追加「这是侧边追问，只回答问题，不生成文件」。
- 输入：只收文字，不带附件，不排队（运行中发送按钮停用，可取消）。
- 显示：右栏顶部切换「文件」「侧边追问」。侧边追问页顶部为「基于主会话已完成的 N 轮对话」与新建、关闭按钮，下方为追问消息列表与精简输入框。消息复用 `thread` 的消息组件（Markdown、步骤摘要、复制），不显示导航条与交付卡片。
- 选区「侧边追问」：打开（或切换到）侧边追问页，把选中文字以引用块放入侧边输入框。队列项「侧边追问」：从队列移出，作为侧边追问的第一条消息发送（附件丢弃并提示）。

## 4. 手动压缩与分隔（R3）

- `context-window.ts` 导出 `compactHistory(model, stream, history, checkpoint, systemPrompt, signal)`：对 `modelMessages(history)` 的非系统部分，从现有 `through` 到末尾整体摘要（复用 `summarize`，与已有摘要滚动合并），返回 `{ through: body.length, summary }`。没有新增消息时返回原检查点。
- `SubjectRuntime.compact(sessionId)`：串行区内要求无活动运行与排队请求、授权含 `model`，设置 `active = { runId: "compact:<uuid>", controller }` 阻止调度，串行区外执行摘要，结束后在串行区内写回 `contextCheckpoint` 并 `commit(snapshot, [])`（无事件），清除 `active` 并 `schedule()`。取消用 `cancelRunning("compact:…")` 同一路径。失败抛出 `RuntimeError("agent-error", summaryError)`，检查点不变。
- Worker 帧 `compact`，Runtime Host 调用超时 10 分钟；Main 在压缩期间把会话视为忙碌（队列不派发、发送进入队列）。
- 分隔位置：`through` 与 `userMessageIndex` 同在 `snapshot.messages` 的下标空间（成功后 `messages` 不含系统消息）。`history()` 返回 `compactedBefore`：第一条 `userMessageIndex >= through` 的成功请求 ID；没有则为 `"end"`。渲染层在该请求之前（或末尾）插入分隔「以上对话已压缩为摘要」。自动与手动压缩共用，只显示最新一次。
- 详情卡「压缩上下文」可用条件：会话空闲、有成功请求且其消息不全在检查点内。完成后刷新圆环与历史。

## 5. 会话正文搜索与中断识别（R4、R6）

- Main 维护正文索引：`Map<sessionId, { mtimeMs, size, turns: [{ requestId, input, text, status }] }>`，`input` 取 `desktopMessages` 原文，`text` 为回复正文；不含工具结果。按需读取，`stat` 未变则复用；会话删除时移除。父会话与侧边会话都入索引，搜索时排除侧边会话。
- IPC `search-sessions(query)`：查询去空白后至少 2 个字符，大小写不敏感；返回最多 50 个会话，每个最多 3 条片段 `{ requestId, field: "input" | "text", before, match, after }`（命中前后各约 30 字）。渲染层防抖 200 ms，并与现有名称匹配合并：名称匹配的会话照旧显示，正文命中的会话行下追加片段；切换会话或清空搜索时丢弃迟到结果（请求序号比对）。
- 跳转：`thread()` 新增 `reveal(requestId, query)`，在历史渲染后执行（覆盖待恢复的阅读位置，§5），滚动到该轮并用 `CSS.highlights`（不支持时退回整条消息短暂高亮）标出关键词 2 秒；减弱动效时直接跳转。
- 中断识别：启动后 Main 用同一索引扫描非侧边会话，最后一条请求为 `interrupted`、`queued`、`running` 或 `cancelling` 的视为中断，`state()` 附带 `interrupted: [{ id, title }]`。「全部继续」IPC `resume-interrupted(ids)`：对每个会话以最后一条请求的原输入与附件提交（复用重试校验，此入口不要求当前选中会话），提交后从列表移除；「忽略」本次运行内不再显示。会话内中断请求的「继续任务」即现有重试。

## 6. @ 提及与拖入（R5）

- IPC `workspace-files(session, query)`：复用 `trackedFiles`/`walkFiles` 清单，Main 按工作区缓存 30 秒；文件名前缀、文件名包含、路径包含依次排序，返回前 50 条且只含可加入对话的类型（`canAttachWorkspaceFile`）。
- 补全：`bindComposer` 识别光标前 `@` 加非空白查询（`@` 位于行首或空白后），非组合态时打开 `role=listbox` 浮层（复用 `select.js` 的键盘模式），↑/↓ 选择、Enter/Tab 确认、Esc 关闭；补全打开时 ↑/↓/Enter 不触发历史召回与提交。确认后调用现有 `referenceFile`，删除 `@查询`。
- 拖入：面板文件行 `draggable=true`，`dragstart` 写入 `application/x-flower-path`；输入框 drop 识别该类型调用 `referenceFile`。系统文件拖入保持原逻辑。

## 7. 交付卡片元信息（R7）

- IPC `artifact-info(session, path)`：限当前会话工作区内符合分析产物格式（`Flower-分析-<uuid>/` 下的三种固定文件）的路径，只读元信息、不启动外部程序，因此不像 `open-artifact` 那样核对请求归属，避免每张卡片都读取整段历史；`.xlsx` 用 exceljs 读取（16 MB 上限）返回工作表数与有值行数合计（不含表头），`.md` 返回去空白后的字数。按路径与 `mtimeMs` 缓存。渲染层在卡片渲染后异步填充，失败静默。

## 8. Toast 与撤销删除（R8）

- `ui/toast.js` 提供 `flowerUI.toast(text, { tone, action, duration })`：容器 `role=region` + `aria-live=polite`，错误用 `assertive`；最多 3 条，超出移除最早的非错误条目；同文案同色调去重并重新计时；悬停或焦点在内时暂停；默认 4 秒、错误 8 秒、带操作 8 秒；减弱动效时无位移动画。
- 调用点：复制成功、`action()` 通用错误、读取历史失败、队列派发失败、压缩结果改为 Toast；表单与审批面板内的提示不变（§8）。
- 撤销删除会话：Main `delete-session` 改为从列表移除并登记 `pendingDeletes`（含原序位置与侧边会话），8 秒后执行现有物理删除；`undo-delete-session(id)` 在期限内恢复。退出前（`before-quit`）立即执行全部待删。运行中的会话删除前仍先取消其运行。

## 9. 全局指令（R9）

- 个人指令保存在 `workbench.json` 的 `instructions`（最多 4000 字），设置对话框新增「全局指令」区（文本框、字数、保存）。经 `configure` 帧下发 worker。
- `FLOWER.md`：worker 授权时经 `locate` 读取会话工作区根下的 `FLOWER.md`（按 `mtimeMs` 缓存，最多 8000 字，超出截断并记 `truncated`）。读取失败视为不存在。
- 拼接：`系统提示 + 个人指令 + FLOWER.md`，各段带标题，并说明它们是用户口径偏好、不得覆盖安全与工具规则。侧边追问同样附加。上下文估算自然计入。
- `context-usage` 结果附带 `instructions: { personal: boolean, workspace?: { truncated: boolean } }`，详情卡显示「已应用全局指令」「已读取 FLOWER.md（超过 8000 字，只读取前 8000 字）」。

## 10. 兼容与回滚

- 旧会话：无 `steers`、无队列字段、无 `parent`，行为与现在一致；运行时内残留的 `queued` 记录照旧恢复为中断。
- `workbench.json` 新字段都可缺省；回滚到旧版本会忽略这些字段（队列内容丢失、隐藏的侧边会话出现在列表中），可接受。
- 共享运行时改动是纯增量；回滚时 Desktop 与运行时一起回退。

## 11. 试用反馈修订（R10–R15）

- 压缩方式：`ContextCheckpoint` 增加可选 `trigger: "auto" | "manual"`，`createContextWindow` 自动压缩写 `auto`，`compactHistory` 写 `manual`；没有新对话时返回原检查点，方式不变。早期检查点无此字段。
- 分隔定位：`compactionMark` 移到 `request-history.mjs` 以便单测。成功请求既无 `userMessageIndex` 也无 `flowerRequestId` 时跳过（位置字段与检查点同版引入，缺位置的只会是会话开头的旧轮次），不再整体放弃。历史行增加 `compactedBy`，只在带分隔的那一行有值。
- 删除会话：撤回 R8.2 的撤销机制（`pendingDeletes`、`finishDelete`、`stopSessions`、`undo-delete-session` 与 preload `undoDeleteSession`），单个会话回到与移除工作区相同的确认后删除路径，运行或排队中拒绝；`retiredSessions` 恢复为只服务侧边追问的 `retiredSideChats`。
- 侧边追问标签：`.panel-tabs .button` 的 `display: flex` 会盖过 `hidden`，补 `[hidden] { display: none }`。`sideAvailable` 改按是否有当前主会话；页内发送时若无侧边追问先 `openSideChat` 再 `submitSideChat`，新建失败时原文放回输入框，Main 侧契约不变。
- 标题栏开关：`#workspace-panel-toggle` 移入 `.chrome-content`，`margin-inline-start: auto` 靠右、停靠左侧时 `order: -1`，并设 `app-region: no-drag`；去掉 `--chat-tools-height` 及首页留白的扣减。
- 底部渐隐：`thread()` 的 `syncBottom` 在下方还有内容时给滚动容器加 `data-more`，CSS 用 `mask-image` 在底部 44 像素渐隐；回到底部按钮有新内容时显示「新消息」文字，改为胶囊。
