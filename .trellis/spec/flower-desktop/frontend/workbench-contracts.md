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
