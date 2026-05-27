# Research: 跨包数据流 — 4 条线的实际代码路径

- **Query**: 梳理 design.md §4 / prd.md R14 B3.1-B3.4 4 个跨包数据流的实际代码路径
- **Scope**: 内部仓库源码 + `node_modules/@earendil-works/pi-*` 类型 / minified 反推
- **Date**: 2026-05-22

> 本文档为 B3 节实施的事实依据;结论以源码 / `.d.ts` 为准,pi 内部 minified 反推处标 ~推测~。

---

## 0. 总览:extension 注册顺序与 4 条流的入口

`packages/flower-code-reviewer/src/extension.ts` L24-L32 注册顺序:

```
1. registerHavefunProviders   (B3.1 入口)         必须最先 — 没 provider pi 找不到 model
2. registerCompliance         (B3.2 拦截 + B3.4 audit)  必须在工具注册前
3. registerCommonTools                            静态注册
4. registerGitlabTools        (B3.2 工具源)
5. registerReviewerSelfTools                      静态注册
6. registerReviewTrace        (B3.2 旁路计数)     run.ts 用 trace 做"无依据评论" blocker
7. registerObservability      (B3.3 stdout)        默认开,FLOWER_VERBOSE=0 关
```

**关键 trade-off**:同一 event 名(如 `tool_call`)可挂多个 handler,按注册顺序**串行**调用;
任一返回 `{ block: true }` 即终止链 + 不执行工具。证据见
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` L623-L627:

> `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
> Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.

---

## B3.1 · LLM 调用链

### ASCII 流程图

```
flower-code-reviewer/run.ts:runReview
  ├─ buildPrompt({...})        → 拼好 system prompt + skill
  ├─ buildPiCliArgs({prompt})  → ["-p", prompt,
  │                               "--provider", "havefun-openai-responses",
  │                               "--model",    "gpt-5.5",
  │                               "--thinking", "high"]
  └─ piMain(argv, { extensionFactories: [extensionFactory] })
              │
              ▼
node_modules/@earendil-works/pi-coding-agent/dist/main.js: main()
  ├─ parseCli(args) → 拿到 provider/model/thinking
  ├─ createAgentSessionServices({ extensionFactories })
  │      ↳ 调 extensionFactory(pi) ← 触发 7 个 register*()
  │         registerHavefunProviders → 4× pi.registerProvider("havefun-*", {...})
  │         每个 provider 挂"nativeApi 与协议一致"的模型子集
  ├─ createAgentSessionFromServices(...)
  └─ runPrintMode(runtime, { mode:"text", initialMessage: prompt })
              │
              ▼
pi 内部 turn loop (~推测,见 .d.ts event 列表)
  for each turn:
    emit turn_start
    用 ModelRegistry 解析 (provider, modelId) → Model<Api>
    调 pi-ai streamSimple(model, context, options) ← api-registry.d.ts L1-L7
      ↳ 按 model.api 路由到对应 ApiProvider:
        anthropic-messages    → providers/anthropic.js
        openai-responses      → providers/openai-responses.js
        google-generative-ai  → providers/google.js
        openai-completions    → providers/openai-completions.js
    emit before_provider_request {payload}
    fetch(baseUrl+path, { headers: { "X-App-Source":"code-reviewer", ... } })
    emit after_provider_response {status, headers}
    流式 SSE → emit message_update (多次)
              │ HTTPS
              ▼
   havefun 网关 (LLM_BASE_URL,如 https://jp-ai.havefun.eu.cc)
              │
              ▼
   上游 LLM (Anthropic / OpenAI / Gemini upstream)
```

### 每步实际代码位置

| 步骤 | 文件 | 函数 |
|---|---|---|
| 拼 argv | `packages/flower-providers/src/runtime.ts` | `buildPiCliArgs` |
| fallback 决策 | `packages/flower-providers/src/env.ts` | `getLLM(Provider/Model/ReasoningEffort)OrDefault` |
| 调 piMain | `packages/flower-code-reviewer/src/run.ts` | `runReview` 内 `await piMain(piArgv, ...)` |
| pi 入口 | `node_modules/@earendil-works/pi-coding-agent/dist/main.js` | `main(args, options)` |
| provider 注册 | `packages/flower-providers/src/register.ts` | `registerHavefunProviders` |
| baseUrl 拼后缀 | `packages/flower-providers/src/env.ts` + `catalog.ts` | `resolveProviderBaseUrl` + `PROVIDER_PATH_SUFFIX` |
| pi → upstream 发请求 | `node_modules/@earendil-works/pi-ai/dist/providers/*.js` | 各家 `streamSimple` (~推测,minified) |
| api 路由表 | `node_modules/@earendil-works/pi-ai/dist/api-registry.d.ts` | `getApiProvider(api)` |

### 关键 trade-off

1. **CLI 路径 vs SDK 路径**:`buildPiCliArgs`(reviewer 形态)缺省兜底降低业务方接入门槛;
   `buildHavefunModel`(ops-bot 形态)缺省 fail-fast 强制运维显式配齐。
2. **显式传 `--provider --model --thinking`**:`runtime.ts` 注释明示:pi 内置 modelRegistry
   可能与 builtin 撞 id(如 `gpt-5.5`)→ 不显式传 provider 会被默认 provider 截胡;
   不显式传 `--thinking` 会被 pi 内置 `DEFAULT_THINKING_LEVEL=medium` 取代。
3. **每个 provider 独立 baseUrl 后缀**(`catalog.ts:PROVIDER_PATH_SUFFIX`):
   `havefun-openai` / `havefun-openai-responses` → 根 + `/v1`;
   `havefun-anthropic` → 根(无后缀,Anthropic SDK 自己拼 `/v1/messages`);
   `havefun-gemini` → 根 + `/v1beta`。
4. **失败传播**:`piMain` 抛错 → `runReview` catch → `isLlmFailure(err)` 判定:
   LLM 失败 → fail open(exit 0 + warning 评论);GitLab API 错 / 配置错 → 抛到 cli.ts → exit 2。

### 数据形态

```typescript
// 1. argv (string[])
["-p", "<built prompt>", "--provider", "havefun-openai-responses",
 "--model", "gpt-5.5", "--thinking", "high"]

// 2. pi ProviderConfig(packages/flower-providers/src/register.ts L79-L88)
{
  baseUrl: string;             // 如 "https://jp-ai.havefun.eu.cc/v1"
  apiKey: "LLM_API_KEY";       // 字符串字面量,pi 从 env 解析(避免明文 key)
  api: Api;                    // 4 个 LLM 协议之一
  models: ProviderModelConfig[]; // 按 nativeApi 过滤后的模型清单
  headers: { "X-App-Source": "code-reviewer" };
}

// 3. pi-ai streamSimple 入参(api-registry.d.ts L1-L7)
type ApiStreamSimpleFunction =
  (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
```

### 源码链接

- `packages/flower-code-reviewer/src/run.ts` §`runReview`
- `packages/flower-providers/src/runtime.ts` §`buildPiCliArgs`
- `packages/flower-providers/src/register.ts` §`registerHavefunProviders`

---

## B3.2 · tool dispatch(含 compliance 拦截)

### ASCII 流程图

```
pi 内部 turn N,LLM 输出 tool_use 块
  message_update.assistantMessageEvent.type = "toolcall_end"
              │
              ▼
pi emit "tool_call" (串行调用所有 handler;先返回 block 的截断后续)
event = { type:"tool_call", toolCallId, toolName, input }

  Handler #1: compliance/ci-readonly       (注册 #2)
    write|edit → return { block:true, reason:"CI 只读模式:禁止 write/edit" }
    bash → splitCommandChain(cmd)  // quote-aware,拆 ; && || |
           for seg: !BASH_ALLOW_LIST.test(seg)
                 → return { block:true, reason: buildBashBlockReason(firstWord) }
           全过 → return undefined

  Handler #2: compliance/audit             (同 registerCompliance call)
    void sendAudit({ kind:"tool_call", product, tool, inputKeys, ts })  → HTTPS POST(异步)

  Handler #3: review-trace                 (注册 #6)
    gitlab_get_file_content   → recordFileRead(path)
    gitlab_post_line_comment  → recordLineComment({file,line,severity,body})
    return undefined(不阻塞,仅观察)
              │
   ┌──────────┴──────────┐
   ▼                     ▼
任一 block:true       全 return undefined
   │                     │
   ▼                     ▼
pi 包成 tool_result    pi 调 ToolDefinition.execute(toolCallId, input)
(isError=true)            ↓
塞回 LLM 上下文        packages/flower-tools-gitlab/src/index.ts:6 个工具
LLM 看 reason 改路径    (gitlab_get_mr_diff / _get_mr_files / _post_comment /
                        _post_line_comment / _get_previous_review /
                        _get_file_content)
                          ↓
                       packages/flower-tools-gitlab/src/client.ts
                       gitlabClient().<verb>(...) + safeReadFile()
                          ↓ fetch
                       GitLab REST /api/v4/* (PRIVATE-TOKEN header)
                          ↓ JSON
                       工具 execute return { content, details }
                          ↓
                       pi emit "tool_execution_end" → 塞 tool_result 回 LLM
```

### 每步实际代码位置

| 步骤 | 文件 | 函数 |
|---|---|---|
| ci-readonly 拦截 | `packages/flower-compliance/src/index.ts` | `registerCiReadOnlyGuards` |
| bash 拆链(quote-aware) | 同上 | `splitCommandChain` |
| 白名单 regex + 替代建议 | 同上 | `BASH_ALLOW_LIST` / `buildBashBlockReason` / `SUGGESTION_BY_CMD` |
| SIEM 审计 hook | 同上 | `registerAudit` |
| trace 观察 | `packages/flower-code-reviewer/src/extension.ts` | `registerReviewTrace` |
| 6 个 GitLab 工具定义 + 注册 | `packages/flower-tools-gitlab/src/index.ts` | `gitlab*Tool` 系列 + `registerGitlabTools` |
| GitLab REST 客户端 | `packages/flower-tools-gitlab/src/client.ts` | `gitlabClient` + `gitlabFetch` |
| MR 文件安全读(50KB cap) | `packages/flower-tools-gitlab/src/safe-read.ts` | `safeReadFile` |
| event 类型 | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` | `ToolCallEvent` / `ToolCallEventResult` |

### 关键 trade-off

1. **handler 链注册顺序敏感**:`registerCompliance`(拦截)在 `registerReviewTrace` 之前 →
   trace 观察"放行后的 tool_call"(被拦的看不到)。run.ts 的"无依据评论" blocker 检查
   走 trace,不会漏判被拦截的工具。
2. **bash 拆链 + quote-aware**(`splitCommandChain`):拆 `;` / `&&` / `||` / `|`(unquoted);
   **不拆** `>` / `<` / `$()` / 反引号(信任 LLM,reviewer 评审场景不构造攻击)。
   例:`git status; env` → 两段都过 → `env` 拦;`rg "a|b" src` → quoted `|` 不拆。
3. **SIEM 上报 fail-open**:`sendAudit` 失败默认静默(`audit.ts` L47-L55),`DEBUG_AUDIT=1`
   才 warn。审计基础设施不反向定罪主流程,SIEM 抖动不刷屏 GitLab CI。
4. **input 不上报全量**:`registerAudit` 只上报 `inputKeys: Object.keys(event.input)`,
   不上传 value(`input.body` 可能含未脱敏代码 / reasoning)。
5. **trace 不阻塞**:`registerReviewTrace` 永远 return undefined。"无依据评论" blocker 不是
   在 tool_call 拦截抓的,而是 piMain 返回后,run.ts L310-L325 读 trace 对比 readFiles vs
   lineComments 出来的。
6. **被 block 的 tool_call 不被 audit**:`registerCompliance` 内拦截 handler 在 audit
   handler 之前注册;一旦 return block,后续 audit handler 不再触发。**未在源码注释里
   显式说明**,~以源码为准~。

### 数据形态

```typescript
// 1. ToolCallEvent(pi/dist/core/extensions/types.d.ts L628)
type ToolCallEvent =
  | { type:"tool_call"; toolCallId:string; toolName:"bash";  input:{command:string} }
  | { type:"tool_call"; toolCallId:string; toolName:"write"; input:WriteToolInput }
  | { type:"tool_call"; toolCallId:string; toolName:"edit";  input:EditToolInput }
  | { type:"tool_call"; toolCallId:string; toolName:string;  input:Record<string,unknown> };

// 2. ToolCallEventResult(L714)
interface ToolCallEventResult { block?:boolean; reason?:string }

// 3. GitLab 工具 execute 返回值
{ content: [{ type:"text", text:string }], details: { projectId, mrIid, severity, ... } }

// 4. review-trace 单例(packages/flower-code-reviewer/src/review-trace.ts L43-L48)
interface ReviewTrace {
  readFiles: Set<string>;
  lineComments: { file:string; line:number; severity:Severity; title:string }[];
}
```

### 源码链接

- `packages/flower-compliance/src/index.ts` §`registerCiReadOnlyGuards` / §`splitCommandChain` / §`registerAudit`
- `packages/flower-tools-gitlab/src/index.ts` §`registerGitlabTools`
- `packages/flower-code-reviewer/src/extension.ts` §`registerReviewTrace`

---

## B3.3 · observability 旁路

### ASCII 流程图

```
pi 内部 turn loop  (~推测,精确事件名见 .d.ts)
  for each turn:
    emit turn_start / before_provider_request / after_provider_response {status,headers}
    流式收 LLM 响应 ──→ 多次 emit message_update:
      assistantMessageEvent.type ∈
        thinking_start/delta/end | text_start/delta/end |
        toolcall_start/delta/end | done | error
    触发工具(同 B3.2)→ emit tool_execution_end {toolName,result,isError}
    emit turn_end {turnIndex,message,toolResults}
  最终:emit agent_end {messages}
              │
              ▼  (旁路监听,纯只读,不阻塞)
flower-code-reviewer/src/observability.ts → registerObservability(pi)
  isOff() 判定:FLOWER_VERBOSE ∈ {"","0","false","off","no"} → return;否则继续

  pi.on("turn_start", ev)
     console.log(`>>> 🤖 [turn ${ev.turnIndex}] start`)

  pi.on("message_update", ev) switch ev.assistantMessageEvent.type:
     thinking_start → write "\n💭 thinking: "      thinking_delta → write(ev.delta)
     thinking_end   → write "\n"                   text_start     → write "\n💬 assistant: "
     text_delta     → write(ev.delta)              text_end       → write "\n"
     toolcall_end   → log `🔧 [tool →] ${name} args=${truncate(...,400)}`
     其他类型       → 不打印

  pi.on("tool_execution_end", ev)
     log `${ev.isError?"🔧 [tool ✗ error]":"🔧 [tool ←]"} ${ev.toolName} result=${truncate(ev.result,300)}`

  pi.on("after_provider_response", ev)
     if ev.status >= 400: log `⚠️ [llm provider] status=${ev.status}`

  pi.on("turn_end", ev)
     log `>>> 🤖 [turn ${ev.turnIndex}] end · toolResults=${ev.toolResults.length}`

  pi.on("agent_end", _)
     log "\n>>> 🤖 [agent] session end\n"
              │
              ▼
        process.stdout
              │
              ▼
        GitLab CI job 日志 (pipeline trace)
```

### 每步实际代码位置

| 步骤 | 文件 | 函数 |
|---|---|---|
| FLOWER_VERBOSE 判定 | `packages/flower-code-reviewer/src/observability.ts` | `isOff` |
| 截断防爆日志 | 同上 | `truncate(value, max=400)`;tool_execution_end 用 max=300 |
| 注册所有事件监听 | 同上 | `registerObservability(pi)` |
| event 类型 | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` | `TurnStartEvent` / `MessageUpdateEvent` / `ToolExecutionEndEvent` / `AfterProviderResponseEvent` |
| AssistantMessageEvent 子类型 | `node_modules/@earendil-works/pi-ai/dist/types.d.ts` | `AssistantMessageEvent` union (~子类型从 switch case 反推) |

### 关键 trade-off

1. **默认开,显式关**:`FLOWER_VERBOSE` 未设 = 开;`0` / `false` / `off` / `no` /
   空字符串 才关。业务方零配置就能看到 trace。
2. **截断防 GitLab CI 日志爆炸**:`truncate(value, max=400)` + tool_execution_end 用
   `max=300`。`safeReadFile` 已经在工具层截断到 50KB,observability 再加一层防御。
3. **纯只读,不阻塞**:handler `return` 是 `void`,不返回 `{ block: true }`。
   回调内部 await 异常会被 pi 吃掉,不影响主流程。
4. **`after_provider_response` 只在 status >= 400 打**:正常 200 不刷屏,只在异常 warn。
   与 `isLlmFailure` 判定路径形成双重指示。
5. **stdout 直接 write(无 buffer)**:`process.stdout.write` 而非 `console.log` —
   thinking / text delta 是流式 token,需要立刻 flush 看到打字效果。

### 数据形态

```typescript
// pi/dist/core/extensions/types.d.ts L489-L539
interface TurnStartEvent       { type:"turn_start"; turnIndex:number; timestamp:number }
interface TurnEndEvent         { type:"turn_end"; turnIndex:number; message:AgentMessage; toolResults:ToolResultMessage[] }
interface MessageUpdateEvent   { type:"message_update"; message:AgentMessage; assistantMessageEvent:AssistantMessageEvent }
interface ToolExecutionEndEvent { type:"tool_execution_end"; toolCallId:string; toolName:string; result:any; isError:boolean }
interface AfterProviderResponseEvent { type:"after_provider_response"; status:number; headers:Record<string,string> }

// AssistantMessageEvent 子类型(observability switch case 反推 — 完整 union 见 pi-ai types.d.ts):
// thinking_start | thinking_delta{delta} | thinking_end
// text_start     | text_delta{delta}     | text_end
// toolcall_start | toolcall_delta        | toolcall_end{toolCall:{name,arguments}}
// done | error
```

### 源码链接

- `packages/flower-code-reviewer/src/observability.ts` §`registerObservability`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` §`TurnStartEvent` / §`MessageUpdateEvent`

---

## B3.4 · SIEM 审计

### ASCII 流程图

```
pi 内部 emit 三类事件 (audit 关心)
  session_start  { reason }
  tool_call      { toolName, toolCallId, input }
  tool_result    { toolName, isError, content }
              │
              ▼
flower-compliance/src/index.ts → registerAudit(pi, product)
  pi.on("session_start", ev) → void sendAudit({ kind:"session_start", product, reason:ev.reason, ts })
  pi.on("tool_call",     ev) → void sendAudit({ kind:"tool_call", product, tool:ev.toolName,
                                                inputKeys:Object.keys(ev.input??{}), ts })
                              return undefined  (不阻塞;阻塞由 registerCiReadOnlyGuards 负责)
  pi.on("tool_result",   ev) → void sendAudit({ kind:"tool_result", product, tool, isError:ev.isError, ts })
              │
              ▼
flower-compliance/src/audit.ts → sendAudit(record)
  const url = process.env.SIEM_INGEST_URL
  if (!url):
    if DEBUG_AUDIT === "1": console.log("[audit]", record)
    return  (本地 / 未配置 SIEM 时 fail-open)
  try:
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        ...record,
        user: process.env.USER ?? process.env.USERNAME ?? "unknown",
        host: process.env.HOSTNAME ?? "unknown"
      }),
      signal: AbortSignal.timeout(2000)   ← 2s 超时,不拖慢主流程
    })
  catch:  // 默认静默;DEBUG_AUDIT=1 才打单行 warn
              │ HTTPS POST(可达即丢,失败不重试)
              ▼
       SIEM 后端 (超出本 repo 范围)
              │
              ▼
     下游分析 / 告警 / 长期存储
```

### 每步实际代码位置

| 步骤 | 文件 | 函数 |
|---|---|---|
| 注册 3 个 audit hook | `packages/flower-compliance/src/index.ts` | `registerAudit` |
| 拼装 + 发 audit record | `packages/flower-compliance/src/audit.ts` | `sendAudit` |
| AuditRecord 接口 | 同上 | `AuditRecord` |
| 模式入口 | `packages/flower-compliance/src/index.ts` | `registerCompliance`(两种模式都开 audit) |
| reviewer 调用方 | `packages/flower-code-reviewer/src/extension.ts` | L26 `registerCompliance(pi, { mode:"ci-readonly", product:"code-reviewer" })` |

### 关键 trade-off

1. **fail-open 设计**:`sendAudit` 失败默认静默。SIEM 抖动不反向定罪 reviewer,
   reviewer 不因 audit 失败 fail pipeline;`DEBUG_AUDIT=1` 才打 warn 用于本地调试。
2. **2s 超时**:`AbortSignal.timeout(2000)` — 不拖慢主流程。reviewer 单次 turn 已经 10-30s 量级,
   audit 最多 2s 即丢弃。
3. **不上传 input value 全量**:只上报字段名(`["body","severity","file","line"]`)。
   `input.body` 可能含未脱敏代码片段 / LLM reasoning,不同企业 SIEM 合规域差异大,保守不上 value。
4. **session_start 不可阻塞**:`pi.on("session_start", ...)` 没有 result 类型,纯通知。
5. **production-readonly 模式同样开启 audit**:`registerCompliance` 不管模式都调
   `registerAudit`,只是 `ci-readonly` 额外开启 `registerCiReadOnlyGuards`。
   ops-bot 用 `production-readonly` — 工具本身已只读(不触发拦截),只产 audit 流。
6. **附加 user + host**:`sendAudit` 在 body 上拼 `user` + `host`。GitLab CI 环境对追责
   "哪个 job 在哪台 runner 跑"还有价值;本地开发对应开发者 username + 机器名。

### 数据形态

```typescript
// 1. AuditRecord 接口(packages/flower-compliance/src/audit.ts L13-L18)
interface AuditRecord { kind:string; product:string; ts:number; [key:string]:unknown }

// 2. session_start 上报 payload
{ kind:"session_start", product:"code-reviewer", reason:<SessionStartEvent.reason>, ts, user, host }

// 3. tool_call 上报 payload
{ kind:"tool_call", product:"code-reviewer", tool:"gitlab_post_line_comment",
  inputKeys:["file","line","body","severity"], ts, user, host }

// 4. tool_result 上报 payload
{ kind:"tool_result", product:"code-reviewer", tool:"gitlab_post_line_comment",
  isError:false, ts, user, host }
```

### 源码链接

- `packages/flower-compliance/src/index.ts` §`registerCompliance` / §`registerAudit`
- `packages/flower-compliance/src/audit.ts` §`sendAudit`

---

## 附录 · 4 条数据流相互关系

```
                  ┌─────── LLM 调用 (B3.1) ────────┐
                  │ prompt → pi-ai → havefun → up.  │
                  └────── pi turn loop 内交错触发 ──┘
                                  │
            ┌──────────┐          ▼           ┌──────────┐
            │  B3.2    │ ←─ tool_call event ─→│  B3.4    │
            │ dispatch │   多 handler 串行    │   SIEM    │
            │ GitLab   │   compliance 拦截    │  audit    │
            │ REST     │                       │ (fail-open)│
            └──────────┘                       └──────────┘
                                  │
                                  ▼ (旁路,不阻塞)
                            ┌──────────┐
                            │ B3.3 obs.│
                            │ stdout 流│
                            └──────────┘
```

关键 observations:

- **B3.1 与 B3.2 顺序串联**:LLM 先发,返回 tool_call 才触发 dispatch;LLM 失败由
  `isLlmFailure` 判定(`run.ts:isLlmFailure` L102-L129)。
- **B3.2 与 B3.4 共享 `tool_call` event**:multi-handler 同事件 — compliance 既有拦截
  handler 又有 audit handler。`registerCompliance` 内拦截 handler 先注册,audit 后,
  因此被 block 的 tool_call 不会进 audit(隐含行为,~未在源码注释说明~)。
- **B3.3 完全独立旁路**:只把 event 写 stdout,不参与决策;`FLOWER_VERBOSE=0` 可单关。
- **失败传播差异**:
  - B3.1 失败 → `runReview` catch + isLlmFailure 判 → exit 0 + warning(fail open)
  - B3.2 失败(工具 execute 抛) → 错误内容返给 LLM,LLM 自己重试 / 改路径
  - B3.3 失败 → pi 吃掉,无感知
  - B3.4 失败 → 静默(或 DEBUG_AUDIT=1 时 warn)

## Caveats / Not Found

- `pi 内部 turn loop` 的精确实现在 `node_modules/@earendil-works/pi-coding-agent/dist/core/*`
  minified `.js` 内;本文档**未**深入反推,只用 `.d.ts` 的 event 类型 + 我们 extension
  实际监听代码反推流程。precision 限于 "event 名 + payload 字段"。
- pi-ai 各家 LLM client 的 `streamSimple` 实现同样 minified;baseUrl 拼装规则以
  `flower-providers/catalog.ts:PROVIDER_PATH_SUFFIX` 的源码注释为权威依据。
- B3.3 的 `assistantMessageEvent.type` 列表来自 `observability.ts` switch case 反推;
  完整 union 以 `node_modules/@earendil-works/pi-ai/dist/types.d.ts:AssistantMessageEvent`
  为准(本调研未 dump 完整 union 全文)。
- "被拦截的 tool_call 不被 audit"是基于 `registerCompliance` 内部调用顺序观察出的隐含行为,
  ~未在源码 / 测试覆盖该顺序~。若上游 pi 改变 handler 短路语义,行为可能漂移。
