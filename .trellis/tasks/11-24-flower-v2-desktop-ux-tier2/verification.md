# 第二档验收记录

2026-11-24，分支 `v2`。验证环境：WSL2 Linux（Node 22）与 Windows 11 实机（Node 20.19.2、Electron 45.3.2）。

## 自动化测试

- 共享运行时：`npm test -w @flower-ai/agent-runtime` 35 项通过。新增「运行中插话」3 项（送达位置与附件、送达前取消不记录、`createExecution` 拒绝）、「手动压缩」3 项（全量归纳与续接、失败与取消保留检查点、运行中与不支持的宿主拒绝），`dual-host.test.ts` 新增企业宿主插话 1 项。
- Desktop：`cd apps/desktop && npm test` 83 项通过。新增单元测试：`toast`、`session-queue`（直接提交与入队、派发、暂停恢复、发送失败、行内编辑、重排、上限、插话送达与回队首、编辑暂缓）、`session-search`（片段、大小写、中断判定）、引用插入与 @ 查询、回复菜单、补全排序、交付物元信息。新增经真实 Main、preload、worker 与回环模型的集成测试：`queue-side-chat.test.mjs`（排队、插话、暂停继续、编辑暂缓、侧边追问分叉与只读、运行中打开与队列转入、手动压缩与分隔、正文搜索、中断横幅与全部继续、删除撤销与退出即删除）与 `instructions.test.mjs`（全局指令与 FLOWER.md 的拼接、截断、清空、侧边追问、重启下发）。
- 全仓：根构建与 `npm run typecheck` 退出码 0；code-reviewer 194 项通过；`npx biome check apps/desktop packages/agent-runtime` 只有改动前已存在的 1 条警告。

## 浏览器夹具

静态托管 `workbench/index.html` 并注入 `window.flower` 替身，Playwright 无沙箱 Chromium：队列条与插话气泡、选区工具条与引用、@ 补全的键盘截获（↑ 不召回、Esc 后 Enter 照常发送）、队列行 Alt+↑/↓ 与「更多」菜单、编辑暂缓（连续点击只请求一次）、回复右键的路由（交付卡片与其他回复不弹引用菜单）、Toast 上限与去重、侧边追问页、压缩按钮停用与分隔、搜索片段与同会话及跨会话跳转高亮、中断横幅、交付卡片元信息、全局指令对话框与详情卡提示；1282 宽浅色与 660 宽深色无横向溢出。夹具中发现并修正了启动时 `revealPending` 的空值崩溃。

## Windows 实机

本机没有官方 Electron 45.3.2 Windows zip，未运行 `package:windows`。候选包按打包脚本的同一步骤组装（`npm ci --os=win32`、组装 `workbench` 与 `agent-runtime`、`@electron/asar@4.3.2` 打包），Electron 运行时复制自第一档已验收的 `D:\FlowerDesktop-UX-tier1\candidate-8`（版本文件核对为 45.3.2）。

- 最终候选：`D:\FlowerDesktop-UX-tier2\candidate-2`，ASAR SHA-256 `6b6ebc43f36e937330a12a23dd5104c34ddde7acf2d47920cf4d40eb4baf8cf7`。
- 脚本 `apps/desktop/testing/verify-ux-tier2-windows.mjs` 在私有 Win32 桌面运行，证据 `D:\FlowerDesktop-UX-tier2\evidence-2`（`第二档验收.json` 与截图），退出码 0。第一档回归 `verify-ux-tier1-windows.mjs` 证据 `D:\FlowerDesktop-UX-tier2\evidence-2-tier1`。
- 此前的 `candidate-1`（ASAR `37a08e97…`，缺全局指令对话框的样式修正）上两个脚本均通过（evidence-1、evidence-1-tier1）。

| 验收 | 结果 |
|---|---|
| AC1 | 回复选区右键只弹出「复制、引用、侧边追问」一个菜单，渲染层 `preventDefault` 拦下了原生默认菜单；选择「引用」后输入框出现引用块。输入框右键仍为剪切、复制、粘贴、全选（第一档回归）。 |
| AC2 | 从回复选区打开右栏侧边追问，引用带入侧边输入框，得到回答，系统提示为只读侧边追问；撤销删除后侧边追问恢复。 |
| AC3 | 运行中发送的两条消息排在输入框上方，时间线只有一轮；当前任务结束后自动发送队首。 |
| AC4 | 插话送达后以气泡显示在该轮回复中。 |
| AC5 | 详情卡「压缩上下文」完成后出现 Toast 与时间线分隔。 |
| AC6 | 正文命中显示片段，点击后切回会话并高亮关键词；侧边追问内容不被搜到。 |
| AC7 | 工作区文件面板的文件行拖入输入框成为附件；输入 @ 补全后回车加入附件并删除 @ 文字。 |
| AC8 | 运行中关闭后重启，侧栏顶部列出被中断的会话，会话内按钮为「继续任务」，可忽略横幅。 |
| AC11 | 删除会话不弹确认框，Toast「撤销」恢复会话与侧边追问。 |
| AC12 | 保存全局指令后，下一轮系统提示依次包含个人指令与 FLOWER.md。 |
| AC13 | 680 宽窄窗、深色模式无横向溢出；第一档主流程回归通过。 |

## 未在 Windows 实机覆盖的部分

- 中文输入法组合中的 @ 补全与队列编辑：由按键处理逻辑与夹具覆盖（`isComposing`、`keyCode 229`、`compositionstart` 关闭列表）。
- 待批准期间发送入队：Main 将待批准视为会话忙碌（活动请求仍在），由队列单元测试的忙碌分支覆盖，未单独跑写入审批场景。
- 交付卡片元信息：真实 `汇总.xlsx` 的解析由单元测试覆盖，Windows 上未生成交付物。
- Toast 悬停暂停与减弱动效：只做了逻辑与 CSS 审查。
- 读屏播报（Toast 礼貌播报、错误 `alert`）：只核对了属性，未用讲述人实听。
