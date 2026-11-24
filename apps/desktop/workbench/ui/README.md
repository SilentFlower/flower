# Flower Desktop 界面组件

首页参照 Cindy 的暖灰侧栏、左对齐的头像字标、双层编辑卡和纵排任务建议。侧栏仅新建会话固定在顶部，工作区、搜索、助手与会话列表共用一个滚动区。主页、会话行、回复、设置和主题预览沿用 Flower 的组件，Windows 窗口控制保留在标题栏覆盖层。


| 组件 | 职责与状态 | 调用点 |
| --- | --- | --- |
| 语义 token、按钮、头像、反馈 | 共享色彩、字体、间距、焦点、圆角。按钮支持主要、次要、轻量、禁用。首页、侧栏、回复和主题预览使用同一张 Q 版助手 WebP 头像，窗口图标使用由同一原画生成的本地 PNG。反馈用状态区域提供普通或错误信息。 | [tokens.css](tokens.css)、[foundation.js](foundation.js)、[components.css](components.css)、[模型设置与工作台](../index.html) |
| 会话行 | 根据会话 ID 保留控件，提供当前项标记、长标题省略及完整标题。列表数据更新时维持焦点。 | [agent.js](agent.js) 的 `sessionList`、[renderer.js](../renderer.js) 的 `update` |
| 任务输入 | 原生文本框配合工作区、附件、发送动作。Enter 提交，Shift+Enter 换行。组合输入期间的 Enter 交给输入法。长文件名在窄窗保留完整悬浮文本。 | [HTML 输入区](../index.html)、[agent.js](agent.js) 的 `bindComposer`、[renderer.js](../renderer.js) 的 `syncSend` |
| 消息与执行步骤 | 每个请求保留用户原话、独立附件、Flower 回复和请求状态。工具步骤按事件匹配 ID，用原生折叠控件展示进行中、完成、出错和结束。排队与运行中的任务可按 ID 取消。 | [agent.js](agent.js) 的 `thread`、`toolSteps`、[renderer.js](../renderer.js) 的 `receive` |
| 交付文件 | 显示实际文件名、类型、预览及打开操作。系统打开动作由 Host 校验请求与产物的对应关系。 | [agent.js](agent.js) 的 `deliverables`、[renderer.js](../renderer.js) 的 `thread` |
| 工作区文件面板 | 从聊天区角落浏览当前会话的授权目录。支持图片、逐页 PDF、DOCX 正文、Markdown、表格与源码，宽窗可调宽，窄窗覆盖显示，可放大阅读。宽窗打开时由 Host 向右扩展原生窗口，聊天区保持原宽度。拖动标题栏空白处或使用停靠按钮可放到聊天区左右两侧，Esc 取消拖动，位置保存在本机。 | [workspace-panel.js](workspace-panel.js)、[workspace-panel.css](workspace-panel.css)、[window-fit.mjs](../window-fit.mjs) |

新请求的原话和附件由桌面 Host 与共享核心快照一起落盘，按请求 ID 恢复。模型继续收到附带已授权相对路径的输入。早期记录没有独立附件字段，界面保留已存文字。

流式更新复用请求节点。处于底部时跟随输出，向上阅读时保留滚动位置。更新工具结果时保留折叠状态和焦点。切换会话时重新挂载该会话内容，同时恢复其输入草稿。工具步骤根据当前窗口收到的事件呈现，重启恢复历史文字、请求状态及交付文件。

新增工作台反馈优先用语义 token 和现有状态区域。出现长会话难以定位的实际需求后扩展会话搜索。Host 接入真实审批事件后，再增加可键盘操作的审批控件。交付类型扩展时在文件组件补对应标签和动作。每个新增状态应有真实调用点，并沿用窄窗、中文输入、切换会话和 Windows 回环验收。

正文与标题统一采用随应用分发的 HarmonyOS Sans SC 可变字体（[fonts/](fonts/)），缺失时回退到 Microsoft YaHei UI 与 Segoe UI。字体按华为许可原样分发，不做子集化或格式转换，外观设置预览区标注字体来源。


## 主题与表单

工作台按 flower2api 的主题种子和语义控件组织。浅色、深色和跟随系统共用六组品牌色。用户可以单独指定强调色、成功色、错误色及两处首页文案。颜色派生时按当前背景计算对比度。原生标题栏随模式切换。

- 工作台组件使用 `--surface`、`--ink`、`--accent`、`--on-accent`、`--good` 和 `--danger` 等语义色。[主题运行时](theme-preload.js)
- 设置页使用原生 `dialog.flower-settings`、`.settings-field`、`.settings-actions` 和现有按钮。主题面板演示分段选项、预设色卡、取色器、文本字段和草稿预览。[设置控件](theme-settings.js) · [共享样式](theme.css)
- 首帧从本机读取偏好。修改实时预览，保存写入本机。取消或 Esc 恢复打开时的偏好，再将焦点还给设置入口。
