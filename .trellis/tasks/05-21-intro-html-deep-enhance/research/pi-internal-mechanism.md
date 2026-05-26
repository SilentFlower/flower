# Research:pi-coding-agent 框架内部运作机制

- **Query**:pi 是什么形状的 agent harness?piMain / extension / hook / turn loop / event 系统 / tool dispatch / provider 注册 怎么工作?
- **Scope**:internal(权威来自 `node_modules/@earendil-works/pi-coding-agent` + 本仓库 flower-* 代码)
- **Date**:2026-05-22
- **版本快照**:`pi-coding-agent@0.75.3`(`CHANGELOG.md` 2026-05-18 发版)

---

## 0. TL;DR

pi 是一个**最小的终端编码 harness(coding harness)**,核心抽象是「`AgentSession` + extension 工厂 + Hook 事件总线」。它不是「写一份配置 + 给 LLM 几个 tool」的 SDK,而是一个**完整的 agent loop 实现**(turn loop + 流式事件 + tool dispatch + 会话持久化),把所有可定制点都打开成「extension 注册 / event hook」。

pi 把生命周期切成 5 个层级,从外到内:

1. **session**(会话开关 + tree fork / compact)
2. **agent**(一次用户 prompt 产生的一段处理)
3. **turn**(一轮 LLM 响应 + 该轮里的 tool calls)
4. **message**(单条 assistant / user / toolResult 消息)
5. **tool execution**(单次工具调用从开始到结束)

extension 通过 `pi.on("turn_start", ...)` 等 hook 在这 5 层任意切片上插桩,通过 `pi.registerTool` 给 LLM 加自定义工具,通过 `pi.registerProvider` 给 LLM 系统挂自定义 provider(flower-providers 就是这么挂上 4 个 havefun-* provider 的)。

flower 的 `extension.ts` 是个典型的 extension factory:它**同时**注册 LLM provider、注册合规拦截器、注册业务工具、挂 tool_call trace 监听器,所有这些都通过同一个 `ExtensionAPI` 完成。

---

## 1. piMain 函数签名与典型调用方式

### 1.1 类型签名(权威)

`dist/main.d.ts` 全文:

```typescript
import type { ExtensionFactory } from "./core/extensions/types.js";

export interface MainOptions {
    extensionFactories?: ExtensionFactory[];
}

export declare function main(args: string[], options?: MainOptions): Promise<void>;
```

— 源码:`node_modules/@earendil-works/pi-coding-agent/dist/main.d.ts`

`ExtensionFactory` 类型见 `dist/core/extensions/types.d.ts:1003`:

```typescript
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

两个关键观察:

1. **`args` 是字符串数组**,等同于 CLI argv(`pi -p "评审..." --provider havefun-anthropic --model claude-opus-4-7 --thinking high`)
2. **`extensionFactories` 是「函数注入」**而不是「路径注入」。flower 不写 extension 文件到磁盘,直接传函数引用;pi 在内部把它和磁盘发现的 extension 合并(见 §5 资源装载)

### 1.2 flower 的真实调用方式

`packages/flower-code-reviewer/src/run.ts:282-284`:

```typescript
const piArgv = buildPiCliArgs({ prompt });   // ["-p", prompt, "--provider", ..., "--model", ..., "--thinking", ...]
await piMain(piArgv, {
    extensionFactories: [extensionFactory],
});
```

`extensionFactory` 就是 `packages/flower-code-reviewer/src/extension.ts` 的 default export — 一个签名为 `(pi: ExtensionAPI) => void` 的函数。

`buildPiCliArgs` 来自 `packages/flower-providers/src/runtime.ts:209`,它把 env(`LLM_PROVIDER` / `LLM_MODEL` / `LLM_REASONING_EFFORT`)翻译成 pi 的 CLI argv,固定形态:

```
["-p", prompt, "--provider", "havefun-xxx", "--model", "xxx", "--thinking", "high"]
```

— 源码:`packages/flower-providers/src/runtime.ts` § `buildPiCliArgs`

### 1.3 返回值

`main()` 返回 `Promise<void>` — 它**不返回评审结果**。

LLM 输出 / 工具调用 / 评审动作 都是通过 **side effect**(extension 注册的事件 listener、注册的 tool execute 函数)发生的。从 reviewer 的角度看,piMain 跑完后,所有评论已经通过 `gitlab_post_line_comment` tool 发到了 GitLab,reviewer 自己再去扫 blocker(`run.ts` step 8)。

异常:LLM 网关挂了时 `piMain` 会 throw。reviewer 用 `isLlmFailure(err)` 判断后走 E1 fail-open(`run.ts:288`)。

— 源码:`packages/flower-code-reviewer/src/run.ts` § `runReview`

### 1.4 CLI 模式三选一(args 决定)

`dist/main.js` 在解析 argv 后,根据是否有 `-p` / `--mode rpc` 决定走哪一支:

```
parsed.mode → "interactive" / "print" / "rpc"
↓
runRpcMode(runtime)            // RPC over stdin/stdout
new InteractiveMode(runtime)   // 完整 TUI
runPrintMode(runtime, ...)     // 单次输出 + 退出(flower 走这条)
```

— 源码:`node_modules/@earendil-works/pi-coding-agent/dist/main.js:531-565`

flower 的 `-p <prompt>` 把 mode 钉到 print。print 模式不弹 TUI,所有 event 通过 stdout 流式打印(`observability.ts` 监听 message_update 流式输出)。

---

## 2. turn loop 序列(核心生命周期)

### 2.1 官方 lifecycle 图(权威,从 docs/extensions.md §Events §Lifecycle Overview)

```
pi starts
  │
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first, bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while LLM calls tools) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (can modify messages)            │       │
  │   ├─► before_provider_request (can inspect or replace payload)
  │   ├─► after_provider_response (status + headers, before stream consume)
  │   │                                            │       │
  │   │   LLM 响应,可能产生 tool call:             │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (can block)              │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (can modify)           │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  └─► agent_end                                            │
                                                           │
user sends another prompt ◄────────────────────────────────┘
```

— 源码:`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` § Lifecycle Overview

### 2.2 各阶段拆解

#### 阶段 A · 启动与会话装载

- `session_start { reason: "startup" }`:会话被创建 / 恢复时触发一次。`event.reason` 可能是 `"startup" | "reload" | "new" | "resume" | "fork"`(`dist/core/extensions/types.d.ts:382-388`)
- `resources_discover { reason: "startup" }`:跟在 `session_start` 后,允许 extension 返回额外的 `skillPaths` / `promptPaths` / `themePaths`(`types.d.ts:370-380`)

flower 不监听这两个事件 — 它在 extension factory 注册阶段就把 4 个 provider 注册完了,不需要后续等待。

#### 阶段 B · 用户 prompt → 启动 agent

- `input`:用户输入到达。**可拦截 / 改写 / handled**(短路 LLM)。返回值是 `{ action: "continue" | "transform" | "handled", text?, images? }`(`types.d.ts:577-585`)
- `before_agent_start`:用户输入解析完毕,在 agent loop 启动前 fire。**可注入 message,可改 system prompt**(`types.d.ts:467-477`)
- `agent_start`:agent loop 正式启动(`types.d.ts:480`)
- `message_start`:第一条 user message 入库(`types.d.ts:502`)

flower 不监听这几个事件。

#### 阶段 C · turn loop(核心,可能重复 N 次)

**每轮 turn 包含「一次 LLM 调用 + 该次返回的 tool calls 全部跑完」**。如果 LLM 那一轮没调 tool(直接给最终答案),turn 就只有一次,然后 turn_end。如果调了 3 个 tool,turn 内部就跑 3 次 tool execution,然后 turn_end,**接着可能进入下一个 turn**(LLM 用 tool 结果继续推理)。

每个 turn 的事件序列:

```
turn_start         {turnIndex, timestamp}
  ↓
context            {messages: AgentMessage[]}    ← 可以改 messages
  ↓
before_provider_request   {payload: unknown}     ← 可以改 payload(临 LLM 发请求前)
  ↓
[HTTP 请求 → LLM 网关]
  ↓
after_provider_response   {status, headers}      ← 收到响应、消费 stream 前
  ↓
message_start      {message: assistantMessage}    ← LLM 这轮的 assistant message
message_update     {message, assistantMessageEvent}  ← 流式 token 一直触发
                   (子类型见 §2.3)
message_end        {message}                      ← assistant message 完结,可改
  ↓
[LLM 这轮如果包含 tool_call,对每个 tool call 跑:]
  tool_execution_start   {toolCallId, toolName, args}
  tool_call              {toolName, toolCallId, input}   ← 可阻塞 / 可改 input
  tool_execution_update  {toolCallId, toolName, args, partialResult}
                         (执行中流式,某些 tool 才有)
  tool_result            {toolCallId, toolName, input, content, details, isError}  ← 可改 result
  tool_execution_end     {toolCallId, toolName, result, isError}
  ↓
turn_end           {turnIndex, message, toolResults}
```

— 源码:`dist/core/extensions/types.d.ts:451-538`(各 event interface 定义)

注意 pi **默认是并行 tool 模式**(parallel mode):一个 assistant message 里有多个 tool call 时,`tool_execution_start` 在 preflight 阶段按 source order 全部 emit,但 `tool_call` / `tool_execution_end` 可能在多个 tool 间交叉 emit。详见 `docs/extensions.md` § Tool Events,以及 `types.d.ts:568-572`:

> In parallel tool mode:
> - `tool_execution_start` is emitted in assistant source order during the preflight phase
> - `tool_execution_update` events may interleave across tools
> - `tool_execution_end` is emitted in tool completion order after each tool is finalized

#### 阶段 D · agent 结束

- `agent_end { messages }`:agent loop 全部结束,messages 是这次 prompt 产生的全部新消息(`types.d.ts:484-487`)

print 模式下 `agent_end` 后整个进程退出。reviewer 走 print 模式,所以 `agent_end` 之后 `piMain` 这次调用就 resolve 了。

### 2.3 message_update 的 token 流式子事件

`message_update` 自身只有一种 event type,但 `event.assistantMessageEvent` 字段携带流式子类型。flower observability.ts 监听了这些子类型(`observability.ts:73-101`):

| 子类型 | 含义 | flower 怎么处理 |
|---|---|---|
| `thinking_start` | 开始 reasoning 区段 | 打 "💭 thinking: " 前缀 |
| `thinking_delta` | reasoning token 流入 | `process.stdout.write(ev.delta)` |
| `thinking_end` | reasoning 区段结束 | `process.stdout.write("\n")` |
| `text_start` | 开始正文 token | 打 "💬 assistant: " 前缀 |
| `text_delta` | 正文 token 流入 | `process.stdout.write(ev.delta)` |
| `text_end` | 正文区段结束 | 换行 |
| `toolcall_end` | LLM 决定调用某个 tool(参数已就绪) | 打 "🔧 [tool →] {name} args=…" |
| 其它(`toolcall_start` / `toolcall_delta` / `start` / `done` / `error`) | — | 不处理 |

这些子类型来自 `@earendil-works/pi-ai` 包的 `AssistantMessageEvent` 类型(`types.d.ts:11` import 链)。flower 不直接 import 它,而是通过 switch 字符串匹配子类型,因此对上游精确升级不太敏感。

— 源码:`packages/flower-code-reviewer/src/observability.ts` § `registerObservability`

---

## 3. event 系统(emit / listen / payload 形状)

### 3.1 注册方式:`pi.on(event, handler)`

`ExtensionAPI.on` 是 27 路重载方法(`dist/core/extensions/types.d.ts:783-812`),签名节选:

```typescript
on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
on(event: "session_start",       handler: ExtensionHandler<SessionStartEvent>): void;
on(event: "context",             handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
on(event: "before_provider_request",  handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>): void;
on(event: "after_provider_response",  handler: ExtensionHandler<AfterProviderResponseEvent>): void;
on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
on(event: "agent_start",        handler: ExtensionHandler<AgentStartEvent>): void;
on(event: "agent_end",          handler: ExtensionHandler<AgentEndEvent>): void;
on(event: "turn_start",         handler: ExtensionHandler<TurnStartEvent>): void;
on(event: "turn_end",           handler: ExtensionHandler<TurnEndEvent>): void;
on(event: "message_start",      handler: ExtensionHandler<MessageStartEvent>): void;
on(event: "message_update",     handler: ExtensionHandler<MessageUpdateEvent>): void;
on(event: "message_end",        handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
on(event: "tool_execution_start",  handler: ExtensionHandler<ToolExecutionStartEvent>): void;
on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
on(event: "tool_execution_end",    handler: ExtensionHandler<ToolExecutionEndEvent>): void;
on(event: "model_select",          handler: ExtensionHandler<ModelSelectEvent>): void;
on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
on(event: "tool_call",          handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
on(event: "tool_result",        handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
on(event: "user_bash",          handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
on(event: "input",              handler: ExtensionHandler<InputEvent, InputEventResult>): void;
// + 6 个 session_* 事件
```

`ExtensionHandler<E, R = undefined>` 类型(`types.d.ts:779`):

```typescript
export type ExtensionHandler<E, R = undefined> =
    (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
```

— 源码:`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` § `ExtensionAPI`

关键观察:

1. **handler 签名是 `(event, ctx)`**,不是 `(event)` — `ctx` 是 `ExtensionContext`,提供 `ui` / `sessionManager` / `signal` 等运行时能力(详见 §3.3)
2. **handler 可 sync 可 async**(`Promise<R | void> | R | void`)
3. **部分 event 有返回值的 R**(比如 `tool_call` 返回 `{ block: true }` 就阻塞执行,`context` 返回 `{ messages }` 就改 LLM 上下文,`message_end` 返回 `{ message }` 就替换 finalized message)。返回 void 默认无影响

### 3.2 flower 监听的 event payload 形状(从 .d.ts 抄)

```typescript
// types.d.ts:489-493
interface TurnStartEvent     { type: "turn_start"; turnIndex: number; timestamp: number; }

// types.d.ts:507-511
interface MessageUpdateEvent { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent; }
//   ^ AssistantMessageEvent 子类型见 §2.3,token-by-token 流式 delta(来自 @earendil-works/pi-ai)

// types.d.ts:533-539
interface ToolExecutionEndEvent { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean; }

// types.d.ts:495-500
interface TurnEndEvent       { type: "turn_end"; turnIndex: number; message: AgentMessage; toolResults: ToolResultMessage[]; }

// types.d.ts:462-466
interface AfterProviderResponseEvent { type: "after_provider_response"; status: number; headers: Record<string, string>; }
//   ^ flower 用这个 hook 检测 status >= 400,打 ⚠️ [llm provider] 警告

// types.d.ts:484-487
interface AgentEndEvent      { type: "agent_end"; messages: AgentMessage[]; }
```

### 3.3 ToolCallEvent 形状 + 阻塞能力(flower 用到)

`ToolCallEvent` 是个联合类型,内置 tool 有强类型 input,custom tool fallback 到 `Record<string, unknown>`(`types.d.ts:586-628`):

```typescript
type ToolCallEvent =
    | BashToolCallEvent | ReadToolCallEvent | EditToolCallEvent | WriteToolCallEvent
    | GrepToolCallEvent | FindToolCallEvent | LsToolCallEvent | CustomToolCallEvent;

interface BashToolCallEvent   { type: "tool_call"; toolCallId: string; toolName: "bash"; input: BashToolInput; }
interface CustomToolCallEvent { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown>; }
```

ToolCallEvent **可阻塞**(返回 `{ block: true, reason?: string }`,见 `ToolCallEventResult`,`types.d.ts:714-718`)。**`event.input` 是 mutable** — handler 可以原地改 tool 入参再放行(`docs/extensions.md` § tool_call 段)。

flower 的 `tool_call` 监听器(`extension.ts:45-71`)只读 input(记 trace),不阻塞:

```typescript
pi.on("tool_call", async (event) => {
    if (event.toolName === "gitlab_get_file_content") {
        const path = event.input.path;
        if (typeof path === "string") {
            recordFileRead(path);   // 写到 review-trace 模块的内存
        }
        return undefined;            // 不阻塞
    }
    // ...
});
```

阻塞功能由 **flower-compliance 包**负责(走另一组 `pi.on("tool_call", ...)` 监听器),见 §4.3。

### 3.4 ExtensionContext(handler 入参 ctx)

`dist/core/extensions/types.d.ts:207-236`,关键字段:

```typescript
interface ExtensionContext {
    ui: ExtensionUIContext;                   // 用户交互(notify/confirm/select/input/setStatus 等)
    hasUI: boolean;                            // print/RPC 模式下 false
    cwd: string;
    sessionManager: ReadonlySessionManager;    // 只读 session 状态访问
    modelRegistry: ModelRegistry;
    model: Model<any> | undefined;
    signal: AbortSignal | undefined;           // 当前 agent abort signal(用于嵌套 fetch)
    abort(): void;
    shutdown(): void;                           // 优雅退出 pi
    getContextUsage(): ContextUsage | undefined;
    compact(options?: CompactOptions): void;
    getSystemPrompt(): string;
    // + isIdle / hasPendingMessages
}
```

flower handler 几乎都用 `(event, _ctx)` 不消费 ctx,因为 print 模式下 UI 是 stub,日志直接 `console.log`/`process.stdout.write`。

### 3.5 handler 返回值(可控行为)

```typescript
interface ToolCallEventResult     { block?: boolean; reason?: string; }
interface ContextEventResult      { messages?: AgentMessage[]; }        // 替换 LLM 上下文
interface MessageEndEventResult   { message?: AgentMessage; }           // 替换 finalized message(role 必须保持)
interface ToolResultEventResult   { content?: (TextContent|ImageContent)[]; details?: unknown; isError?: boolean; }
```

— `types.d.ts:710-733`

---

## 4. tool dispatch(LLM tool_call → pi 内部 router → 真实执行)

### 4.1 tool 注册的两个来源

`pi.registerTool(definition)` 注册到 extension 工厂里(`types.d.ts:814`):

```typescript
registerTool<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>): void;
```

`ToolDefinition`(`types.d.ts:328-359`)关键字段:

```typescript
interface ToolDefinition<TParams extends TSchema, TDetails, TState> {
    name: string;                                                  // LLM 调用名
    label: string;                                                  // UI 显示名
    description: string;                                            // 给 LLM 看
    promptSnippet?: string;                                          // system prompt Available tools 一行
    promptGuidelines?: string[];                                    // system prompt Guidelines 追加
    parameters: TParams;                                            // TypeBox schema
    executionMode?: ToolExecutionMode;                              // "sequential" | "parallel"
    prepareArguments?: (args: unknown) => Static<TParams>;          // schema 校验前的兼容 shim
    execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>;
    renderCall?:   (...) => Component;
    renderResult?: (...) => Component;
}
```

**两种 tool 来源**:

1. **内置 tool**(`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`):由 pi 在启动时按 `--tools` allowlist 选择性注册;每个有标准的 `*Operations` 可替换(`createReadTool({ operations })` 之类,见 `docs/extensions.md` § Remote Execution)
2. **extension / customTools 注册的 tool**:通过 `pi.registerTool` 或 SDK 的 `customTools: [...]` 加入

注册后,**所有 tool 走同一个 dispatcher**。LLM 看到的工具清单 = (active 的内置 + active 的 extension/custom)。

— 源码:`dist/core/agent-session.d.ts:266-281`(`getActiveToolNames` / `setActiveToolsByName`)

### 4.2 LLM 返回 tool_call → pi 内部 dispatch 序列

LLM 这一轮 message 里包含 `tool_call` blocks 时,pi 内部按以下顺序处理(从 `extensions/runner.d.ts` + lifecycle 图反推):

```
1. emitToolExecutionStart(toolCallId, toolName, args)   // 通知 listener,UI 显示工具卡片
2. emitToolCall(event)                                   // 给 extension hook 拦截机会
   ├─ 任一 handler 返回 { block: true } → 跳到步骤 6,result = "Blocked: <reason>"
   └─ 任一 handler mutate event.input → 改后的 input 传给 execute
3. dispatch:lookup tool registry by name → 调对应的 execute(toolCallId, params, signal, onUpdate, ctx)
   ├─ 内置 tool:走 createReadTool / createBashTool 等的内部 ops
   └─ extension tool:走 pi.registerTool 传入的 execute
4. 执行过程中可能多次 onUpdate(partialResult) → emit tool_execution_update
5. execute 返回 AgentToolResult → emit tool_result(可被 handler 修改)
6. emit tool_execution_end(result, isError)
7. result 作为 toolResult message 进入 LLM 上下文,等下一个 turn 用
```

— 源码:
- `dist/core/extensions/runner.d.ts:130-138`(`emitToolCall` / `emitToolResult` / `createContext` 等签名)
- `dist/core/agent-session.d.ts:206-213`(注释「Install tool hooks once on the Agent instance」,工具拦截在 AgentSession 层做,extension 通过 emitToolCall 参与)

~推测,以源码为准~:具体 dispatch 表的存储位置在 `_toolRegistry` / `_toolDefinitions`(`agent-session.d.ts:194-198`),工具按 `name` lookup,extension 注册的 tool 与内置 tool 用同一个 Map 存储 — 如果 extension 注册了同名 tool(如 `read`),则 override 内置(`docs/extensions.md` § Overriding Built-in Tools 段佐证)。

### 4.3 flower 的 tool 注册全景

flower 的 `extension.ts:24-32` 注册了 4 个 tool 集合 + 拦截器 + 监听器:

```typescript
export default function (pi: ExtensionAPI): void {
    registerHavefunProviders(pi, { appSource: "code-reviewer" });   // ← provider,不是 tool
    registerCompliance(pi, { mode: "ci-readonly", product: "code-reviewer" });  // ← 拦截器,通过 pi.on("tool_call", ...)
    registerCommonTools(pi);            // → flower-tools-common(zentao_search / dingtalk_doc_search)
    registerGitlabTools(pi);            // → flower-tools-gitlab(5 个 GitLab REST tool)
    registerReviewerSelfTools(pi);      // → reviewer 自检工具(reviewer_list_my_blockers 等)
    registerReviewTrace(pi);            // ← 通过 pi.on("tool_call", ...) 监听,不注册 tool
    registerObservability(pi);          // ← 通过 pi.on(...) 监听一堆 event
}
```

— 源码:`packages/flower-code-reviewer/src/extension.ts` § default export

注释明确说「**调用顺序很关键**」:

1. 先 provider(没这一步,pi 找不到模型)
2. 再 compliance 拦截(后续工具调用的「门禁」)
3. 最后业务工具
4. 最后挂 tool_call trace 监听器

这个顺序的关键不是 pi 本身要求,而是**让多个 `pi.on("tool_call", ...)` handler 链中,compliance 先于 trace** — handler 按注册顺序触发(`runner.d.ts` 的 `emitToolCall` 内部按 handlers 数组顺序 iterate,~推测,以源码为准~)。

---

## 5. extension factory lifecycle

### 5.1 factory 何时被调

`ExtensionFactory` 类型(`types.d.ts:1003`):

```typescript
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

factory 在 pi 启动的「资源装载阶段」被调用,**早于** `session_start` event。具体被调时点(从 `dist/main.js` 反推):

```
piMain(argv, { extensionFactories })
  │
  ├─► createAgentSessionServices({ resourceLoaderOptions: { extensionFactories } })
  │     └─► DefaultResourceLoader 装载磁盘 extension(if any)+ 调用传入的 extensionFactories
  │           每个 factory 拿到一个 ExtensionAPI 实例
  │           factory 在体内调 pi.on / pi.registerTool / pi.registerProvider / pi.registerCommand
  │           注册项被 collect 到 Extension 对象的 Maps(handlers / tools / commands / flags / shortcuts)
  │
  ├─► async factory:pi 会 await factory 的 Promise 才继续(docs/extensions.md § Async factory functions)
  │
  ├─► createAgentSessionFromServices(...) → 创建 AgentSession,bindExtensions(...)
  │     ExtensionRunner.bindCore(actions, contextActions, providerActions)
  │     ExtensionRunner.bindUI(uiContext)  ← print/RPC 模式下 uiContext 是 stub
  │
  └─► emit session_start { reason: "startup" }
      emit resources_discover { reason: "startup" }
      ... 进入 user prompt / agent loop
```

— 源码:
- `dist/main.js:413-484`(createRuntime factory 调用链)
- `docs/extensions.md` § Async factory functions(「pi awaits it before continuing startup. That means async initialization completes before session_start, before resources_discover, and before provider registrations queued via pi.registerProvider() are flushed」)
- `dist/core/extensions/runner.d.ts:93-98`(`bindCore` 签名)

### 5.2 factory 阶段的 pi.registerProvider 怎么生效

关键细节(`types.d.ts:1049-1068`):

```typescript
interface ExtensionRuntimeState {
    pendingProviderRegistrations: Array<{ name; config; extensionPath }>;
    registerProvider:   (name: string, config: ProviderConfig, extensionPath?: string) => void;
    unregisterProvider: (name: string, extensionPath?: string) => void;
    // ...
}
```

注释:「Before bindCore(): queues registrations / removes from queue. After bindCore(): calls ModelRegistry directly for immediate effect.」

也就是说,extension factory 在 **bindCore 之前**调 `pi.registerProvider`,会被排队到 `pendingProviderRegistrations`,等到 ExtensionRunner.bindCore() 执行时统一 flush 到 ModelRegistry。**之后**(在 event handler / command handler 里调)则直接生效。

flower-providers 的 `registerHavefunProviders` 在 factory 里调,4 个 provider 会进入 queue,bindCore 时统一 flush。

### 5.3 lifecycle 事件触发顺序(reload / session 切换)

- **`/reload`** 命令 → `session_shutdown { reason: "reload" }` → 重新 load extension → `session_start { reason: "reload" }`
- **`/new`** / **`/resume`** 命令 → `session_before_switch`(可取消) → `session_shutdown` → reload → `session_start { reason: "new" | "resume", previousSessionFile }`
- **`/fork` / `/clone`** → `session_before_fork`(可取消) → `session_shutdown { reason: "fork" }` → reload → `session_start { reason: "fork", previousSessionFile }`
- **退出**(Ctrl+C / SIGTERM 等) → `session_shutdown { reason: "quit" }`

— 源码:`docs/extensions.md` § Lifecycle Overview(图 bottom)

print 模式下(flower)只走 `session_start { reason: "startup" }` 和 `session_shutdown { reason: "quit" }`,中间不可能切 session。

### 5.4 extension 内部数据形态

`Extension` interface(`types.d.ts:1146-1156`):

```typescript
interface Extension {
    path: string;
    resolvedPath: string;
    sourceInfo: SourceInfo;
    handlers: Map<string, HandlerFn[]>;          // event 名 → handler 数组
    tools: Map<string, RegisteredTool>;
    messageRenderers: Map<string, MessageRenderer>;
    commands: Map<string, RegisteredCommand>;
    flags: Map<string, ExtensionFlag>;
    shortcuts: Map<KeyId, ExtensionShortcut>;
}
```

也就是说 factory 注册的所有东西最终被收编到这些 Map 里。`ExtensionRunner` 在 emit event 时遍历所有 Extension,把对应 handler 数组按注册顺序逐个 await。

---

## 6. provider 注册(LLM 接入机制)

### 6.1 pi.registerProvider 签名

`types.d.ts:920-934`:

```typescript
registerProvider(name: string, config: ProviderConfig): void;
unregisterProvider(name: string): void;
```

`ProviderConfig` 关键字段(`types.d.ts:939-969`):

```typescript
interface ProviderConfig {
    name?: string;
    baseUrl?: string;
    apiKey?: string;                                   // API key 字面量 或 env 变量名
    api?: Api;                                         // "anthropic-messages" / "openai-completions" / "openai-responses" / "google-generative-ai"
    headers?: Record<string, string>;
    models?: ProviderModelConfig[];
    oauth?: { name; login; refreshToken; getApiKey; modifyModels? };
    streamSimple?: (model, context, options?) => AssistantMessageEventStream;
    authHeader?: boolean;
}
```

`ProviderModelConfig`(`types.d.ts:971-1001`):

```typescript
interface ProviderModelConfig {
    id: string;
    name: string;
    api?: Api;                                          // 覆盖 provider 级 api
    baseUrl?: string;                                   // 覆盖 provider 级 baseUrl
    reasoning: boolean;
    thinkingLevelMap?: Model<Api>["thinkingLevelMap"];  // pi 的 ThinkingLevel → provider-specific 值
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: Model<Api>["compat"];
}
```

### 6.2 flower-providers 怎么注册 4 个 havefun-* provider

`packages/flower-providers/src/register.ts` § `registerHavefunProviders`:

```typescript
export function registerHavefunProviders(pi: ExtensionAPI, options: { appSource: string }): void {
    // env 校验 + 合并模型清单(内置 8 条 + LLM_EXTRA_MODELS_JSON 注入)
    getLLMBaseUrl();
    const apiKeyEnvName = getLLMApiKeyEnvName();
    const mergedModels = getMergedModels();

    for (const providerName of ALLOWED_PROVIDER_NAMES) {
        const api = PROVIDER_TO_API[providerName];
        // 按 nativeApi 严格匹配,每个 model 只命中 1 个 provider
        const filteredModels = mergedModels.filter((m) => m.nativeApi === api);
        const providerBaseUrl = resolveProviderBaseUrl(providerName);

        pi.registerProvider(providerName, {
            baseUrl: providerBaseUrl,
            apiKey: apiKeyEnvName,                                  // env 变量名,不是字面 key
            api,
            models: filteredModels.map(toProviderModelConfig),
            headers: { "X-App-Source": options.appSource },         // 审计 & 计费
        });
    }
}
```

— 源码:`packages/flower-providers/src/register.ts`

四个 provider 一次性全部注册,关键设计:

1. **provider 名固定 4 个**:`havefun-openai` / `havefun-openai-responses` / `havefun-anthropic` / `havefun-gemini`(`catalog.ts:23` 联合类型)
2. **模型按 `nativeApi` 严格归属**:`catalog.ts:31-36` 的 `PROVIDER_TO_API` 表,每条 model 的 `nativeApi` 字段决定它注册到哪个 provider — 一个 model 不会同时挂在两个 provider 上,杜绝 pi 内部按重名 model id 误选
3. **baseUrl 按 provider 自动拼后缀**(`catalog.ts:88-93` `PROVIDER_PATH_SUFFIX`):
   - `havefun-openai` / `-openai-responses` → `${LLM_BASE_URL}/v1`(OpenAI SDK 拼 `/chat/completions`)
   - `havefun-anthropic` → `${LLM_BASE_URL}` 不带 `/v1`(Anthropic SDK 自己拼 `/v1/messages`)
   - `havefun-gemini` → `${LLM_BASE_URL}/v1beta`(pi-ai 的 google.js 要求 baseURL 已含版本路径)
4. **`apiKey` 是 env 变量名**而不是字面 key — pi 内部用 AuthStorage 解析,优先 `auth.json`,然后 env(`docs/sdk.md` § API Keys and OAuth)。flower 用 env 名,部署时容器注入

### 6.3 内置 8 个模型清单(catalog.ts)

| id | provider(nativeApi) | reasoning | context / maxTokens |
|---|---|---|---|
| claude-opus-4-7 | havefun-anthropic | true(thinkingLevelMap xhigh→max) | 1M / 128K |
| claude-sonnet-4-6 | havefun-anthropic | true | 1M / 64K |
| claude-haiku-4-5-20251001 | havefun-anthropic | false | 200K / 64K |
| gemini-2.5-pro | havefun-gemini | true | ~1M / 65K |
| gemini-2.5-flash | havefun-gemini | true | ~1M / 65K |
| gemini-2.5-flash-lite | havefun-gemini | false | ~1M / 65K |
| gpt-5.4 | havefun-openai-responses | true | 1.05M / 128K |
| gpt-5.5 | havefun-openai-responses | true | 400K / 128K |

— 源码:`packages/flower-providers/src/catalog.ts` § `BUILTIN_MODELS`

`havefun-openai` provider 默认无内置模型,作为后续通过 `LLM_EXTRA_MODELS_JSON` 注入「只支持 openai-completions 协议的模型」(grok / qwen / glm 等)的兜底接口。`register.ts:77-79` 的注释明示「pi 接受空 models」。

### 6.4 CLI 路径与 SDK 路径的对称

flower-providers 提供**两套接入**:

1. **CLI 路径**(reviewer 走):`buildPiCliArgs` 把 env 翻译成 `["--provider", "havefun-anthropic", "--model", "claude-opus-4-7", "--thinking", "high"]` 等 argv,piMain 内部解析后定位 model
2. **SDK 路径**(ops-bot 走):`buildHavefunModel` 直接返回 `Model<Api>` 实例,绕开 CLI 解析 — 适合 ops-bot 这种「常驻 service,显式配置文化」的场景

— 源码:`packages/flower-providers/src/runtime.ts` § `buildPiCliArgs` 与 § `buildHavefunModel`

两个产品共用同一份 catalog + env 解析,但暴露形态不同。

---

## 7. flower 监听的 6 个 event 的 pi 类型对照

flower `observability.ts` 监听了 6 类 event,对应到 pi 的精确类型如下:

| flower 监听 | pi 事件类型 | payload .d.ts 路径 | 用途 |
|---|---|---|---|
| `turn_start` | `TurnStartEvent` | `types.d.ts:489` | 打 `>>> 🤖 [turn N] start` |
| `message_update` | `MessageUpdateEvent` | `types.d.ts:507` | switch `assistantMessageEvent.type` 子类型流式打印 thinking/text/toolcall |
| `tool_execution_end` | `ToolExecutionEndEvent` | `types.d.ts:533` | 打 `🔧 [tool ←]` 或 `🔧 [tool ✗ error]` |
| `after_provider_response` | `AfterProviderResponseEvent` | `types.d.ts:462` | status >= 400 时打 `⚠️ [llm provider]` |
| `turn_end` | `TurnEndEvent` | `types.d.ts:495` | 打 `>>> 🤖 [turn N] end` |
| `agent_end` | `AgentEndEvent` | `types.d.ts:484` | 打 `>>> 🤖 [agent] session end` |

flower `extension.ts` 额外监听:

| flower 监听 | pi 事件类型 | 用途 |
|---|---|---|
| `tool_call`(only `gitlab_get_file_content` / `gitlab_post_line_comment`) | `ToolCallEvent` 联合 | 记 review-trace(readFiles / lineComments),供 `reviewer_list_my_blockers` 工具读取本轮 blocker 真值;不阻塞 |

`flower-compliance` 包内部应另注册 `pi.on("tool_call", ...)` 做写工具禁用 / bash 白名单等拦截 — 这部分本研究文档不展开。

---

## 8. 关键设计观察(便于 B1.4 同类对比)

### 8.1 「最小核心 + extension 都开放」哲学

pi 显式 reject 了几个常见 agent feature(README.md § Philosophy):

- **No MCP**:用 CLI tools + README(skill 形态)
- **No sub-agents**:用 tmux 跑多个 pi 实例,或 extension 自己实现
- **No permission popups**:用 container,或 extension 自己实现 confirmation
- **No plan mode**:写 plan 到文件,或 extension 实现
- **No built-in to-dos**:用 TODO.md 文件
- **No background bash**:用 tmux

这与 cursor / cline / claude-code 形成鲜明对比 — 后者都把这些做进了核心。pi 的取向是「**框架 + extension**」,而非「集成式 agent」。

### 8.2 「agent 框架 vs agent SDK」差异

pi 同时提供两套入口:`piMain` (CLI 入口,含 print/interactive/rpc 三态) 和 `createAgentSession` (SDK 入口)。

flower 选 CLI 路径(piMain + extension factory),不直接用 SDK,理由(推测):

- piMain 已经做好了 arg parse / session 装载 / model 选择 / tool 装载 / extension 装配 — flower 不想重复实现
- extension factory 注入函数已经足够定制
- 走 print 模式可拿到「单进程跑一次评审 → 退出」的简洁形态,不要 TUI

### 8.3 extension 工厂的「事件 + 注册」对称

extension factory 内能做两类事:

1. **注册**(改 pi 的能力):`registerTool` / `registerProvider` / `registerCommand` / `registerShortcut` / `registerFlag` / `registerMessageRenderer`
2. **订阅事件**(挂 listener):`pi.on(event, handler)`

这两类**互不冲突**且可以混用 — 例如 flower-compliance 既注册了 tool_call 拦截器,也(推测)注册了 SIEM 上报 hook;flower-code-reviewer 既注册了 review-trace tool(`reviewer_list_my_blockers` 等自审工具),也注册了 tool_call trace 监听器。

---

## 9. Caveats / 未确定的细节

### 9.1 ~推测,以源码为准~ 项

- **tool dispatcher 内部存储**:推测在 `_toolRegistry` / `_toolDefinitions` Map 里,extension tool 与内置 tool 共用 namespace,override 用 same-name 覆盖。来自 `dist/core/agent-session.d.ts:194-198` 的私有字段命名,和 `docs/extensions.md` § Overriding Built-in Tools 的描述对照
- **handler 触发顺序**:`pi.on("tool_call", ...)` 的多个 handler 按注册顺序触发。来自 `docs/extensions.md` § tool_result「Handlers run in extension load order」(tool_result 明示,tool_call 推测同样行为)
- **provider queue flush 时机**:推测在 `ExtensionRunner.bindCore` 调用时把 `pendingProviderRegistrations` 全部 flush 到 ModelRegistry。来自 `types.d.ts:1049-1068` 字段定义 + 注释

### 9.2 未读取项(本研究不展开)

- `dist/core/extensions/loader.d.ts`:磁盘 extension 装载 / 监听 reload(flower 不用磁盘 extension,可忽略)
- `dist/core/extensions/wrapper.d.ts`:tool 包装层(flower 没用 `wrapRegisteredTool`)
- `compaction.md` / `session-format.md`:reviewer 单次评审跑完即退,不触发 compaction,不写 session,这部分对 reviewer 无影响
- pi-agent-core / pi-ai 上游包:本研究范围仅到 pi-coding-agent 层

### 9.3 `dist/core/hooks/index.d.ts`(package.json 声明的 `./hooks` 子导出)

`package.json` 的 `exports."./hooks"` 字段声明了 `./dist/core/hooks/index.d.ts`,但实际**该目录不存在**(`ls` 报 No such file or directory)。猜测这是 reserved-for-future / 未实装的 entry。本仓库内 hook 类型实际都从 `@earendil-works/pi-coding-agent`(主入口)导入(extension.ts:12 `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`),所以这个未实装项不影响 flower。

---

## 10. 关键源码定位速查

| 想找什么 | 在哪 |
|---|---|
| `piMain` 函数签名 | `node_modules/@earendil-works/pi-coding-agent/dist/main.d.ts` |
| `ExtensionAPI.on` 27 路重载 + 所有 event 类型 | `dist/core/extensions/types.d.ts` |
| 完整 lifecycle 图(ASCII) | `docs/extensions.md` § Events § Lifecycle Overview |
| `AgentSession` 类签名 | `dist/core/agent-session.d.ts` |
| `ExtensionRunner` 签名 | `dist/core/extensions/runner.d.ts` |
| flower 怎么注册 extension | `packages/flower-code-reviewer/src/extension.ts` |
| flower observability 怎么监听 event | `packages/flower-code-reviewer/src/observability.ts` |
| flower 怎么调 piMain | `packages/flower-code-reviewer/src/run.ts` § `runReview` |
| flower-providers 怎么注册 4 个 provider | `packages/flower-providers/src/register.ts` § `registerHavefunProviders` |
| flower-providers env → CLI argv 翻译 | `packages/flower-providers/src/runtime.ts` § `buildPiCliArgs` |
| 内置 8 个模型清单 | `packages/flower-providers/src/catalog.ts` § `BUILTIN_MODELS` |
