# 第一档技术设计

行号引用以 [research/tier1-code-facts.md](research/tier1-code-facts.md) 为准（2026-11-24 11:10，开工时哈希未变）。`R/` = `packages/agent-runtime/src/`，`W/` = `apps/desktop/workbench/`。

## 边界与原则

- 共享运行时只增加**向后兼容的可选字段与可选宿主钩子**，不新增事件种类，`dual-host.test.ts` 的事件类型序列不变。code-reviewer 宿主不提供新钩子时行为不变。
- 需要持久化的信息（步骤、时间）跟随已有的工具事件与终态事件一起提交，不增加落盘次数。只用于展示的瞬时信息（推理）走 worker 旁路，不进共享核心。
- 渲染层权限请求全拒、CSP 只允许 blob 图片（§10.7）：剪贴板、通知、右键菜单、文件定位都由 Main 通过 preload IPC 完成，Main 对会话、请求、路径逐项复核。新增 IPC 沿用现有 `handle` 的发送窗口与主文档校验。
- 新增 electron 具名导入（`Notification`）同步补到 `apps/desktop/testing/workspace-panel.test.mjs` 的假 electron 模块。
- 改 `R/*.ts` 后执行 `npm run build -w @flower-ai/agent-runtime`，Desktop 通过 dist 生效（§9.3）。

## R1 运行过程可读化

### 运行时契约（`R/types.ts`、`R/index.ts`）

```ts
/** 一次工具调用的展示摘要，随请求保存。 */
export interface ToolStep {
	toolCallId: string;
	toolName: string;
	/** 宿主给出的简短目标描述，如文件名，最长 120 字符。 */
	target?: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
}

RequestRecord += { startedAt?: number; endedAt?: number; steps?: ToolStep[] }
RuntimeEvent 公共头 += { at: number }             // 提交时刻，毫秒；运行时为每个事件填写
tool_started += { target?: string }
SessionGrant（公共部分）+= describeTool?(toolName: string, args: unknown): string | undefined  // 可选，自带执行器的宿主可不提供
```

- `recordProgress` 在 `tool_execution_start` 调用 `grant.describeTool?.(toolName, args)`，异常或非字符串视为无目标，结果截断到 120 字符；向 `record.steps` 追加步骤并在事件中带 `target`。`tool_execution_end` 按 `toolCallId` 补 `endedAt`、`isError`。
- `started` 提交时写 `record.startedAt`，终态提交时写 `record.endedAt`。所有事件头带 `at`。
- 步骤不保存工具参数原文，避免 `write_report.markdown`（≤64 KiB）等大参数进入会话文件。
- 未完成（中断）轮次的未结束步骤在重启恢复时保持无 `endedAt`，界面显示为「已结束」。

### Desktop 宿主

- worker 在 `authorize` 返回的授权里提供 `describeTool`：`list_workspace` 取 `directory`（空为「工作区」）；`read_text_file`、`inspect_excel`、`analyze_excel` 取 `path` 的文件名，`analyze_excel` 有 `sheet` 时追加「 · 表名」；`write_report` 取 `input` 文件名，无则不带目标。`attachment:<hash>` 经 `running.get(session).refs` 与已成功请求的附件映射为附件名（同 `W/worker.mjs:160-175` 的解析逻辑，抽成共用函数）。
- `worker.history()` 行增加 `steps`、`startedAt`、`endedAt`。renderer 的 `reloadHistory` 用持久化步骤替换内存步骤，不再依赖窗口内存（§1.7）。
- 工具名到动作的映射集中在一处（`ui/agent.js`）：

| toolName | 进行中 | 完成 | 摘要计数 |
|---|---|---|---|
| `list_workspace` | 正在查看 | 已查看 | 查看 N 个目录 |
| `read_text_file` | 正在读取 | 已读取 | 读取 N 个文件 |
| `inspect_excel` | 正在检查 | 已检查 | 检查 N 个工作簿 |
| `analyze_excel` | 正在分析 | 已分析 | 分析 N 个工作簿 |
| `write_report` | 正在写入 | 已写入 | 写入 N 份报告 |
| 其他 | 正在调用工具 | 已调用工具 | 另外 N 项 |

- `W/workspace.mjs` 的 `analyze_excel` label 改为「分析工作簿」，renderer `toolLabels` 删除，统一用上表。
- 摘要：终态且有步骤时 `<details>` 默认收起，summary 为「已处理 {耗时} · {计数列表}」，失败为「处理失败，耗时 {耗时} · {计数列表}」，取消为「已取消，耗时 {耗时} · {计数列表}」，拒绝授权为「未获授权，耗时 …」，中断为「运行已中断 · …」。耗时取 `endedAt - startedAt`，缺失时省略耗时。运行中 `<details open>`，summary 为当前步骤的进行中文案。保留用户手动展开状态（现有 `previous` 去重机制）。
- 等待态：`queued/running` 且无正文、无步骤时，状态行显示「正在思考」，CSS 扫光动画；`prefers-reduced-motion: reduce` 时无动画。

### 推理旁路

- worker 的 `streamModel` 增加会话参数：`authorize` 中以 `streamFn: (m, c, o) => streamModel(m, c, o, scope.sessionId)` 绑定。`purpose === "summary"` 的流不旁路。
- worker 收到 `model-event` 且为 `thinking_delta` 时，按会话累积当前推理文本（只保留末尾 2 KiB），用 `Intl.Segmenter("zh", {granularity: "sentence"})` 取最后一个完整句，节流 1 秒向 Host 发送 `{kind: "reasoning", sessionId, requestId, text}`（`requestId` 取 `running.get(session)`，无运行请求时丢弃，`text` ≤120 字符）。流结束或 `text_delta` 开始后清空该会话缓冲。
- runtime-host 将 `reasoning` 帧转给 Main，Main 校验会话存在后 `send({kind: "reasoning", ...})`。renderer 只在对应请求为 `running` 且尚无正文时显示，位置在回复头部下方单独一行（与状态并列会挤压「取消任务」等按钮），收到首个 `text_delta` 或终态后清除。不写入 timeline 记录，因此不会被复制或保存。

## R2 多任务提醒

- Main 增加 `attention: Map<sessionId, "done" | "failed">`（仅内存）。终态事件：`succeeded` → `done`，`failed`/`interrupted` → `failed`，`cancelled`/`denied` 不标记；若该会话是当前选中且窗口处于前台，则不标记。窗口 `focus` 时清除当前选中会话的标记；选中会话（`select-session`）时清除该会话标记。
- 未读规则与优先级集中在 `W/attention.mjs` 的 `createAttention()`。`state().sessions[]` 只增加由 `busy`、`awaitingWrite` 与未读标记派生的单一字段 `indicator: "running" | "approval" | "done" | "failed" | undefined`，优先级 approval > running > failed > done。终态事件后 `announce()` 已存在（`W/main.mjs:361`），`started` 也需 `announce()` 以刷新运行中标记。
- 侧栏会话行（`W/ui/agent.js` `sessionList`）按 `indicator` 渲染小圆点与 `aria-label`（「运行中」「等你处理」「已完成，未查看」「失败，未查看」）；现有「待批准」徽标保留并归入 approval。运行中圆点在减弱动效时不旋转。工作区分组折叠时组级显示最高优先级。
- 通知：Main 在终态（done/failed 条件同上）与新增待批准时，若 `!window.isFocused()`，`new Notification({title: 会话标题, body: 「已完成」/「未完成：失败说明首句」/「需要你批准写入」, silent: false})`；`click` 时还原并聚焦窗口，`send({kind: "focus-session", id})`，renderer 走现有 `ui.selectSession`。同时 `window.flashFrame(true)`，`focus` 时 `flashFrame(false)`。`Notification.isSupported()` 为假时只闪烁。
- Windows：启动时 `app.setAppUserModelId("Flower.Desktop.Open")`（AppUserModelId 不得含空格）。解压版无开始菜单快捷方式时 toast 可能不显示，实机记录结果；不显示时以任务栏闪烁兜底并在交付说明中写明，是否创建快捷方式另行决定。
- 关闭确认：`window.on("close")` 中若 `activeRequests.size + approvals.size > 0` 且未确认，`preventDefault()`，`dialog.showMessageBox(window, {type: "warning", buttons: ["仍然关闭", "取消"], defaultId: 1, cancelId: 1, message: 「还有 N 个任务未完成」, detail: 「关闭后这些任务会被中断，下次打开显示为已中断。」})`；选择关闭后置位并再次 `close()`。

## R3 消息操作

- 模型图片能力校验抽为 `requireImageSupport(refs)`，`submit` 与重试共用；`submit` 保持从草稿取附件、清空与失败回写的原有行为。
- `retryableRequest(id, requestId)` 统一校验：请求标识格式、`id === workbench.selected`、从 worker 历史取出该请求且状态为 `failed`/`cancelled`/`interrupted`/`denied`；附件取该请求历史行自身的引用（早期记录的 `file` 字段转为文件引用）。
- `retry-request(session, requestId)`：经 `retryableRequest` 校验后检查模型与图片能力，以原 `input` 与附件直接提交到运行时，不触碰当前草稿。
- `restore-request-draft(session, requestId)`：同样校验，把附件写为当前会话草稿附件（替换），返回原 `input`。renderer 在输入框或草稿附件非空时先 `confirm` 覆盖，再填入文本并 `syncSend()`、聚焦。
- `copy-text(text)`：字符串且 ≤ 200,000 字符，`clipboard.writeText`。用户消息复制与 R5「复制路径」共用；现有 `copy-reply` 不变。
- 用户消息悬停与键盘焦点时显示「复制」，未完成请求的回复头显示「重试」「编辑」；`succeeded` 不显示编辑。

## R4 阅读位置

- `thread`（`W/ui/agent.js`）增加 `remember(session)` / `restore(session)`：切换前记录 `{offset, atBottom}`；新会话首个 `update` 后恢复，`atBottom` 为真时贴底并保持跟随。未记录过的会话贴底。
- 滚动区底部居中放「回到底部」按钮（`aria-label="回到底部"`），距底部超过 65 像素（现有跟随阈值）时出现；离开底部期间收到更新时加提示点。点击平滑滚动，减弱动效时直接跳转。

## R5 回复中的文件路径

- `flowerMarkdown.view(root, openLink, paths)` 增加可选的 `paths`（`resolve`、`open`、`menu`、`hydrate`、`openImage`），只在聊天回复中传入，工作区面板预览不传。
- 路径解析为 `flowerMarkdown.workspacePath(root, text)`（`W/ui/markdown.js`，渲染层传入当前会话 `path`）：去掉首尾引号与反引号，统一分隔符；拒绝 scheme、`..` 段、控制字符；绝对路径须以工作区根为前缀（Windows 盘符与 UNC 忽略大小写），转为相对路径；文件名须带常见文件扩展名（文档、表格、图片、常见源码等，避免把 `example.com`、`v1.2` 当成路径）且不超过 255 字符。返回相对路径（`/` 分隔）。
- 渲染：`link` 的非 http(s) 地址可解析时输出 `<a href="#" data-workspace-path>`；`codespan` 可解析时输出 `<code class="path-ref" data-workspace-path role="link" tabindex="0">`；`image` 可解析且扩展名为图片时输出 `<img data-workspace-image alt>`，否则保持原文。
- 交互：root 级事件委托处理点击与 Enter，调用 `actions.previewPath(path, trigger)` → `workspacePanel.preview`。`contextmenu` 时 `preventDefault` 并调用 `show-path-menu`。
- 图片：markdown 每次更新后对未加载的 `img[data-workspace-image]` 按路径从会话级缓存取 blob URL，缓存未命中时调用 `previewWorkspaceFile`，`kind === "image"` 时生成 blob URL；失败时替换为原文。切换会话时撤销该会话缓存的 blob URL。点击打开现有图片查看器。
- `show-path-menu(session, path, options)`：Main 校验当前会话与路径（`locate`），弹出原生菜单「预览」（options.preview 为真时）「在资源管理器中显示」「复制路径」。「在资源管理器中显示」调用 `shell.showItemInFolder(真实路径)`；「复制路径」复制绝对路径；「预览」返回 `"preview"` 给渲染层执行。

## R6 原生右键菜单

- `window.webContents.on("context-menu", (event, params))`：`params.isEditable` 时按 `editFlags` 启用「剪切」「复制」「粘贴」「全选」（role 菜单项）；否则有 `selectionText` 时「复制」；`mediaType === "image"` 时追加「复制图片」（`webContents.copyImageAt(params.x, params.y)`）。都没有时不弹出。页面自行 `preventDefault` 的区域（侧栏会话行、路径）不受影响。
- 工作区面板文件行（`W/ui/workspace-panel.js`）与交付文件卡（`W/ui/agent.js` `deliverables`）的 `contextmenu` 调用 `show-path-menu`；交付文件带 `preview: true`。

## R7 长粘贴折叠

- `W/ui/attachments.js` 的 paste 处理：无图片文件且 `text/plain` 满足「> 2000 字」或「> 20 行」或「输入框现有长度 + 选区替换后 > 16000」时 `preventDefault`，调用 `host.pasteText(session, text)`。
- `paste-text(session, text)`：要求当前会话；UTF-8 字节 ≤ 1 MiB；草稿附件未满 8 个；文件名「粘贴的文本（{行数} 行）.txt」；`attachment-assets.mjs` 导出 `importAttachmentText(directory, session, text, name)`，内部复用 `storeFile`（`text/plain`）；结果并入草稿附件，返回更新后的草稿。失败时返回明确提示，渲染层用现有反馈区域显示，不改动输入框。
- 进入模型时走现有 `asset:` 附件路径（内联正文 ≤24K 字符 + `attachment:` 引用，§6）。

## R8 历史输入召回

- `bindComposer(input, submit, options)` 增加 `options.history() => string[]`（当前会话已发输入，旧到新，去掉空值与相邻重复）。
- 状态：`cursor`（-1 表示未召回）、`saved`（进入召回前的草稿）、`shown`（当前显示的召回文本）。`ArrowUp`：`cursor === -1` 时仅在输入框为空时进入；召回中且 `input.value === shown` 时继续向旧；`ArrowDown` 向新，越过最新恢复 `saved` 并退出；`Escape` 恢复 `saved` 并退出。`input.value !== shown` 时退出召回，方向键走默认行为。`isComposing` 或 `keyCode === 229` 时不处理。改值后调用 `syncSend()`。

## R9 窗口状态持久化

- 新增 `W/window-state.mjs` 纯函数：`restorableBounds(saved, areas)` 校验数值、尺寸下限 640×560、45 像素高的标题栏区域与任一显示器 `workArea` 的交集至少 120×30（可抓取），尺寸不超过该工作区，否则返回 undefined 由 Main 使用默认尺寸居中；`savedBounds(normal, panelExpansion, ...)` 复用 `window-fit.mjs` 的 `restoredBounds` 扣除外扩；`readWindowState`、`writeWindowState` 同步读写。
- Main 在创建窗口前同步读取 `userData/local-workbench/window-state.json`（`{x, y, width, height, maximized}`）。有效时以 `x, y, width, height` 创建并设 `useContentSize: false`，否则保持现有 1282×801 内容尺寸。`maximized` 为真时创建后 `maximize()`。
- 保存：`resize`/`move` 防抖 500 ms 与 `close` 时，取 `getNormalBounds()`，面板外扩期间扣除外扩差值，连同 `isMaximized()` 用 `writeJson` 原子写入。全屏时不更新尺寸。

## 试用反馈补充（二）R14–R16

### R14 路径核对与按名查找

- `paths.resolve(text)` 改为返回 `{ path, state }`：renderer 先用 `flowerMarkdown.workspacePath` 得到候选相对路径，再查会话级缓存 `replyPaths`（键 `[session, path]`）。`state` 为 `file`（`path` 为实际相对路径）、`choices`（多个同名）、`missing` 或 `pending`。
- `markdown.js` 按状态渲染：`file`、`choices` 输出可点击元素（`data-workspace-path`，候选另带 `data-path-choices`）；`missing` 按原文；`pending` 输出普通 `<code data-path-pending>`，不带链接样式与角色。`hydrate(root, refresh)` 收集未核对的候选，批量调用宿主，结果写入缓存后调用 `refresh()` 重新渲染该回复（与 marked 延迟加载后的重渲染同一机制），流式更新时已缓存的路径同步渲染，不闪烁。
- 该会话收到工具结果或请求进入终态时，丢弃缓存中「不存在」与「多个同名」的结论（工具可能刚写出文件），仍在核对中的条目一并移出缓存（迟到结果只写到旧条目并触发重渲染、重新核对），已确认存在的结论保留；切换会话保留缓存。
- Main 新增 `resolve-reply-paths(session, paths)`，经 `readSelectedWorkspace` 调用 `workspace.mjs` 的 `resolveMentionedPaths(workspace, paths, signal)`：最多 64 项，逐项 `locate` 为文件则原样返回；否则按「整段路径为后缀」在工作区文件清单中匹配。清单每批只取一次：Git 仓库用 `git ls-files --cached --others --exclude-standard -z`（复用 `workspace-git.mjs` 的执行器，WSL 共享目录同样经 `wsl.exe`），非仓库或 Git 不可用时有限遍历可见条目（跳过点开头与 `node_modules`，最多 20000 项、深度 12）。匹配结果再经 `locate` 复核，最多返回 20 个候选。
- 右栏 `preview(path, trigger, candidates)`：有候选时进入候选列表视图（面包屑「工作区 › 名为 X 的文件」），行显示文件名与所在目录，点击预览；预览中「返回」回到候选列表，再返回回到根目录。
- `locate` 的 `realpath` 遇 `ENOENT`/`ENOTDIR` 时抛「文件不存在或已被移动」，其余错误保持原样。

### R15 上下文圆环

- `#context-usage` 移入 `.composer-end`，位于模型按钮前：`div.context-meter` 包住 `button.context-ring#context-usage`（SVG 圆环按 `stroke-dasharray` 显示比例，旁边为百分比文字）与详情卡 `role="tooltip"`；详情卡由容器 `:hover` 或按钮 `:focus-visible` 显示，`::after` 透明桥接区覆盖圆环与卡片间的空隙，指针移入卡片仍保持打开；按钮 `aria-describedby` 指向详情卡。
- 比例 = `tokens / limit`，`data-level` 为 `normal`/`warn`（≥0.7）/`danger`（≥0.9），颜色分别用 `--accent`、琥珀色语义 token、`--danger`。无估算时圆环为空、文字隐藏，详情只显示上限。说明行只写「估算值 / 占用待估算」，窗口来源不展示，仅 `source === "fallback"` 时追加「未识别型号，上限为兜底值」。紧凑数字：`<1000` 原值，`<1e6` 为 `x.xK`，否则 `x.xM`，去掉末尾 `.0`。窄窗（≤760px）隐藏百分比文字。
- 不再使用 `role="status"`，避免每次刷新被读屏器播报。
- 当前会话的 timeline 没有任何请求时隐藏（新会话只有系统提示与工具声明的占用，显示无意义）；首个请求加入后随 `refreshContextUsage` 显示。

### R16 推理档位

- `model-library.mjs` 的能力计算增加关闭方式 `off`：`deepseek`（pi DeepSeek 目录模型，含经网关、服务声明与手动档位）、`none`（pi 标 `thinkingLevelMap.off === "none"`，或服务声明 / 手动声明含关闭的非 DeepSeek 模型）、`omit`（pi 支持关闭但没有标准字段，如 Claude）。内置推荐不再因协议过滤掉 `off`；DeepSeek 服务声明缺少关闭时补上。
- `selection()` 中未选或无效的档位落到 `available[0]`；`setModelEffort` 只接受 `available` 内的档位，`default` 只作为「未选择」的存储值保留，兼容旧文件。
- `runtimeSelection()`：所选档位为 `off` 时 `reasoning` 为空，`thinkingLevelMap.off` 按关闭方式设为 `"none"`、`null`（不发送），或删除该键并把 `compat.thinkingFormat` 设为 `deepseek`（pi 发送 `thinking.type=disabled`）。直连 DeepSeek 继续全档位用 `deepseek` 格式，经网关的其他档位维持 `openai` 格式。
- renderer：`effortOptions()` 只含 `available`；滑杆最左即默认；「恢复默认档位」回到第 0 档；`effortNames.off` 改为「关闭思考」，删除 `default`；输入框模型按钮在 `off` 时不显示档位文字，`aria-label` 仍说明。模型编辑页的「服务默认」策略（`mode: "none"`，不发送推理字段）保持不变。

### R17 回复表格换行与细滚动条

- `ui/components.css` 的 `.markdown-reply :is(th, td)` 去掉 `white-space: nowrap`，改为 `overflow-wrap: anywhere`、`vertical-align: top`、`min-width: 4.5em`（`border-box`，约三个汉字的内容宽）；`.markdown-table-scroll` 保留 `overflow: auto` 作列数过多时的兜底。
- 代码块与表格容器去掉 `scrollbar-width: thin`（它会让 `::-webkit-scrollbar` 失效），由 `markdown.js` 在 HTML 中直接输出 `soft-scroll` 类；`style.css` 用 `:where(pre, .markdown-table-scroll).soft-scroll:hover` 显示滑块。不挂 `flowerUI.softScroll` 脚本，避免流式重渲染时 `isEqualNode` 因 `data-scrolling` 属性不一致而反复替换节点。

## 测试设计

- `packages/agent-runtime`：步骤与时间写入、`describeTool` 异常与截断、无钩子时与现有事件序列一致、旧快照无新字段可读。
- Desktop Node 测试：`markdown.test.mjs` 增加路径与图片渲染、拒绝 `..`/外部绝对路径；新 `window-state.test.mjs`；`composer-history`（如抽为纯函数）与长粘贴阈值的纯函数测试；`workspace-panel.test.mjs` 风格的 Main 处理器测试覆盖 `retry-request`、`restore-request-draft`、`paste-text`、`show-path-menu` 校验与 `attention` 派生；`workbench.test.mjs` 真实 pi 回环覆盖步骤持久化与重启后历史含步骤；回环模型增加 `reasoning_content` 输出覆盖推理旁路。
- Windows 实机：沿用 `verify-*-windows.mjs` 方式补充通知、关闭确认、右键菜单、窗口恢复与长粘贴；toast 显示结果如实记录。

## 风险与回滚

- 共享运行时字段变化影响双宿主：字段全部可选，code-reviewer 回归测试必跑；出问题时可回退运行时改动，Desktop 摘要退化为仅本窗口步骤。
- 推理旁路依赖网关返回 `reasoning_content`，无推理流时功能静默不出现。
- 解压版 Windows toast 可能不显示（外部常识，未验证），兜底为任务栏闪烁。
- 跨 DPI 显示器恢复窗口可能有缩放误差（外部常识），回落逻辑保证窗口可见。
