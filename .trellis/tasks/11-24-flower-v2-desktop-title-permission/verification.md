# 验收记录

2026-11-24，分支 `v2`。WSL2 Linux（Node 22）与 Windows 11 实机（Node 20.19.2、Electron 45.3.2）。

## 自动化测试

- Desktop：`cd apps/desktop && npm test` 90 项通过。新增 `session-title.test.mjs`（临时标题截断与 emoji、上下文截断与分隔符、输出清洗、`generateTitle` 的错误事件/非 stop/空结果/取消）与 `session-title-flow.test.mjs`（经真实 Main、preload、worker 与回环模型：首条命名与请求无推理字段、第二条不再命名、生成期间手动改名优先、失败保留截断后的临时标题、用 AI 重命名的内容与空会话/失败报错、旧会话不命名）。
- `npx biome check apps/desktop` 只余既有 1 条警告（`desktop-harness.mjs` 未用导入）。
- 实现中发现：直接把 `{ systemPrompt, messages }` 交给 `openModelStream` 时 pi 1.6 的 OpenAI 兼容适配不发送系统提示，改为 `normalizeContext` 构造上下文。

## 浏览器夹具

权限按钮「帮我批准」、读屏「工作区权限：帮我批准」，菜单依次为只读「浏览、读取和汇总数据」、请求批准「生成文件前先询问」、帮我批准「工作区内生成文件自动批准」；会话菜单为置顶、重命名、用 AI 重命名（新增 sparkle 图标）、删除会话，点击后发出 `renameSessionWithAI` 并出现提示。

## Windows 实机

候选 `D:\FlowerDesktop-UX-tier2\candidate-6`（ASAR SHA-256 `8c18b15f956ab347dcefe65c16a69ab789c02a8a5641c54606eeb3498fb29e26`，组装方式同第二档：复用第一档已验收的 Electron 45.3.2 运行时）。私有 Win32 桌面运行，证据 `evidence-9-*`，三个脚本退出码均为 0：

- `verify-title-windows.mjs`（新增）：首条消息后侧栏与标题栏换成模型标题，标题请求无推理参数、消息在分隔符内；会话菜单「用 AI 重命名」改名并提示；模型失败时保留首条消息作为标题。
- `verify-write-permission-windows.mjs`：新增权限文案断言。该脚本此前未随第二档更新，运行中发送已改为本机排队（返回 `{ queued }`）、第一档起关窗前有原生确认框，旧脚本在这两处挂住（`candidate-4` 上用旧脚本复现）；改为以 `removeQueueItem` 移除排队消息、桩 `dialog.showMessageBox` 选择「仍然关闭」后全部通过。
- `verify-ux-tier2-windows.mjs`：第二档回归（标题变化后按状态中的标题定位会话行）。

| 验收 | 结果 |
|---|---|
| AC1 | 实机与夹具中权限菜单与按钮文案如 R1.1，已有会话档位不变（权限脚本的旧会话缺字段回退为帮我批准）。 |
| AC2 | 集成测试与实机：提交返回时即为临时标题；超过 40 字截断加「…」；旧会话发消息不改名。 |
| AC3 | 集成测试与实机：模型结果去掉引号与句号后替换；失败保留临时标题无提示；请求体无 `reasoning_effort`，消息在 `<user_message>` 内。超时（15 秒）路径由 `AbortSignal.timeout` 与失败路径共用处理，未单独等待。 |
| AC4 | 集成测试：生成期间手动改名，结果返回后仍为「我的标题」。 |
| AC5 | 集成测试与实机：用 AI 重命名改名并提示，请求含第一轮与后续轮次；空会话与模型失败报原因、标题不变。 |
| AC6 | 见上。 |
