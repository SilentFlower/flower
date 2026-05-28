# Research: pi vs peers — 5 个同类工具对比

- **Query**: cursor / cline / aider / claude-code / openai-agents-sdk vs pi(`@earendil-works/pi-coding-agent` v0.75.3),5 个维度对比 + 框架/SDK 区别 + pi 定位 + flower 选 pi 的 trade-off
- **Scope**: 外部调研为主(每工具至少 1 个权威 URL),pi 部分以本仓库 `node_modules/@earendil-works/pi-coding-agent/README.md` + `CHANGELOG.md` + `package.json` 为准
- **Date**: 2026-05-22
- **取数日期声明**: 本研究中所有"同类工具"的形态信息以**截至 2026-01-26**(Claude 训练知识 cutoff)之前的官方公开文档为准。各工具迭代频繁,具体 API 与开关可能已演进,reader 视角以各官方文档 HEAD 为准。本文档为 flower commit `2a98cb3`(2026-05-22)的状态快照。
- **R-4 守则声明**:**全文不评判任何同类工具的好坏**,只客观陈述「形态差异」与「flower 自己的 trade-off」。不出现「不够 / 落后 / 弱 / 不好」之类的措辞。

---

## 0. TL;DR(给 reader 一个 60 秒结论)

`pi-coding-agent` 是一个 **CLI 形态 + TypeScript extension 机制 + 同时暴露 SDK / RPC 接口**的本地 coding agent harness。它在「**框架/抽象高度**」轴上靠近 **claude-code**(同为 CLI / 同有 extension surface),在「**让你自己组装 agent runtime**」轴上靠近 **openai-agents-sdk**(都暴露 `createAgentSession()` 这类底层入口)。flower 选 pi 的核心 trade-off 是:**(1)在公司 CI 跑、不依赖任何 IDE GUI;(2)能在 TypeScript extension 里就地拼装 5 个 GitLab tool + compliance 拦截 + observability 旁路;(3)同时能在交互 / `--print` 一次性出报告 / SDK / RPC 四种 mode 之间切换,反过来 wrap 进我们自己的 `flower-code-reviewer` CLI**。不同工具有不同的 trade-off,各自适配的场景不同。

---

## 1. 5 × 5 对比矩阵

| 工具 | 形态(Form Factor) | extension / plugin 机制 | tool 集成方式 | 目标场景 | 部署形态 |
|---|---|---|---|---|---|
| **pi**(`@earendil-works/pi-coding-agent` v0.75.3) | **CLI**(`pi`)+ **SDK**(`createAgentSession`)+ **RPC**(`--mode rpc`,LF-delimited JSONL stdin/stdout)+ **JSON 事件流**(`--mode json`) | **TypeScript Extension**:`export default function (pi: ExtensionAPI) { pi.registerTool(...); pi.registerCommand(...); pi.on("tool_call", ...); }`;通过 `~/.pi/agent/extensions/`、`.pi/extensions/`、或 npm/git 的 "pi package" 分发 | 内置 4-7 个工具(`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`);自定义 tool 通过 `pi.registerTool()` 注册;**明确不内置 MCP**,但可由 extension 添加 MCP 支持 | 本地 / CI 上的通用 coding agent;extension 决定能干什么(评审 / 部署 / 评论 / sub-agent / 任意定制) | **本地 CLI**;也可嵌入到自己应用作为 SDK;Bun 编译有 standalone binary;无 IDE GUI |
| **cursor** | **IDE**(基于 VS Code fork 的桌面应用) | **VS Code Extension API** 兼容(继承自 VS Code Marketplace);Cursor 自己加 Composer / Agent / Chat 等 UI 入口;Rules(`.cursorrules` / `.cursor/rules/*.mdc`)用来注入项目指令 | 内置 codebase indexing / Composer 多文件编辑 / Agent 模式;**支持 MCP servers**(在 Cursor settings 配置);也可调用 VS Code 插件提供的能力 | IDE 内沉浸式 AI pair programming(写新功能 / 重构 / 多文件编辑) | **桌面 GUI 应用**;cloud-assisted(部分 indexing 在 Cursor 后端) |
| **cline**(VS Code 插件,前身 Claude Dev) | **VS Code Extension**(在 VS Code / VS Code 衍生编辑器中运行) | 本身就是一个 VS Code Extension;用户通过 cline 的 UI 进行交互;另有 `.clinerules` / Workflow 等定制点 | 内置文件读写 / 终端 / 浏览器使用 / **MCP server 集成**(cline 是较早全面拥抱 MCP 的 IDE 内代理) | 在 IDE 内边对话边改文件的 agent 体验,带 plan/act 切换 | VS Code 内运行,模型走用户配置的 API key |
| **aider** | **CLI**(`aider` 终端命令)| 配置文件 / `--read` / `.aider.conf.yml`;有限的"自定义"主要通过 system prompt / 模型选择 / 模式开关 | 内置「读 / 改文件 + 自动 git commit」;**git-aware**(每次编辑自动产生一个 commit);通过 `/run` / `/test` 等命令调用 shell | git 仓库内、终端里以"对话 + diff + commit"循环驱动开发 | 本地 CLI;模型走 API key |
| **claude-code**(Anthropic 官方 CLI;本任务正在被它驱动) | **CLI**(`claude`)+ 同时可以挂到 IDE(VS Code / JetBrains 等通过 IDE extension 桥接)+ **TypeScript SDK**(`@anthropic-ai/claude-code-sdk` / Headless mode) | **Hooks**(`PreToolUse` / `PostToolUse` / `Stop` / `Notification` 等,settings.json 配置);**Subagents**(Markdown 文件配置 + Task tool 调用);**Skills**(`SKILL.md` 标准);**Slash Commands**(`.claude/commands/*.md`);**MCP servers**(stdio / SSE) | 内置 `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` / `Task` / `WebFetch` 等;通过 **MCP servers** 接入外部工具(GitHub / Sentry / 自定义);可写自定义 Skill / Subagent | 本地或 CI 上做软件工程任务,可被嵌入到自动化 pipeline;有 GitHub Actions / Background Tasks(`/loop`)等编排能力 | 本地 CLI + IDE 集成;hosted on user machine,模型走 Anthropic API / Claude subscriptions |
| **openai-agents-sdk**(`openai-agents` Python / `@openai/agents` JS) | **SDK**(Python / TypeScript 库)— **没有 CLI**,你写 Python / TS 代码自己启动 agent | 库的 API:`Agent` / `Runner` / `function_tool` / `handoff` / `guardrail` / `tracing`;由你自己组装,放进你自己的应用进程 | **function calling 原生**;`@function_tool` 装饰器把任意 Python / TS 函数变成 tool;hosted tools(WebSearch / FileSearch / CodeInterpreter)由 OpenAI 平台提供;**支持 MCP servers**(`MCPServerStdio` / `MCPServerSse` / `MCPServerStreamableHttp`) | 给开发者搭多 agent 工作流(handoff / guardrail / streaming / 平台 hosted tools 调用)的低层库 | **嵌入到你自己的 Python / Node.js 应用**;不绑定 IDE / CLI / 部署形态;agents 的"驻留位置"完全由你决定(脚本 / FastAPI / Lambda / browser via Realtime) |

**说明**:以上仅描述「形态差异」。同一行的不同工具针对不同场景做了不同的 trade-off,无优劣之分。

### Sources(每工具至少 1 个权威 URL)

- **pi** — `node_modules/@earendil-works/pi-coding-agent/README.md`(本仓库 v0.75.3);上游:<https://github.com/earendil-works/pi-mono>;作者博文:<https://mariozechner.at/posts/2025-11-30-pi-coding-agent/>
- **cursor** — 官方 docs:<https://docs.cursor.com/>;features 概览:<https://www.cursor.com/features>;MCP 支持:<https://docs.cursor.com/context/model-context-protocol>
- **cline** — GitHub README:<https://github.com/cline/cline>;官方 docs:<https://docs.cline.bot/>
- **aider** — 官方 docs:<https://aider.chat/>;GitHub:<https://github.com/Aider-AI/aider>
- **claude-code** — 官方 docs:<https://docs.claude.com/en/docs/claude-code/overview>;Hooks 文档:<https://docs.claude.com/en/docs/claude-code/hooks>;SDK:<https://docs.claude.com/en/docs/claude-code/sdk>
- **openai-agents-sdk** — Python docs:<https://openai.github.io/openai-agents-python/>;JS docs:<https://openai.github.io/openai-agents-js/>;GitHub:<https://github.com/openai/openai-agents-python>;MCP guide:<https://openai.github.io/openai-agents-python/mcp/>

---

## 2. Agent 框架(framework)vs Agent SDK 的区别

### 2.1 概念分野

- **Agent 框架(framework)**:把 agent 的「主循环」「session 管理」「对话上下文」「工具调度」「事件系统」「UI 渲染」一起打包好,**用户在框架内填空**(extension / hook / prompt / 工具)。typical 代表:`claude-code`、`pi-coding-agent`、`cursor`(IDE 形态的框架)。
- **Agent SDK**:暴露**原始 API**(`Agent` / `Runner` / `Tool` / `Handoff` 等),用户自己 **wire 起来**,自己决定 runtime 跑在哪、UI 长什么样、事件怎么处理。typical 代表:`openai-agents-sdk`(Python / JS)、LangChain / LangGraph(类似定位)、`@anthropic-ai/sdk` 底层 API。

| 维度 | Agent 框架 | Agent SDK |
|---|---|---|
| 抽象高度 | 高 — 框架带 main loop + UI + session | 低 — 给 building blocks,你自己拼 |
| 即开即用 | 装上就能跑(`claude` / `pi` / `aider`) | 要写代码组装(`new Agent(...)` + `Runner.run(...)`) |
| 定制粒度 | 在 hook / extension 点定制 | 任意定制,边界由你画 |
| 学习曲线 | 学习:有哪些 hook 点 + 配置项 | 学习:agent loop 怎么写 + 工具/事件/handoff 怎么管 |
| 适合场景 | 通用日常 coding 工作流 | 嵌入到自己产品 / 多 agent 复杂编排 |

### 2.2 pi 偏哪种?

pi **同时支持两种使用方式**,这是它的形态特点:

1. **当框架用**(主流用法):装好 `pi` 命令,在 `~/.pi/agent/extensions/` / `.pi/extensions/` 放 TypeScript 文件就能扩展;`pi` 本身有完整的 interactive TUI、`/login`、session 管理、`/tree` 分支、`/compact` 压缩、模型切换等。
2. **当 SDK 用**:`import { createAgentSession, AuthStorage, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent"` 后,可以在你自己应用进程里启动一个 agent session,跳过整个 TUI 层。README 直接给了 SDK 用法:

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

3. **当 RPC server 用**:`pi --mode rpc` 后,通过 LF-delimited JSONL 在 stdin/stdout 与外部进程通信(给非 Node.js 调用方用)。
4. **当事件流当 print 用**:`pi --mode json` 或 `pi -p "..."` 单次出结果,适合 CI / 脚本编排。

**结论**:pi 在「框架 ↔ SDK」轴上做了**双端铺路**的 trade-off — 既给你 ready-to-run 的 `pi` 命令(框架),又给你 `createAgentSession` 的底层入口(SDK),让你按需取用。

- **source**: <https://github.com/earendil-works/pi-mono#programmatic-usage>(SDK 章节);README.md §「Programmatic Usage」(本仓库 node_modules)

### 2.3 其它工具在这条轴上的位置

| 工具 | 框架/SDK 倾向 |
|---|---|
| pi | 框架 + SDK 双端(CLI 用框架体验,`createAgentSession` 是 SDK 体验) |
| cursor | 框架(IDE 形态的框架;不暴露 agent runtime 的 SDK 给第三方应用嵌入) |
| cline | 框架(VS Code 插件形态;不作为通用库被第三方应用 import) |
| aider | 框架(CLI 形态;主要是命令行体验,SDK 入口不是核心宣传重点) |
| claude-code | 框架 + SDK 双端(CLI / IDE 是框架,`@anthropic-ai/claude-code-sdk` / Headless mode 提供 SDK 调用) |
| openai-agents-sdk | SDK(纯库,没有官方 CLI;由你自己写 Python / TS 代码组装 agent) |

这条轴体现了不同工具的设计目标差异,与"哪个更好"无关。

---

## 3. pi 的定位分析

### 3.1 piMain + Extension surface 的设计动机

pi 自己的 README §「Philosophy」 把设计原则说得很清楚:

> Pi is aggressively extensible so it doesn't have to dictate your workflow.

具体表现:

- **核心刻意 minimal**:只内置 `read` / `write` / `edit` / `bash` 等基础工具,以及若干 navigation 工具(`grep` / `find` / `ls`)。
- **明确「不包」一些功能**,而是把它们交给 extension:
  - **No MCP**(可以自己用 extension 加;作者博文专门解释了原因:<https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/>)
  - **No sub-agents**(可以自己用 extension 实现,或者通过 tmux 跑多个 pi 实例)
  - **No permission popups**(在容器里跑,或自己 extension 实现确认 UI)
  - **No plan mode**(写 plan 到文件,或自己 extension 实现)
  - **No built-in to-dos**(用 TODO.md,或自己 extension 实现)
  - **No background bash**(用 tmux)

这是一种「**核心薄、extension 厚**」的 trade-off:reader 在 README §「What's possible」看到的 extension 能做的事是开放式列表:

> Custom tools (or replace built-in tools entirely) · Sub-agents and plan mode · Custom compaction and summarization · Permission gates and path protection · Custom editors and UI components · Status lines, headers, footers · Git checkpointing and auto-commit · SSH and sandbox execution · MCP server integration · Make pi look like Claude Code · Games while waiting (yes, Doom runs)

「Make pi look like Claude Code」是一个有趣的存在感声明 — pi 不把"特定 UX"当成核心契约,你可以把它打扮成任何样子。

**结论**:pi 的设计动机是「**让 harness 不规定工作流,工作流由用户/团队/extension 来塑造**」。这是一种"轻底盘 + 重 extension"的 trade-off。

- **source**: <https://github.com/earendil-works/pi-mono#philosophy>;作者博文:<https://mariozechner.at/posts/2025-11-30-pi-coding-agent/>

### 3.2 与 cursor / claude-code 的对比(高度集成形态)

- **cursor 的 trade-off**:**IDE 沉浸**。reader 进入 cursor,就是进入一个能写代码 + 跑 agent + 看 diff 的桌面应用,所有交互在 IDE 内完成。这个 trade-off 给 reader 的是「**一站式工作台**」的体验。
- **claude-code 的 trade-off**:**完整工程师 toolchain**。CLI 优先,但同时有 IDE 集成、Headless SDK、Hooks(`PreToolUse` / `PostToolUse` 等)、Subagents、Skills、MCP servers、Slash Commands 等齐套 surface。这个 trade-off 给 reader 的是「**所有定制点都内置,在内置 surface 上配置 / 写文件就够了**」。
- **pi 的 trade-off**:**核心薄、extension 厚**。同样 CLI 优先,但定制方式更倾向于「**写一个 TypeScript 函数 + 调几个 `pi.registerTool` / `pi.on`**」,而不是配 JSON / Markdown。给 reader 的是「**用代码塑造你的 agent**」的体验。

三者的形态差异:都是「coding agent 框架」,但 cursor 偏 IDE / claude-code 偏内置丰富 surface / pi 偏 TypeScript extension。不同 trade-off。

### 3.3 与 openai-agents-sdk 的对比(低层 SDK 形态)

- **openai-agents-sdk 的 trade-off**:**最低抽象 + 最大组装自由**。SDK 给你 `Agent` / `Runner` / `Tool` / `Handoff` / `Guardrail` / `Tracing` 等原语,你自己把它们 wire 成你想要的 agent 系统(单 agent / 多 agent handoff / Realtime voice agent / 浏览器 agent / 后端服务里的 sub-agent 等)。SDK 不负责 UI / CLI / session 管理 / 文件系统集成,这些由调用方实现。
- **pi 的 trade-off**:**SDK + 框架 两端铺路**。`createAgentSession` 接近 openai-agents-sdk 的"组装入口",但 pi 同时把上层框架(TUI / session / `/login`)也实现好了;你可以只用 SDK,也可以用框架。对 flower 这种「想要 CLI 同时能在 CI 拿到 print mode 输出」的用户来说,pi 这种**双端铺路**正好覆盖。

| 维度 | openai-agents-sdk | pi |
|---|---|---|
| 默认 runtime | 无(由你提供) | 提供 CLI runtime,可选 SDK |
| 安装即可用 | 否(要写代码) | 是(`pi` 命令开箱即用) |
| session 管理 | 由你自己存 | 内置(`~/.pi/agent/sessions/` JSONL,带 `/tree` 分支) |
| 多 agent handoff | 一等公民(`handoff` 原语) | 不内置,extension 实现 |
| Hosted tools | 提供(WebSearch / FileSearch / CodeInterpreter 等 OpenAI 平台 hosted) | 不提供;由 extension / built-in tool 自行实现 |
| MCP | 内置支持(`MCPServerStdio` 等) | 不内置;extension 可加 |
| 上层 UI / interactive | 由你写 | 内置 TUI(`react`-style 渲染,无 JS-framework 依赖) |

不同 trade-off,reader 按需选择。

- **source**: <https://openai.github.io/openai-agents-python/>;<https://github.com/openai/openai-agents-python>;<https://openai.github.io/openai-agents-python/mcp/>

---

## 4. flower 选 pi 的实际 trade-off

### 4.1 flower 想要什么

flower 是公司内部的代码评审 / 工具网关 monorepo,场景明确:

- **跑在 GitLab CI 上**(没有 IDE GUI、没有交互终端、最好 ≤2 分钟内输出报告)
- **不依赖任何 IDE**(reviewer 是 headless 跑;ops-bot 是 dingtalk 常驻 service)
- **中文友好**(评论模板 / system prompt 都是中文)
- **可深度定制**:
  - 注册 5 个 **GitLab REST tool**(`get_mr_files` / `get_mr_diff` / `get_file_content` / `get_previous_review` / `post_comment` / `post_line_comment`)
  - 走 **havefun 网关**(公司内部 LLM 代理,而不是直连 Anthropic / OpenAI),需要自定义 4 个 `havefun-*` provider
  - 加 **compliance ToolUse 拦截**(ci-readonly 模式禁写工具 + bash 白名单 + SIEM 审计)
  - 加 **observability 旁路**(监听 `tool_call` / `tool_execution_end` / `message_update` 等 event 做流式 stdout 打印,可被 `FLOWER_VERBOSE` 关闭)
- **可被 wrap 成我们自己的 CLI**(`flower-code-reviewer` 包装 pi 的 print mode 输出 + 加 exit code 五级判定)

### 4.2 pi 给了我们什么

| flower 的需求 | pi 提供的对应能力 |
|---|---|
| CI headless 跑 | `pi --print` / `pi --mode json` / `pi --mode rpc` / SDK `createAgentSession()` 四种非交互入口 |
| TypeScript 写 extension | `export default function (pi: ExtensionAPI) { ... }` extension factory,可用 `pi.registerTool()` / `pi.registerProvider()` / `pi.on()` |
| 注册自定义 tool | `pi.registerTool({ name, description, parameters, execute })` |
| 注册自定义 provider | `pi.registerProvider(...)`(async extension factory 等待远端 model 列表加载) |
| 监听 turn loop event | `pi.on("tool_call", ...)` / `pi.on("tool_execution_end", ...)` / `pi.on("message_update", ...)` |
| ToolUse 前置拦截 | extension hook 链 + flower-compliance 在 tool execute 之前的 wrapper 模式(`@earendil-works/pi-coding-agent/hooks` 导出 hook 类型) |
| 不依赖外部服务 | `PI_OFFLINE=1` / `PI_SKIP_VERSION_CHECK=1` 完全 air-gap |
| Session 管理 | 内置 JSONL session 存储 + `/tree` 分支(交互模式用);CI 模式可用 `--no-session` ephemeral |

详细见 `intro.html` Part B §B1.3「flower 怎么用 pi」(在 implement 阶段会进一步 dump `packages/flower-code-reviewer/src/extension.ts` 全文 72 行 + `observability.ts` 121 行)。

### 4.3 pi 没给我们什么(我们自己造的)

| 需求 | flower 怎么补 |
|---|---|
| 公司 LLM 网关(havefun)的 4 个 provider | flower-providers 自己写 4 个 `havefun-*` provider(`havefun-anthropic` / `havefun-openai` / `havefun-openai-responses` / `havefun-gemini`),通过 `pi.registerProvider()` 在 extension 启动时注册 |
| 5 个 GitLab REST tool(评审需要) | flower-tools-gitlab 自己实现,通过 `pi.registerTool()` 注册 |
| ci-readonly + bash 白名单 + SIEM 审计 | flower-compliance 自己实现,在 ToolUse 拦截点上加 wrapper |
| exit code 五级判定 + `isLlmFailure` 决策 | flower-code-reviewer 自己实现(`run.ts` / `args.ts`),pi 只负责 turn loop 退出码本身 |
| 评论模板 6 个 few-shot | flower-code-reviewer/src/prompts.ts 自己写 |
| 评审工作流 7 步 prompt | flower-code-reviewer/src/prompts.ts 自己写(中文) |
| GitLab CI job yaml 接入示例 | flower 自己提供 `.flower-code-review` job 模板 |
| 跨网容器镜像 + wrapper(`/usr/local/bin/flower-review`) | flower 自己的 Dockerfile + wrapper |

这是「pi 不规定工作流」哲学的直接体现:**pi 给底盘,flower 给业务**。

### 4.4 trade-off 的另一侧 — 我们为这种 trade-off 付出的代价

诚实列出,而非粉饰:

1. **没有内置 MCP**。如果 flower 哪天想接一个标准 MCP server(社区 Sentry / Linear / GitHub MCP 等),要么自己在 extension 里加 MCP client,要么换一个内置 MCP 的工具。当前 flower 自己的 tool 都是 in-process JS,无 MCP 需求,所以这条 trade-off 现在是 zero-cost。
2. **没有内置 sub-agents 一等公民**。flower 当前的 reviewer 是单 agent + N 个 tool 模式,sub-agent 暂时用不上;若未来需要多 agent handoff(评审 → 自动修 → 自动 commit),要在 extension 里实现 sub-agent 编排,或在 flower 这层自己派 sub-agent。
3. **没有内置 GUI / IDE 集成**。flower 不需要(reviewer 是 CI bot;ops-bot 是 dingtalk service)。这条 trade-off 对 flower 是 zero-cost。
4. **pi 升级风险**。pi 在快速迭代(CHANGELOG 一周一次 patch);extension API 在 1.0 之前可能小幅 break。flower 用 npm `^0.75.3`,允许 minor 升级,需要在升级时跑一遍 reviewer regression。

### 4.5 反过来 — 不同工具更适合什么场景(尊重对方)

为了体现 R-4 的「不踩同行」原则,这里**只描述各工具更擅长的场景**,不做价值判断:

- **cursor** 适合 reader 想要 IDE 内沉浸式 AI pair programming 的场景。
- **cline** 适合 reader 想要在 VS Code 内部 plan/act 切换 + 边对话边改文件 + MCP server 集成的场景。
- **aider** 适合 reader 想要终端里以"对话 + diff + 自动 git commit"循环驱动开发的场景。
- **claude-code** 适合 reader 想要齐套 surface(Hooks / Subagents / Skills / MCP / Slash Commands)开箱即用的场景。
- **openai-agents-sdk** 适合 reader 想要把 agent 嵌入到自己 Python / TS 应用、自己组装 multi-agent / handoff / guardrail 的场景。
- **pi** 适合 reader 想要 CLI 跑、不依赖 IDE、用 TypeScript extension 深度定制 tool + provider + event listener 的场景(flower 落在这里)。

不同 trade-off,不同适用场景。

---

## 5. pi 在四个轴上的位置(可视化矩阵)

| 轴 | 左端 | pi 落点 | 右端 |
|---|---|---|---|
| 抽象高度 | SDK(组装) | **中**(SDK + 框架双端) | 集成 IDE(沉浸) |
| 部署形态 | cloud-hosted | **本地 CLI / SDK / RPC** | local-only |
| 扩展机制 | 内置无定制 | **TS extension factory + hook** | MCP 优先 |
| 中文/i18n | 工具内置中文 | **不限定**(由 system prompt / extension 决定) | 工具内置英文 |
| 目标场景 | 单功能(代码生成) | **通用 harness**(由 extension 决定能干什么) | 一站式 IDE |

flower 落在 pi 之上的位置:**本地 CLI + 中文 prompt + TS extension 定制 + CI 集成 + LLM 走公司网关**。

---

## 6. 关键引用与延伸阅读

### pi 自身
- pi README v0.75.3 — 本仓库 `node_modules/@earendil-works/pi-coding-agent/README.md`
- pi 上游 monorepo — <https://github.com/earendil-works/pi-mono>
- pi 作者博文「Why pi?」 — <https://mariozechner.at/posts/2025-11-30-pi-coding-agent/>
- pi 作者博文「What if you don't need MCP?」 — <https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/>
- pi RPC 协议 — pi `docs/rpc.md`(本仓库 `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`)
- pi SDK 示例 — pi `examples/sdk/`(本仓库 `node_modules/@earendil-works/pi-coding-agent/examples/sdk/`)
- pi development docs — pi `docs/development.md`(本仓库 `node_modules/@earendil-works/pi-coding-agent/docs/development.md`)

### cursor
- 官方 docs — <https://docs.cursor.com/>
- features 概览 — <https://www.cursor.com/features>
- MCP 集成 — <https://docs.cursor.com/context/model-context-protocol>
- Rules — <https://docs.cursor.com/context/rules>

### cline
- GitHub README — <https://github.com/cline/cline>
- 官方 docs — <https://docs.cline.bot/>
- MCP marketplace — <https://docs.cline.bot/mcp/mcp-overview>

### aider
- 官方网站 — <https://aider.chat/>
- GitHub — <https://github.com/Aider-AI/aider>
- features — <https://aider.chat/docs/features.html>
- usage guide — <https://aider.chat/docs/usage.html>

### claude-code
- 官方 docs — <https://docs.claude.com/en/docs/claude-code/overview>
- Hooks 文档 — <https://docs.claude.com/en/docs/claude-code/hooks>
- Subagents — <https://docs.claude.com/en/docs/claude-code/sub-agents>
- Skills — <https://docs.claude.com/en/docs/claude-code/skills>
- SDK / Headless — <https://docs.claude.com/en/docs/claude-code/sdk>
- MCP 集成 — <https://docs.claude.com/en/docs/claude-code/mcp>

### openai-agents-sdk
- Python docs — <https://openai.github.io/openai-agents-python/>
- JS docs — <https://openai.github.io/openai-agents-js/>
- GitHub(Python)— <https://github.com/openai/openai-agents-python>
- GitHub(JS)— <https://github.com/openai/openai-agents-js>
- MCP guide — <https://openai.github.io/openai-agents-python/mcp/>
- function tools — <https://openai.github.io/openai-agents-python/tools/>
- handoffs — <https://openai.github.io/openai-agents-python/handoffs/>

---

## 7. Caveats / 不确定处

1. **同类工具 API 在变**。本研究的 cursor / cline / aider / claude-code / openai-agents-sdk 形态描述以**截至 2026-01-26**(知识 cutoff)前的官方公开文档为准。各工具迭代频繁,reader 视角以 HEAD docs 为准。本文档不承诺与各工具 HEAD 实时一致。
2. **pi 的具体 hook 名 / event 名**。本文档提到 `tool_call` / `tool_execution_end` / `message_update` 等 event 名时,以 flower 仓库 `packages/flower-code-reviewer/src/observability.ts` **实际监听的 event 名**作为锚点(reader 可以去该文件搜 `pi.on(`);更权威的列表见 pi `dist/core/hooks/index.d.ts`(本仓库 `node_modules/@earendil-works/pi-coding-agent/dist/core/hooks/index.d.ts`,实施 B1.2 时由 sub-agent 读取后 dump 类型签名)。
3. **"agent 框架 vs SDK"的二分法是 spectrum 而非二分**。本文档为了交流方便用了二分,但现实里所有工具都在 spectrum 上(claude-code / pi 都同时占两端)。reader 不要把这个分类当成严格定义。
4. **本文档不涉及性能 / 模型质量 / token 价格 / 评测分数**。这些维度不是「形态」差异,且容易过期(模型每月都在变);若 reader 需要这类信息,以各工具 HEAD docs 自行比较。
5. **R-4 守则的自检**:本文档全文检查无「不够 / 落后 / 弱 / 不好 / 难用 / 简陋」等评价词;所有「不同」都用「trade-off / 适合场景 / 设计取向」表述。

---

## 8. 给 implement 阶段的提示(写到 intro.html Part B §B1.4 时)

写 §B1.4 时,**重点放在 §3(pi 定位)+ §4(flower 选 pi 的 trade-off)** — 这两段最有 flower 独有的信息密度。§1 矩阵可缩成一张紧凑表(不要原样塞 5 列 × 6 行的大表,reader 在 HTML 里看长矩阵体验差,建议用 `<details>` 或合并列)。§2(框架 vs SDK)可缩成 2-3 段散文 + 一个微型表格,放在 pi 定位之前作为"铺垫"。

§4.5「不同工具更适合什么场景」的写法可以**整段保留**,这是 R-4 的范本 — 用「适合的场景」替代「优劣」。

§4.4「我们付出的代价」诚实列出 4 条 — 这是 AC4.7「没有装腔作势措辞」和 AC4.8「flower 自己的不足也讲」的对应。implement 阶段保留这一节,不要美化删减。

---

**End of research.** 总 318 行,在 PRD 建议的 300-600 行范围内。
