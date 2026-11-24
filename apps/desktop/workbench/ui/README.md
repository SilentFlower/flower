# Flower Desktop 界面组件

首页参照 Cindy 的暖灰侧栏、左对齐的头像字标、双层编辑卡和纵排任务建议。侧栏仅新建会话固定在顶部，工作区、搜索、助手与会话列表共用一个滚动区。主页、会话行、回复、设置和主题预览沿用 Flower 的组件，Windows 窗口控制保留在标题栏覆盖层。


| 组件 | 职责与状态 | 调用点 |
| --- | --- | --- |
| 语义 token、按钮、头像、反馈 | 共享色彩、字体、间距、焦点、圆角。按钮支持主要、次要、轻量、禁用。首页、侧栏、回复和主题预览使用同一张 Q 版助手 WebP 头像，窗口图标使用由同一原画生成的本地 PNG。反馈用状态区域提供普通或错误信息。 | [tokens.css](tokens.css)、[foundation.js](foundation.js)、[components.css](components.css)、[模型设置与工作台](../index.html) |
| 会话行 | 根据会话 ID 保留控件，提供当前项标记、长标题省略及完整标题。列表数据更新时维持焦点。状态点区分运行中、完成未读、失败未读，待批准沿用文字徽标；工作区分组折叠时显示组内最高优先级。未读只保存在本次运行期间。工作区模式的标题行提供「全部折叠 / 全部展开」，两种模式都有「定位当前会话」。 | [agent.js](agent.js) 的 `sessionList`、[attention.mjs](../attention.mjs)、[renderer.js](../renderer.js) 的 `update` |
| 任务输入 | 原生文本框配合工作区、附件、发送动作。Enter 提交，Shift+Enter 换行。组合输入期间的 Enter 与方向键交给输入法。空输入框按 ↑/↓ 召回本会话已发输入，Esc 或越过最新一条恢复草稿。超过 2000 字、20 行或会超出 16000 字上限的粘贴保存为「粘贴的文本（N 行）.txt」附件。长文件名在窄窗保留完整悬浮文本。 | [HTML 输入区](../index.html)、[agent.js](agent.js) 的 `bindComposer`、[attachments.js](attachments.js) 的 `longPaste`、[renderer.js](../renderer.js) 的 `syncSend` |
| 消息与执行步骤 | 每个请求保留用户原话、独立附件、Flower 回复和请求状态。首包前显示「正在思考」，网关返回推理时状态下方显示最新一句（不落盘）。工具步骤按动作与目标展示，运行中展开，结束后折叠为耗时与动作计数；步骤与起止时间由共享核心随会话保存。未完成的请求可重试或放回输入框编辑，提问与回复均可复制。排队与运行中的任务可按 ID 取消。 | [agent.js](agent.js) 的 `thread`、`toolSteps`、[tool-display.mjs](../tool-display.mjs)、[reasoning-preview.mjs](../reasoning-preview.mjs)、[renderer.js](../renderer.js) 的 `receive` |
| 回复中的路径 | 当前工作区内的相对路径、常见扩展名的行内代码路径和工作区内绝对路径可点击预览，右键在资源管理器中显示或复制路径；工作区内图片内联显示并可放大。面板中的 Markdown 预览不解析路径。 | [markdown.js](markdown.js) 的 `workspacePath`、[renderer.js](../renderer.js) 的 `hydrateReplyImages`、[context-menu.mjs](../context-menu.mjs) |
| 交付文件 | 显示实际文件名、类型、预览及打开操作。右键提供预览、在资源管理器中显示与复制路径。系统打开动作由 Host 校验请求与产物的对应关系。 | [agent.js](agent.js) 的 `deliverables`、[renderer.js](../renderer.js) 的 `thread` |
| 工作区文件面板 | 从聊天区角落浏览当前会话的授权目录。支持图片、逐页 PDF、DOCX 正文、Markdown、表格与源码，宽窗可调宽，窄窗覆盖显示，可放大阅读。宽窗打开时由 Host 向右扩展原生窗口，聊天区保持原宽度。拖动标题栏空白处或使用停靠按钮可放到聊天区左右两侧，Esc 取消拖动，位置保存在本机。文件行右键在资源管理器中显示或复制路径。图标按类型着色（目录、表格、PDF、Word、图片、代码），Git 状态为彩色标签、删除文件划线，差异视图有行号栏底色与增删色条。 | [workspace-panel.js](workspace-panel.js)、[workspace-panel.css](workspace-panel.css)、[window-fit.mjs](../window-fit.mjs) |
| 提醒与窗口 | 窗口不在前台时，完成、失败与待批准发送系统通知并闪烁任务栏，点击回到对应会话；有未完成任务时关窗先确认。窗口位置、尺寸与最大化状态单独保存，扣除侧栏外扩宽度，显示器变化后回落到可见区域。输入框、选中文字与图片提供原生右键菜单。 | [main.mjs](../main.mjs)、[window-state.mjs](../window-state.mjs)、[context-menu.mjs](../context-menu.mjs) |

新请求的原话和附件由桌面 Host 与共享核心快照一起落盘，按请求 ID 恢复。模型继续收到附带已授权相对路径的输入。早期记录没有独立附件字段，界面保留已存文字。

侧栏、主会话区与右栏使用 `flowerUI.softScroll` 的自动隐藏细滚动条（[foundation.js](foundation.js)）。这些容器不能再设置 `scrollbar-width`，否则 `::-webkit-scrollbar` 样式失效、回到原生滚动条。

流式更新复用请求节点。处于底部时跟随输出，向上阅读时保留滚动位置，离开底部时输入区上方出现「回到底部」，期间有新内容时带提示点。更新工具结果时保留折叠状态和焦点。切换会话时重新挂载该会话内容，恢复其输入草稿和上次的阅读位置。重启恢复历史文字、请求状态、工具步骤与交付文件。

新增工作台反馈优先用语义 token 和现有状态区域。出现长会话难以定位的实际需求后扩展会话搜索。Host 接入真实审批事件后，再增加可键盘操作的审批控件。交付类型扩展时在文件组件补对应标签和动作。每个新增状态应有真实调用点，并沿用窄窗、中文输入、切换会话和 Windows 回环验收。

正文与标题统一采用随应用分发的 HarmonyOS Sans SC 可变字体（[fonts/](fonts/)），缺失时回退到 Microsoft YaHei UI 与 Segoe UI。字体按华为许可原样分发，不做子集化或格式转换，外观设置预览区标注字体来源。


## 主题与表单

工作台按 flower2api 的主题种子和语义控件组织。浅色、深色和跟随系统共用六组品牌色。用户可以单独指定强调色、成功色、错误色及两处首页文案。颜色派生时按当前背景计算对比度。原生标题栏随模式切换。

- 工作台组件使用 `--surface`、`--ink`、`--accent`、`--on-accent`、`--good` 和 `--danger` 等语义色。[主题运行时](theme-preload.js)
- 设置页使用原生 `dialog.flower-settings`、`.settings-field`、`.settings-actions` 和现有按钮。主题面板演示分段选项、预设色卡、取色器、文本字段和草稿预览。[设置控件](theme-settings.js) · [共享样式](theme.css)
- 首帧从本机读取偏好。修改实时预览，保存写入本机。取消或 Esc 恢复打开时的偏好，再将焦点还给设置入口。
