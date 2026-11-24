# 第一档验收记录

2026-11-24，分支 `v2`，基于 `2c929112`。验证环境：WSL2 Linux（Node 22）与 Windows 11 实机（Node 20.19.2、Electron 45.3.2）。

## 自动化测试

- 共享运行时：`npm test -w @flower-ai/agent-runtime` 28 项通过，新增工具步骤、宿主描述异常与截断、起止时间随事件落盘、无钩子时只记录步骤 2 项。
- Desktop：`cd apps/desktop && npm test` 60 项通过。新增：工具目标描述、推理截句与节流、经真实 worker 子进程的推理旁路（会话提交次数不因推理增加、历史不含推理）、提醒规则、右键菜单项、路径解析与渲染、长粘贴阈值、输入召回状态机、粘贴附件入库与模型证据、窗口状态校验与外扩扣除，以及 Main 处理器对重试、放回输入框、复制文本、路径菜单、粘贴文本的参数与会话校验。重启后历史返回步骤与附件名目标由 `context-continuity.test.mjs` 覆盖。
- 全仓：根构建、`npm run typecheck`、全部工作区测试（759 项）通过；code-reviewer 194 项通过。`npx biome check apps/desktop packages/agent-runtime` 无问题。整仓 `biome check .` 的报错来自本次未改动的 `.trellis` 任务 JSON、`docs/intro.html` 与 `biome.json` 版本，与本档无关。

## Windows 实机

候选：`D:\FlowerDesktop-UX-tier1\candidate`，ASAR SHA-256 `d5f3c41635474b65f1f7be8d6b0e554160c9dadc032d764c16b72a29b626734f`。脚本 `apps/desktop/testing/verify-ux-tier1-windows.mjs` 在私有 Win32 桌面运行，回环模型按脚本应答，证据位于 `D:\FlowerDesktop-UX-tier1\evidence-11`（`第一档验收.json` 与截图）。

| 验收 | 结果 |
|---|---|
| AC1 | 首包前「正在思考」，读取步骤显示目标文件，结束后折叠为「已处理 2 秒 · 读取 1 个文件」。 |
| AC2 | 运行中显示最新一句推理，正文开始后隐藏；不落盘由 Desktop 子进程测试断言。 |
| AC3 | 重启后同一请求的摘要仍在。 |
| AC4 | 后台会话侧栏 running → done，点击通知回到会话后未读清除。 |
| AC5 | 窗口在前台时没有通知；模拟后台（私有桌面无法切换真实前台，在主进程替换 `isFocused`）时任务栏闪烁，系统通知收到「已显示」回执，点击回到对应会话。解压版设置 AppUserModelId 后通知可显示。 |
| AC6 | 运行中关窗弹出「还有 1 个任务未完成」，取消后窗口与任务保留。 |
| AC7 | 取消的请求可重试（新增一轮并完成）与放回输入框；成功请求无编辑入口。 |
| AC9 | 回复中的相对路径与行内代码路径可预览，图片内联，右键「在资源管理器中显示」定位到实际文件。 |
| AC10 | 输入框右键为剪切、复制、粘贴、全选；选中文字右键为复制。 |
| AC11 | 25 行粘贴转为「粘贴的文本（25 行）.txt」，模型请求包含其正文。 |
| AC12 | 空输入框 ↑ 召回上一条，Esc 恢复空草稿。 |
| AC13 | 1250×760 外框在打开侧栏外扩后关闭，重启恢复为 1250×760（不含外扩）；最大化后重启仍最大化。 |

## 未在 Windows 实机覆盖的部分

- AC8 阅读位置与回到底部按钮在浏览器夹具中验证（切回原位置 1500、贴底会话保持贴底、新内容提示点、点击回底后隐藏）。
- AC12 输入法组合中不触发召回、AC13 显示器断开后回落、AC11 超过 1 MiB 提示由单元测试覆盖。
- AC14 的窄窗 660 像素与深色在浏览器夹具中查看了步骤摘要；减弱动效只做了 CSS 审查。

## 试用反馈补充（R10–R13）

候选：`D:\FlowerDesktop-UX-tier1\candidate-2`，ASAR SHA-256 `98c0da8e78c48e1821d7e59fd587dfb956c280537d886d89bc066b1e51e3da84`，证据 `D:\FlowerDesktop-UX-tier1\evidence-12`。同一脚本新增一段，前面各项复验通过。

| 验收 | 结果 |
|---|---|
| AC15 | 工作区模式下「全部折叠」后会话行全部收起、按钮变为「全部展开」；「定位当前会话」展开所在分组并聚焦当前会话行，按钮回到「全部折叠」。浏览器夹具中验证：搜索把当前会话过滤掉后，定位会清除搜索并聚焦当前会话；会话模式只显示定位；首页时定位停用。 |
| AC16 | 侧栏、主会话区、右栏均为 `soft-scroll` 且计算后的 `scrollbar-width` 为 `auto`（自定义滑块生效）。滑块显隐在实机截图中因会话较短未出现滚动，需在长会话中目测。 |
| AC17 | 右栏图标颜色按类型区分（png、txt、xlsx 计算颜色互不相同）；Git 标签、删除线、差异行号栏与色条在浏览器夹具浅色与深色截图中检查。 |

Desktop `npm test` 60 项、`npx biome check apps/desktop` 通过。

## 试用反馈补充（二）（R14–R16）

2026-11-24，WSL2 Linux（Node 22）与 Windows 11（Node 20.19.2）。候选 `D:\FlowerDesktop-UX-tier1\candidate-5`，ASAR SHA-256 `38d8ba9533b4310abc6f42dd43b64cf547e16f573c1255271767d36596059868`。Windows Node 直接调用源码 `resolveMentionedPaths` 只读核对 WSL 共享工作区 `\\wsl.localhost\ubuntu\root\project\flower`：经 `wsl.exe` 的 Git 清单为 `verification.md` 返回 8 个候选（1.6 秒），`README.Windows.txt` 唯一匹配到 `apps/desktop/`，`VERIFICATION.md` 按 Linux 大小写判定不存在，遍历回退 1.5 秒，预览缺失文件报「文件不存在或已被移动」。私有桌面实机：`verify-model-presets-windows.mjs`（evidence-16）通过，捕获 15 次 Chat Completions 请求；`verify-model-suite-windows.mjs`（evidence-19）通过，请求体中关闭思考为 `thinking.type=disabled`、其他档位为 `reasoning_effort`。修复前两个脚本断言旧推荐档位而失败（evidence-13、14）；模型套件另有一处「提交后草稿附件仍在」的旧断言，用改动前脚本对 candidate-2 跑基线（evidence-18）同样失败，属既有漂移，已改为核对前重新附上 notes.txt。

| 验收 | 结果 |
|---|---|
| AC18 | `workspace-panel.test.mjs` 新增用例：根下文件原样返回；非 Git 目录遍历可见条目，唯一同名返回实际路径、两个同名返回候选，隐藏目录与 `node_modules` 不参与；Git 仓库取已跟踪与未忽略文件（含隐藏目录、排除忽略文件），Git 失败时退回遍历；超过 64 项与已取消的请求被拒绝；预览不存在的文件报「文件不存在或已被移动」。处理器测试覆盖非当前会话拒绝与越界路径。`markdown.test.mjs` 覆盖待核对、存在、同名候选、缺失四种渲染。浏览器夹具（真实 `workbench/` 页面加替身 preload）：一次批量核对 6 个路径；`verification.md` 点击后右栏列出 3 个候选，面包屑「名为 verification.md 的文件」，选中后预览、返回回到候选、再返回到根目录；`brief.md` 直接预览实际位置；核对进行中收到工具结果时，迟到的「不存在」结论不留缓存，重渲染后重新核对并链接到新文件；`missing.md` 与缺失链接显示为普通文字。 |
| AC19 | 浏览器夹具（试用后补充：指针从圆环移入详情卡、在卡内移动保持打开，移出后关闭）：87,500 / 1,000,000 显示圆环与「9%」，详情「87.5K / 1M · 8.8%」「估算值」，悬停可见（试用后去掉窗口来源，仅兜底窗口提示上限为兜底值）；750K 为琥珀色、950K 为红色（深色）；新会话（空白页）不显示；660 像素窄窗只显示圆环，详情卡不越出视口，无横向滚动。 |
| AC20 | `model-library.test.mjs` 经锁定 pi 与回环网关核对请求体：DeepSeek 直连与经网关的未选档位和「关闭思考」均为 `thinking.type=disabled`，其他档位不变；gpt-5.2 未选档位为 `reasoning_effort=none`；claude-sonnet-5 关闭思考不带推理字段；claude-sonnet-5-5 默认 `reasoning_effort=low`；`default` 不再是可保存档位；换凭据后回到最左档；未识别模型不发送推理字段。浏览器夹具：滑杆最左为「关闭思考」、输入框不显示档位文字，右移一档显示「低」，「恢复默认档位」回到关闭思考；不可关闭的模型默认「低」。 |
| AC21 | 浏览器夹具（真实 `workbench/` 页面）：两列宽表在 1282 与 660 像素均无横向溢出，长句与行内代码换行；十二列表在 1282 像素完整显示，660 像素保持约三字列宽并横向滚动；表格与代码块带 `soft-scroll`、计算后的 `scrollbar-width` 为 `auto`，代码块保持 `white-space: pre`；页面无横向溢出。Windows 私有桌面 `verify-markdown-windows.mjs`（candidate-6，ASAR SHA-256 `7df4acccc51300020659836d0d797eaaaf8e1b2d248d3cc9f63c569594db8e85`，evidence-21）通过：660 像素深色下代码块 438/5478 横向滚动，表格 438/438 不溢出，两者均为 `soft-scroll`、`scrollbar-width: auto`。脚本同步了表格断言，并修正第一档起 `thread` 需要「回到底部」按钮的旧调用（既有漂移）。 |

Desktop `npm test` 62 项、`npx biome check apps/desktop` 通过。
