# 工作台跨层契约

> 渲染层、preload、Main 与工作区宿主之间，以及模型设置到 pi 请求体之间，容易改错的可执行契约。

---

## Scenario: 回复中的路径先核对再可点

### 1. Scope / Trigger

- 触发：改动 `ui/markdown.js` 的路径渲染、`renderer.js` 的 `checkReplyPaths`/`forgetMissingPaths`，或 `resolve-reply-paths` 链路上的任一层。
- 链路：`markdown.js` 解析 → `paths.check(path)` 读缓存 → `paths.hydrate(root, refresh)` 批量调 `window.flower.resolveReplyPaths` → `main.mjs` 的 `resolve-reply-paths` → `workspace.mjs` 的 `resolveMentionedPaths`。

### 2. Signatures

```js
// preload.cjs
resolveReplyPaths: (session, paths) => invoke("resolve-reply-paths", session, paths)
// main.mjs：只读当前会话工作区，Git 清单作为可选来源
handle("resolve-reply-paths", (id, paths) =>
	readSelectedWorkspace(id, (workspace, signal) =>
		resolveMentionedPaths(workspace, paths, signal, () => trackedFiles(workspace, signal))));
// workspace.mjs
export async function resolveMentionedPaths(workspace, paths, signal, listFiles)
// workspace-git.mjs：git ls-files --cached --others --exclude-standard -z；不在仓库中返回 null
export async function trackedFiles(workspace, signal)
```

### 3. Contracts

- 请求：`paths` 为字符串数组，最多 64 项，每项是 `flowerMarkdown.workspacePath` 产出的 `/` 分隔相对路径。
- 响应：与输入一一对应。`{ path }` 实际文件（可能不同于输入，例如 `brief.md` → `.trellis/tasks/x/brief.md`）；`{ candidates }` 2～20 个同名文件，按长度再按 `zh-CN` 排序；`{}` 不存在或路径无效。
- 查找：先 `locate` 原路径；不存在时以 `/${path}` 为后缀匹配清单。清单优先用 `listFiles()`（Git，含隐藏目录、排除忽略文件），返回 null 或抛错时遍历可见条目（跳过点开头、链接和 `node_modules`，最多 20000 项、深度 12）。每个匹配再经 `locate` 复核。Windows 本机目录不区分大小写，WSL 共享目录区分。
- 渲染状态（`paths.check` 返回）：`pending` 输出普通 `<code data-path-pending>`（外观与代码一致，不可点）；`file` 与 `choices` 输出 `data-workspace-path`，`choices` 的 title 为「工作区中有 N 个同名文件」；`missing` 输出普通代码，Markdown 链接只留文字。
- 缓存：键为 `[session, path]`。该会话的 `tool_result` 与 `terminal` 事件丢弃 `missing`、`choices` **以及尚无结果的在途条目**，只保留 `file`。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 会话不是当前选中会话 | 抛「只能读取当前会话的工作区。」，渲染层删除这批条目、不重渲染，下次渲染重试 |
| `paths` 不是数组、超过 64 项或含非字符串 | 抛「路径列表无效」 |
| 单项含 `..`、盘符、保留名等 | 该项返回 `{}` |
| Git 不可用或清单超过 3 MiB | 静默退回遍历 |
| `locate` 的 `realpath` 遇 `ENOENT`/`ENOTDIR` | 抛「文件不存在或已被移动」，其余错误码保持原样 |

### 5. Scenarios and Examples

- Normal：回复写 `` `verification.md` ``，根下没有，Git 清单中有 8 个同名 → 点击后右栏列出候选，选中后预览，「返回」回到候选。
- Base：工作区不是 Git 仓库 → 遍历可见目录；`README.md` 在根下 → 原样返回，不读清单。
- Incorrect use：`forgetMissingPaths` 只删除已有结果的条目。核对进行中工具写出了文件，迟到的 `{}` 被写回缓存，同一请求后面「已生成 报告.md」的提及一直不可点。
- Correct handling：失效时连在途条目一起删除（`entry.result?.state !== "file"`）；迟到结果只落到旧对象上，`Promise.all` 后的 `refresh()` 重渲染并重新核对。

### 6. Tests Required

- `testing/workspace-panel.test.mjs`：根下文件、唯一同名、多个候选、隐藏目录与 `node_modules` 排除、Git 清单与失败回退、64 项上限、取消信号；处理器拒绝非当前会话与越界路径。
- `testing/markdown.test.mjs`：四种状态的输出（`data-path-pending`、解析后的实际路径、候选 title、缺失只留文字），以及 `hydrate` 收到 `refresh` 函数。
- 浏览器夹具（静态托管 `workbench/index.html` 并注入 `window.flower` 替身）：一次渲染只发一批请求；在途时插入 `tool_result` 后同一路径被再次核对。

---

## Scenario: 推理档位与「关闭思考」的请求字段

### 1. Scope / Trigger

- 触发：改动 `model-library.mjs` 的 `recommendation`/`capability`/`selection`/`runtimeSelection`、渲染层档位滑杆，或升级 pi-ai。
- 关闭思考没有统一字段，依赖 pi `openai-completions` 在未传 `reasoning` 时按 `thinkingLevelMap.off` 决定发什么。

### 2. Signatures

```js
// model-library.mjs
function offMethod(model, fallback) // → "deepseek" | "none" | "omit"
export function setModelEffort(library, effort, catalog) // effort 必须在 available 内，"default" 不再可保存
export function runtimeSelection(service, catalog) // → { model: { thinkingLevelMap, compat: { thinkingFormat } }, reasoning }
```

### 3. Contracts

- `available` 只列能实际发送的档位，顺序为 `off, minimal, low, medium, high, xhigh, max`。pi 目录 `getSupportedThinkingLevels` 含 `off` 即可关闭；`thinkingLevelMap.off === null`（如 claude-opus-5-5、gpt-5、o 系列）不可关闭。
- 默认档：模型条目未选或已失效的 `effort`（含旧文件中的 `"default"`）落到 `available[0]`，即能关时为 `off`，否则为最低档。
- 关闭方式与请求体（`effort === "off"` 时 `reasoning` 为空）：

| `off` | 适用 | `runtimeSelection` 处理 | pi 发出 |
| --- | --- | --- | --- |
| `deepseek` | pi DeepSeek 目录模型，直连或经网关 | `compat.thinkingFormat = "deepseek"`，删除 `thinkingLevelMap.off` | `thinking: { type: "disabled" }` |
| `none` | pi 标 `off: "none"`（gpt-5.1 起），或服务声明、手动档位含关闭的非 DeepSeek 模型 | `thinkingLevelMap.off = "none"` | `reasoning_effort: "none"` |
| `omit` | pi 可关闭但无标准字段（如 claude-sonnet-5） | `thinkingLevelMap.off = null` | 不带推理字段 |

- 其他档位：直连 DeepSeek 全档位用 `deepseek` 格式（`thinking.type=enabled` + `reasoning_effort`）；经网关仍用 `openai` 格式（只发 `reasoning_effort`）。
- 未识别模型（无 pi 条目、无服务声明）`available` 为空，不显示滑杆、不发推理字段。模型编辑页的「服务默认」策略（`mode: "none"`）同样不发送。
- 渲染层：`effortNames.off` 为「关闭思考」；输入框模型按钮在 `off` 时不显示档位文字；只有一个档位时不显示滑杆页。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `setModelEffort` 传入不在 `available` 的档位（含 `"default"`） | 抛「当前模型不支持此推理档位。」 |
| 服务目录声明了档位但不含关闭，模型是 DeepSeek | 补上 `off`（DeepSeek 目录只列思考开启时的 effort） |
| 换 Key 或地址后，自动档位条目被重置为 `"default"` | 重新确认后落到最左档 |

### 5. Scenarios and Examples

- Normal：deepseek-flash 经网关、未选档位 → 默认「关闭思考」，请求体只有 `thinking: { type: "disabled" }`；切到「低」→ `reasoning_effort: "low"`，无 `thinking`。
- Base：claude-sonnet-5-5 不可关闭 → 默认 `reasoning_effort: "low"`；gpt-5.2 未选 → `reasoning_effort: "none"`。
- Incorrect use：把关闭思考一律映射为 `thinkingLevelMap.off = "none"`。DeepSeek 不认 `reasoning_effort: "none"`，思考不会关闭。
- Correct handling：按 `offMethod` 区分三种方式；新增模型族时先在 `model-library.test.mjs` 用回环网关确认实际请求体。

### 6. Tests Required

- `testing/model-library.test.mjs`：经锁定 pi 与 `mock-model.mjs` 断言请求体中 `reasoning_effort`、`thinking` 的有无与取值，覆盖 DeepSeek 直连/网关、gpt-5.2、claude-sonnet-5（omit）、claude-sonnet-5-5（不可关闭）、未识别模型、`"default"` 被拒。
- Windows：`verify-model-suite-windows.mjs`、`verify-model-presets-windows.mjs` 断言推荐档位文案（如「关闭思考 · 低 · 高 · 最高」）、滑杆 `aria-valuetext` 与回环请求字段；推荐档位变化时必须同步这两个脚本。

---

## Scenario: 本机排队消息与插话

### 1. Scope / Trigger

- 触发：改动 `session-queue.mjs`、Main 的 `submit` / `retry-request` / `cancel` / 队列处理器、`onEvent` 中的 `queue.receive`，或渲染层 `agentUI.queueBar`。
- Desktop 不再依赖运行时的 `queued` 记录：同一会话同一时刻最多一条活动请求，其余消息在 Main 排队。

### 2. Signatures

```js
// workbench.json 会话项（可缺省）
{ queue?: [{ id, input, attachments?, createdAt }], queuePaused?: true }
// preload → Main（均校验当前选中会话）
submit(session, input)              // → 运行时请求记录 | { queued: itemId }
editQueueItem(session, item, input, keepAttachmentIds) / removeQueueItem(session, item)
reorderQueue(session, ids) / resumeQueue(session) / holdQueueItem(session, item | null)
steerQueueItem(session, item)       // 不进入 serializeTaskChange，附件读取可能较慢
// state().queue（仅当前会话）
{ items: [{ id, input, attachments, steering }], paused, steerable }
```

### 3. Contracts

- 分流：会话空闲、队列空且未暂停才直接提交；否则入队（最多 20 条），附件随消息离开草稿，失败放回草稿。暂停中再次发送即恢复，新消息排队尾。
- 派发：运行时 `terminal` 事件在 Main 删除活动请求后交给 `queue.receive`，经 `serializeTaskChange` 派发队首。队首发送失败时保留并暂停，发 `{ kind: "notice", tone: "error" }`。
- 暂停：`cancel` 处理器先同步置 `queuePaused`（保证随后的终态不派发）；工作进程退出 `pauseAll`；启动加载时有队列一律暂停。
- 编辑暂缓：行内编辑前 `holdQueueItem(item)`，队首正在编辑时不派发；保存（`edit` 内解除）、放弃（`hold(null)`）、切换会话（`selectWorkspaceSession`）或页面 `dom-ready` 时解除并补派发。
- 插话：`steerQueueItem` 把消息 ID 作为 `steerId` 交给运行时，送达前保留在队列并标 `steering`（只在内存）；`steered` 事件到达时移出队列，Main 给事件附上 `input` / `attachments` 再转发渲染层；运行结束仍未送达的回到队首并暂停。
- 附件回收：`discardUnused` 的保留集合包含草稿、全部排队消息与历史请求的 `attachments` 及 `steers[].attachments`。
- worker 对 `RuntimeError` 原样返回说明（如「当前运行已结束，无法插话」），其余异常仍返回固定提示。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 排队消息 ID 不是 UUID | 「无效的排队消息。」 |
| 消息已发送或已删除 | 「这条排队消息已发送或已删除。」 |
| 编辑或删除正在插话的消息 | 「这条消息正在插话，送达后会从队列移除。」 |
| 重排的 ID 集合与当前队列不一致 | 「队列已变化，请重新排序。」 |
| 会话没有运行中的请求时插话 | 「当前没有运行中的任务，无法插话。」 |
| 第 21 条入队 | 「排队消息最多 20 条，请等待当前任务结束。」 |

### 5. Scenarios and Examples

- Normal：运行中发送两条 → `{ queued }`，时间线不出现「已排队」；终态后自动发送第一条，再终态发送第二条。
- Base：取消当前运行 → 队列暂停，终态不派发；`resumeQueue` 后发送队首。
- Incorrect use：在渲染层记录编辑状态而不告知 Main，当前任务恰好结束时修改前的原文被发出，保存时报「已发送或已删除」。
- Correct handling：进入编辑前先 `holdQueueItem`，成功后才显示编辑框；连续点击先占位，只发一次暂缓请求。

### 6. Tests Required

- `testing/session-queue.test.mjs`：直接提交与入队、按序派发、暂停与恢复、发送失败暂停、行内编辑保留位置与附件、重排校验、20 条上限、插话送达移出与未送达回队首、编辑暂缓与解除、`pauseAll`。
- `testing/queue-side-chat.test.mjs`（真实 Main、preload、worker 与回环模型）：插话送达的 `textOffset`、取消后暂停与继续、编辑暂缓后按改后原文发送、重启后队列保留且暂停。

---

## Scenario: 侧边追问会话

### 1. Scope / Trigger

- 触发：改动 Main 的 `open-side-chat` / `close-side-chat` / `side-chat-history` / `submit-side-chat` / `queue-to-side-chat` / `cancel-side-chat`、`dropSideChat`、worker 的只读授权，或 `ui/side-chat.js`。

### 2. Signatures

```js
// workbench.json：每个主会话最多一个，不在 sessions 中
sideChats: [{ id, parent, workspace, turns }]
// worker register 帧
{ type: "register", session, workspace, readOnly: true }
// state()
sideChats: [{ id, parent, turns, busy }]
```

### 3. Contracts

- 分叉：读取主会话记录文件，至少一条成功请求；以其 `workspaceId`（旧记录取首条请求的）、`messages`、`contextCheckpoint` 写出新会话文件，`requests` 与 `desktopMessages` 为空。主会话的 `messages` 只在成功时整体替换，文件中就是已完成的上下文。
- 只读：worker 对 `readOnly` 会话去掉 `write_report`，写入审批固定返回 `"read"`（`analyze_excel` 的 `createOutputs` 因此报只读），系统提示追加侧边追问说明。
- 只收文字、不排队：回答中提交被拒；`queue-to-side-chat` 取出排队消息作为文字发送，失败时放回队首，附件不随行并在不再被引用时回收。
- 删除：替换、关闭、删除主会话或工作区都走 `dropSideChat`：移出列表、登记 `deletions`、取消其活动请求；仍在运行的登记 `retiredSideChats`，其终态写盘后再登记一次删除并清理，防止收尾提交重新写出文件。启动时父会话已不存在的侧边追问直接登记删除。
- 事件：侧边追问的终态不触发系统通知与未读标记；渲染层按 `state().sideChats` 的 ID 把事件交给侧边追问，`runtimeRevision` 变化时重读其历史。
- 入口：回复选区、队列项「更多」与右栏「侧边追问」标签。标签按是否有当前主会话显示（`sideAvailable(Boolean(parent))`），不看是否已建立；未建立时页头显示「发送第一条后，以主会话已完成的对话为参考开始」、隐藏新建与关闭，发送按钮按 `parent` 启用。页内发送时先 `openSideChat(parent)` 再 `submitSideChat`，新建失败（如首轮未完成）由 Toast 说明并把原文放回输入框；Main 侧契约不变。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 主会话尚无成功请求 | 「请先等待主会话完成一次回答。」 |
| 非当前选中会话 | 「会话已切换，请在当前会话操作。」 |
| 没有侧边追问 | 「侧边追问已关闭。」 |
| 侧边追问回答中再次提交 | 「侧边追问正在回答，请稍候或先停止。」 |
| 写出会话文件后保存 workbench.json 失败 | 删除新文件并回滚列表 |

### 5. Scenarios and Examples

- Normal：主会话运行中打开 → 只带入已完成的轮次；侧边追问回答，主会话继续运行，主会话历史不变。
- Base：重启后侧边追问仍在，首次读取历史时以只读权限重新登记。
- Incorrect use：把侧边追问放进 `workbench.sessions`，会出现在侧栏、搜索与中断横幅中，并被当作普通会话通知。
- Correct handling：单独保存在 `sideChats`，所有入口经 `sideChatOf(parent)` 定位。
- Incorrect use：标签靠 `hidden` 隐藏，但 `.panel-tabs .button { display: flex }` 盖过了它，未建立时标签仍可点，进入后发送按钮因 `!chat` 永远停用（第二档试用中出现）。
- Correct handling：为 `.panel-tabs .button[hidden]` 补 `display: none`；页内未建立时首条消息即新建。

### 6. Tests Required

- `testing/queue-side-chat.test.mjs`：首轮完成前打开被拒；分叉文件含主会话消息；侧边请求的系统提示含侧边说明且工具不含 `write_report`；关闭删除文件；删除主会话连带删除。
- Windows `verify-ux-tier2-windows.mjs`「侧边追问标签直接发送」：关闭后标签仍**可见**（用 `isVisible`，不能只查 `hidden` 属性），页内发送后建立并得到回答。

---

## Scenario: 输入框 @ 补全的文件清单

### 1. Scope / Trigger

- 触发：改动 `workspace-files` IPC、`workspace.mjs` 的 `workspaceFiles` / `rankWorkspaceFiles`，或 `agentUI.mentionPicker`。

### 2. Signatures

```js
workspaceFiles(session, query)                       // preload → Main，readSelectedWorkspace 限当前会话
export async function workspaceFiles(workspace, signal, listFiles) // Git 清单优先，失败或 null 时遍历
export function rankWorkspaceFiles(files, query, limit = 50)
```

### 3. Contracts

- 清单与回复路径核对共用 `workspaceFiles`；Main 按工作区缓存 30 秒，避免逐字查询都调用 Git 或遍历。
- 只返回 `canAttachWorkspaceFile` 为真的文件；排序依次为文件名前缀、文件名包含、路径包含，同级按路径长度再按 `zh-CN`。
- 渲染层：`@` 位于行首或空白后才触发，查询不含空白与 `@`；输入法组合中不触发；列表打开时在捕获阶段截获 ↑/↓/Enter/Tab/Esc 并 `stopImmediatePropagation`，不触发历史召回与发送；确认后删除 `@查询` 再调用 `referenceFile`。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `query` 不是字符串或超过 200 字 | 「查询无效」 |
| 非当前选中会话 | 「只能读取当前会话的工作区。」 |
| 首页没有会话 | 渲染层不请求，列表不打开 |

### 5. Scenarios and Examples

- Normal：输入「@预算」→ 列出「预算.xlsx」「归档/预算明细.xlsx」「财务/年度预算.xlsx」，回车加入附件。
- Incorrect use：在冒泡阶段监听方向键，`bindComposer` 先处理，空输入框时召回了历史输入。
- Correct handling：补全监听用 `{ capture: true }` 并在处理后 `stopImmediatePropagation`。

### 6. Tests Required

- `testing/workspace-panel.test.mjs`：`rankWorkspaceFiles` 排序、过滤与上限、查询校验。
- `testing/composer.test.mjs`：`mentionQuery` 的行首、空白与邮箱地址判定。
- `testing/queue-side-chat.test.mjs`：经真实 Main 只返回可加入对话的文件。

---

## Scenario: 正文索引、会话搜索与中断恢复

### 1. Scope / Trigger

- 触发：改动 Main 的 `indexedTurns` / `search-sessions` / `resume-interrupted` / `dismiss-interrupted` / `compact-context`，`session-search.mjs`，`request-history.mjs` 的 `compactionMark`，或渲染层 `searchBodies` / `openHit` / `thread().reveal`。

### 2. Signatures

```js
searchSessions(query)        // → [{ id, snippets: [{ requestId, field: "input" | "text", before, match, after }] }]
resumeInterrupted(ids) / dismissInterrupted()
compactContext(session)      // → boolean；runtime-host 调用超时 600 000 毫秒
cancelCompaction(session)
// state()
interrupted: [{ id, title }]; compacting: boolean
// history 行；compactedBy 只在带分隔的那一行有值，早期检查点为 undefined
compactedBefore: boolean; compactedAfter: boolean; compactedBy?: "auto" | "manual"
```

### 3. Contracts

- 正文索引按记录文件 `mtimeMs` 与 `size` 复用，只含提问原话（`desktopMessages`）与回复正文，不含工具结果；只遍历 `workbench.sessions`，侧边追问不入结果。查询去空白后不足 2 个码点返回空；每会话最多 3 条片段，最多 50 个会话。
- 中断识别在 `loadLocal` 宣告就绪后后台执行，不放进处理器等待的初始化；最后一条请求为 `interrupted`、`queued`、`running` 或 `cancelling` 即中断。提交、重试、继续或删除该会话时移出；忽略只影响本次运行的横幅。
- 「全部继续」逐个取最后一条未完成请求，以原输入与原附件重新发送；会话有保留的排队消息时插到队首再恢复队列，保证先续跑中断的任务。
- 压缩期间 `sessionBusy` 为真：新消息排队、模型设置不可改；结束后补派发队列。
- 渲染层：正文结果按查询序号丢弃过期响应，只采用与当前输入一致的结果；点击片段先记下 `pendingReveal`，会话历史渲染后由 `thread().reveal` 跳转并用 `CSS.highlights`（找不到时整轮提示）高亮约 2 秒，覆盖待恢复的阅读位置。
- 入口文案：侧栏按钮「搜索」、输入框提示「搜索标题或内容…」；去空白后恰好 1 个码点时显示 `#session-search-hint`「输入两个字以上会同时搜索对话内容」。片段前缀 `.session-snippet-kind` 为「提问」或「回复」。
- 压缩分隔：文案为「以上对话已自动压缩为摘要」「以上对话已手动压缩为摘要」，`compactedBy` 缺失时为「以上对话已压缩为摘要」；定位规则见 agent-runtime `event-persistence.md`「手动压缩」。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `query` 不是字符串或超过 180 字 | 「搜索内容无效」 |
| `resume-interrupted` 含不在中断列表的会话 | 「中断任务已变化，请重新查看。」 |
| 个别会话无法继续 | 其余照常继续，最后报「以下任务未能继续：…」 |
| 压缩时会话忙 | 「会话正在运行，结束后再压缩。」 |

### 5. Scenarios and Examples

- Normal：搜「二月核对」→ 命中回复正文的片段，点击后切到会话并跳到该轮，关键词高亮。
- Base：重启时有运行中的请求 → 横幅列出该会话；「全部继续」后先续跑该请求，再发送重启前保留的排队消息。
- Incorrect use：`revealPending` 写成 `if (pendingReveal?.session !== session) return`，启动时两者都是 `undefined`，继续执行后读取 `pendingReveal.requestId` 崩溃。
- Correct handling：先判断 `!pendingReveal`。

### 6. Tests Required

- `testing/session-search.test.mjs`：原话优先、片段截取与省略号、大小写、上限、中断判定。
- `testing/queue-side-chat.test.mjs`：正文命中与片段字段、单字不搜、侧边追问不被搜到、删除后不命中；运行中拒绝压缩、手动压缩与分隔位置、不重复压缩；重启后的中断横幅、忽略、全部继续的执行顺序。
- `testing/context-continuity.test.mjs`：自动压缩后历史中只有一处压缩标记，`compactedBy` 为 `auto`；`queue-side-chat.test.mjs` 手动压缩后为 `manual`。
- `testing/request-history.test.mjs`：`compactionMark` 旧轮次跳过与方式带出。

---

## Scenario: 删除会话先确认

### 1. Scope / Trigger

- 触发：改动 `manage-sidebar` 的会话或工作区删除、`cleanDeleted`、`dropSideChat` 或渲染层 `openSidebarMenu` 的删除分支。第二档曾改为「立即删除 + 8 秒撤销」，试用后按用户决定撤回（R11）。

### 2. Signatures

```js
manageSidebar("session", id, "delete")          // 渲染层先经 #sidebar-dialog 确认
manageSidebar("workspace", id, "delete", count) // count 须等于当前成员数
```

### 3. Contracts

- 渲染层：会话与工作区的删除都打开确认框；会话文案「将删除「<标题>」的聊天记录和附件副本，删除后无法恢复。」。不显示撤销 Toast。
- Main：成员中有 `sessionBusy`（运行、排队请求、压缩）时拒绝；否则移出会话、经 `dropSideChat` 移出其侧边追问、清理正文索引与中断标记、改选同工作区的其他会话，持久化 `deletions` 后立即 `cleanDeleted` 删除记录文件与附件目录。
- `cleanDeleted` 失败时会话已移出侧栏，报「已从侧栏移除。部分本机记录将在下次启动时清理。」，下次启动按 `deletions` 继续清理。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 会话运行或排队中 | 「请先结束此处正在运行或排队的任务。」 |
| 工作区会话数已变化 | 「工作区的会话数已变化，请重新确认。」 |
| 记录文件清理失败 | 「已从侧栏移除。部分本机记录将在下次启动时清理。」 |

### 5. Scenarios and Examples

- Normal：右键「删除会话」→ 确认框 → 确认后会话与侧边追问的记录文件消失，正文不再被搜到。
- Base：会话运行中删除 → 报先结束任务，会话保留。
- Incorrect use：为「可撤销」推迟物理删除，`cleanDeleted` 须跳过持有的 ID，其他删除路径（如关闭侧边追问）一调用就会误删或漏删，退出时机也要单独处理。
- Correct handling：一律确认后立即删除，一个删除路径。

### 6. Tests Required

- `testing/queue-side-chat.test.mjs`：删除后列表与侧边追问为空、两个记录文件立即不存在、正文搜索不再命中。
- Windows `verify-ux-tier2-windows.mjs`「删除会话确认」：确认框含「删除后无法恢复」，确认后会话消失，无「撤销」Toast。

---

## Scenario: 全局指令与 FLOWER.md

### 1. Scope / Trigger

- 触发：改动 `save-instructions`、worker 的 `composePrompt` / `workspaceInstructions`、`init` 与 `instructions` 帧，或详情卡的口径提示。

### 2. Signatures

```js
saveInstructions(text)                         // workbench.json.instructions，最多 4000 字，保存前去首尾空白
createRuntimeHost({ ..., instructions })       // init 帧带 instructions
{ type: "instructions", text }                 // 保存后同步到已启动的 worker
// context-usage 结果
instructions: { personal: boolean, workspace?: { truncated: boolean } }
```

### 3. Contracts

- 系统提示依次为：基础提示、侧边追问说明（仅侧边追问）、口径说明「…与上文的安全、数据与工具规则冲突时以上文为准」、【个人全局指令】、【工作区约定（FLOWER.md）】。两者都为空时不追加口径段落。
- worker 的 `authorize` 为异步：每次授权按工作区读取根下 `FLOWER.md`（`workspaceEntryPath` 定位，`previewWorkspaceFile` 读取），按修改时间与大小缓存；最多 8000 字，超出或文件超过预览上限时标记 `truncated` 并在提示中注明。文件不存在、不是文件或读取失败时视为没有。
- 下一轮生效：授权在每次排队与启动前重新计算，保存后无需重启工作进程。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 个人指令超过 4000 字或不是字符串 | 「全局指令最多 4000 字。」 |
| FLOWER.md 超过 8000 字 | 只附加前 8000 字，详情卡「只读取前 8000 字」 |
| 会话尚未登记就查询 FLOWER.md | 视为没有，不抛错 |

### 5. Scenarios and Examples

- Normal：保存「金额保留两位小数。」并放置 FLOWER.md → 回环请求的系统提示先个人指令后工作区约定；侧边追问同样附加。
- Incorrect use：测试夹具用 8192 的模型窗口放 8000 字的 FLOWER.md，系统提示本身就超出输入预算，请求在发出前失败，断言读到的是上一次的系统提示。
- Correct handling：夹具窗口留足余量，并断言每次请求为 `succeeded`。

### 6. Tests Required

- `testing/instructions.test.mjs`：未设置不追加、4000 字上限、拼接顺序、8000 字截断与提示、侧边追问附加、清空与删除后不再追加、重启后随初始化下发、上下文用量中的口径信息。
- `testing/context-continuity.test.mjs`：上下文用量结果包含 `instructions: { personal: false }`。

---

## Scenario: 交付卡片元信息

### 1. Scope / Trigger

- 触发：改动 `artifact-info` IPC、`workspace.mjs` 的 `artifactSummary` 或 `agentUI.artifactMeta`。

### 2. Signatures

```js
artifactInfo(session, path)  // → { kind: "xlsx", sheets, rows } | { kind: "md", chars }
export async function artifactSummary(workspace, path, signal)
```

### 3. Contracts

- 只接受当前会话工作区内符合产物格式（`Flower-分析-<uuid>/` 下的 `分析报告.md`、`汇总.xlsx`、`核对报告.md`）的路径。只读元信息、不启动外部程序，因此不像 `open-artifact` 那样读取历史核对请求归属。
- 工作簿行数为各表 `actualRowCount - 1` 之和（不含表头）；报告字数为去除空白后的码点数。Main 按工作区、路径、修改时间与大小缓存。
- 渲染层在卡片渲染后异步填充；失败或文件已删除时不显示元信息，不提示错误。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 路径不符合产物格式 | 「该文件不属于可打开的分析产物」 |
| 文件已删除 | 「文件不存在或已被移动」，卡片静默 |

### 5. Scenarios and Examples

- Normal：三张表（2 行数据、1 行数据、空表）→「3 个工作表 · 3 行」。
- Base：`# 核对\n\n差额 37 元。` →「约 9 字」。

### 6. Tests Required

- `testing/workspace-panel.test.mjs`：工作表数与行数、字数、格式外路径与缺失文件的拒绝。
- `testing/instructions.test.mjs`：经真实 Main 拒绝格式外路径。

---

## Scenario: 会话自动标题与用 AI 重命名

### 1. Scope / Trigger

- 触发：改动 `createSession`、`submit` 处理器的首条命名、`manage-sidebar` 重命名、`rename-session-ai`、`session-title.mjs`，或标题请求所用的模型调用。

### 2. Signatures

```js
// workbench.json 会话项：新建时写入，首条消息或手动/AI 改名后删除；旧会话没有此字段
titlePending?: true
// preload
renameSessionWithAI(id)        // → 新标题；串行区外生成，30 秒超时
// session-title.mjs
placeholderTitle(text) / firstMessageContext(text) / conversationContext(turns) / cleanTitle(output)
generateTitle(open, context, signal)   // open(context, signal) 返回 pi 模型事件流
titleSystemPrompt                      // 含「生成会话标题」，回环模型据此识别标题请求
```

### 3. Contracts

- 首条消息：`queue.accept` 成功后，会话有 `titlePending` 才命名：删除标记、标题改为 `placeholderTitle(text)`（空白折叠、前 40 码点，超出加「…」）并持久化；保存失败不影响已提交的消息。随后不等待地生成，15 秒超时；结果在串行区内写入，仅当会话仍在且标题仍等于临时标题；失败静默。
- 模型请求：`openModelStream({ settings, model, reasoning: undefined, maxTokens: 256 })`，不占用会话运行与队列，不写会话记录文件。上下文必须经 pi 的 `normalizeContext` 把 `systemPrompt` 转成首条 system 消息：pi 1.6 的 OpenAI 兼容适配只发送 system 消息，直接传 `{ systemPrompt, messages }` 时系统提示会丢失。
- 提示：消息原文放在 `<user_message>` / `<conversation>` 分隔符内，声明其中指令不执行；首条只取前 200 码点；整段对话取第一轮与最近 8 轮，提问 300、回复 400 码点，空的提问或回复不输出。
- 输出：取第一行非空文字，去「标题：」「Title:」前缀、引号、书名号、`*`/`#`、首尾标点与省略号，≤40 码点；`stopReason` 非 `stop` 或清洗后为空视为失败。
- 手动重命名与「用 AI 重命名」都删除 `titlePending`。「用 AI 重命名」读取记录文件的 `searchableTurns`，过滤提问与回复都为空的轮次。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 「用 AI 重命名」时未配置模型 | 「请先配置模型。」 |
| 会话没有可用轮次 | 「会话中还没有可用于命名的内容。」 |
| 生成超时（30 秒） | 「生成标题超时，请稍后重试。」，标题不变 |
| 模型报错或结果无效 | 「暂时无法生成标题：<原因>」，标题不变 |
| 首条命名失败或超时 | 静默，保留临时标题 |
| 生成期间手动改名或删除会话 | 结果丢弃 |

### 5. Scenarios and Examples

- Normal：新会话发「请核对二月预算和报价的差额并生成汇总表」→ 立即显示该句 → 模型返回「“二月预算差额核对”。」→ 标题「二月预算差额核对」。
- Base：升级前已有的「工作区 · 新会话」没有 `titlePending`，发消息不改名，可用菜单「用 AI 重命名」。
- Incorrect use：直接把 `{ systemPrompt, messages }` 交给 `openModelStream`，请求体里没有 system 消息，模型把命名指令当作普通对话回答。
- Correct handling：用 `normalizeContext` 构造上下文；回环模型按 system 消息中的「生成会话标题」识别标题请求，单独记在 `observations.titles`，不计入对话请求的观察记录。

### 6. Tests Required

- `testing/session-title.test.mjs`：临时标题截断与 emoji、上下文截断与分隔符、清洗规则、`generateTitle` 的错误事件、非 stop、空结果与取消。
- `testing/session-title-flow.test.mjs`（真实 Main、worker 与回环模型）：首条命名与请求无推理字段、第二条不再命名、生成期间手动改名优先、失败保留截断后的临时标题、用 AI 重命名的内容与空会话/失败报错、旧会话不命名。
- Windows `verify-title-windows.mjs`：侧栏与标题栏的首条命名、菜单「用 AI 重命名」、失败保留临时标题；`verify-write-permission-windows.mjs` 核对权限文案「只读 / 请求批准 / 帮我批准」。
