# 运行事件持久化与宿主旁路

## Scenario: 给运行进度增加需要保存或展示的信息

### 1. Scope / Trigger

- 触发：需要让宿主看到新的运行信息（工具目标、耗时、推理、进度等），或给 `RequestRecord` 增加字段。
- 约束来源：`SessionRunner.commit` 对每个通知都先 `store.save` 整份会话快照（含全部 messages），再按序通知观察者。Desktop 的 store 每次写临时文件并 `flush` 后改名，流式输出时每个 `text_delta` 都会触发一次整份写入。

### 2. Signatures

```ts
// packages/agent-runtime/src/types.ts
export interface ToolStep {
	toolCallId: string;
	toolName: string;
	target?: string;     // 宿主描述，最长 120 字符
	startedAt: number;   // 毫秒
	endedAt?: number;    // 收到工具结果后填写
	isError?: boolean;
}
RequestRecord += { steps?: ToolStep[]; startedAt?: number; endedAt?: number };
RuntimeEvent 公共头 += { at: number };            // commit 时刻
tool_started += { target?: string };
SessionGrant 公共部分 += describeTool?(toolName: string, args: unknown): string | undefined;
```

```js
// Desktop worker 的瞬时旁路（不经运行时）
send({ kind: "reasoning", sessionId, requestId, text }); // text ≤ 120 字符，节流 1 秒
```

### 3. Contracts

- 需要持久化的信息挂在已有的提交上：`started` 写 `startedAt`，终态写 `endedAt`（都在 `commit` 内与事件同批），`tool_started`/`tool_result` 在 `recordProgress` 里改 `record.steps`。不为它们新增提交。
- 不保存工具参数原文。`write_report.markdown` 等参数可达 64 KiB，只保存宿主描述出的短目标。
- `describeTool` 在 `tool_execution_start` 时同步调用；抛错、返回非字符串或空串视为无目标；结果截断到 120 字符。需要附件名等异步才能查到的信息，宿主应提前缓存（Desktop 在读取附件和读取历史时登记 `asset:` 编号与名称）。
- 只用于展示、不必重启后保留的信息（推理分片、进度句子）不得进入 `recordProgress`/`commit`，由宿主在模型流旁路处理：Desktop worker 按会话绑定 `streamFn`，在 `model-event` 中截取 `thinking_delta`，节流后直接发给 Host。摘要请求（`purpose: "summary"`）不旁路。
- 早期快照没有新字段：宿主读取时把 `steps` 视为空数组，缺少起止时间时不显示耗时。

### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 宿主未提供 `describeTool` | 照常记录步骤，`target` 缺省 |
| `describeTool` 抛错或返回非字符串 | 步骤无目标，工具执行与事件不受影响 |
| 目标超过 120 字符 | 按字符截断 |
| 重启时补记的中断（`restore`） | 不发事件，`endedAt` 保持缺省，未完成步骤无 `endedAt` |
| 取消排队中的请求 | 有 `endedAt`，没有 `startedAt` |

### 5. Good / Base / Bad Cases

- Good：工具步骤与起止时间随已有事件落盘，重启后宿主从 `history` 读回摘要；推理每秒最多一条旁路帧，`lastSequence` 等于运行时事件数。
- Base：宿主不提供描述，只看到工具名与状态。
- Bad：把 `thinking_delta` 做成新的 `RuntimeEvent` 并 `commit`，每个推理分片都整份写一次会话文件，且双宿主测试的事件序列断言失效。

### 6. Tests Required

- `packages/agent-runtime/test/context-window.test.ts`「工具步骤与起止时间」：断言目标截断到 120 字符、描述抛错时无 `target`、`steps[].endedAt >= startedAt`、`started`/`terminal` 事件的 `at` 等于记录的 `startedAt`/`endedAt`、所有事件都有数字 `at`；无钩子时仍记录步骤。
- `test/dual-host.test.ts`：事件类型序列保持 `queued, started, tool_started, tool_result, text_delta…, terminal`。
- Desktop `testing/reasoning-preview.test.mjs`：经真实 worker 子进程，断言推理帧按节流送达、`saved.lastSequence === events.length`、历史不含推理文本。
- Desktop `testing/context-continuity.test.mjs`：重启后历史行的 `steps` 目标为附件名。

### 7. Wrong vs Correct

#### Wrong

```ts
// 推理逐片提交：落盘次数与分片数相同
if (update.type === "thinking_delta") body = { type: "thinking_delta", delta: update.delta };
await this.commit(snapshot, [[record, body]]);
```

#### Correct

```js
// worker：只在宿主旁路累积并节流，运行时不感知
if (entry.session && frame.event.type === "thinking_delta") reasoning.push(entry.session, frame.event.delta);
```

---

## Scenario: 运行中插话（steer）

### 1. Scope / Trigger

- 触发：改动 `SubjectRuntime.steer`、`RuntimeExecution.steer`、`recordProgress` 的用户消息处理，或 `RequestRecord.steers` / `steered` 事件。
- 插话经 pi `agent.steer` 在当前 turn 结束后注入（最后一个 turn 结束时也会再走一轮），是第一个新增的事件种类，code-reviewer 不提供执行体 `steer`。

### 2. Signatures

```ts
SubjectRuntime.steer(sessionId, runId, steerId, input, attachments?): Promise<void>; // 已排入执行体即兑现
RuntimeExecution.steer?(input: string, attachments?: readonly RuntimeAttachment[]): Promise<void>;
RequestRecord.steers?: SteerRecord[]; // { steerId, input, attachments?, at, textOffset }
RuntimeEvent += { type: "steered"; steerId: string };
```

### 3. Contracts

- 校验在串行区内完成：请求必须是 `running` 且 `active.runId` 匹配、执行体已装配并提供 `steer`、`steerId` 未在待送达或已送达中出现。附件读取与 `execution.steer` 在串行区外执行，避免阻塞进度提交（pi 逐个 await 监听器）。
- 多条插话经 `active.steerTail` 按提交顺序逐条排入执行体，保证执行体队列顺序与 `active.steering` 一致；排入失败时移出 `steering` 并拒绝。
- 送达识别：每轮第一条用户 `message_start` 是请求本身（`active.prompted`），其后的用户 `message_start` 按顺序对应 `steering` 队首。送达时在同一次提交中追加 `steers[]`（`textOffset = record.text.length`）并发出 `steered`，不另起提交。
- 运行已取消（`controller.signal.aborted`）后 pi 仍可能在工具失败后注入排队的插话，此时不算送达：不出队、不写记录、不发事件。宿主据此在终态时判定未送达。
- 运行成功后插话已在 pi 消息序列中，随 `messages` 进入后续上下文；`userMessageIndex` 仍指本轮首条用户消息。失败、取消、中断的请求即使已送达插话，其正文也不进入上下文。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 运行已结束或 `runId` 不是当前运行 | `RuntimeError("invalid-input", "当前运行已结束，无法插话")` |
| `runId` 不存在 | `RuntimeError("not-found")` |
| 执行体未提供 `steer`（如 code-reviewer 的 `createExecution`） | `RuntimeError("invalid-input", "当前运行不支持插话")`，当前运行不受影响 |
| 重复的 `steerId` | `RuntimeError("invalid-input", "这条插话已经提交")` |
| 附件读取失败或纯文本模型收到图片 | 拒绝并移出待送达，`RuntimeError` 说明原样交给宿主 |
| 送达前取消、失败或重启 | 不记录、无 `steered`，宿主负责放回 |

### 5. Scenarios and Examples

- Normal：工具执行中插话 → 工具结果后下一次模型调用的最后一条用户消息是插话 → `steered` 位于 `tool_result` 之后、`terminal` 之前，记录 `textOffset` 等于此前已输出正文长度。
- Base：插话后立刻取消 → `cancelled`，记录没有 `steers`，事件中没有 `steered`。
- Incorrect use：按 `message_start` 角色为 user 就出队，把请求自身的提示当作第一条插话，或在取消后仍记为送达。
- Correct handling：跳过本轮首条用户消息，并在 `signal.aborted` 后直接返回。

### 6. Tests Required

- `packages/agent-runtime/test/context-window.test.ts`「运行中插话」：送达位置、附件读入、重复与已结束拒绝；送达前取消不记录；`createExecution` 执行体拒绝。
- `packages/agent-runtime/test/dual-host.test.ts`「企业宿主运行中插话」：读取闸点期间插话，`steered` 送达且事件序号连续，记录含插话，模型最后一次调用含插话原文。

---

## Scenario: 手动压缩（compact）

### 1. Scope / Trigger

- 触发：改动 `SubjectRuntime.compact`、`context-window.ts` 的 `compactHistory`，或宿主在时间线中推导压缩位置。

### 2. Signatures

```ts
SubjectRuntime.compact(sessionId: string, signal?: AbortSignal): Promise<boolean>; // true 表示写入了新检查点
export async function compactHistory(model, stream, history, checkpoint, signal): Promise<ContextCheckpoint | undefined>;
```

### 3. Contracts

- 只对原生 `model` 授权生效；会话有活动运行或排队请求时拒绝。开始时占用 `active`（`runId = "compact:<uuid>"`），期间提交的请求只入队，结束后清除并 `schedule()`。
- 摘要从现有 `through` 归纳到 `modelMessages(history)` 非系统部分的末尾，与已有摘要滚动合并，结果 `through = body.length`。没有新增可归纳的消息时不调用模型，返回 `false`。
- 只写回 `contextCheckpoint`，`commit(snapshot, [])` 不发事件，不改 `requests` 与 `messages`。
- 宿主推导压缩位置：`through` 与成功请求的 `userMessageIndex`（旧记录用消息上的 `flowerRequestId`）在 `snapshot.messages` 的同一下标空间；第一条 `index >= through` 的成功请求之前，或全部已归纳时最后一条成功请求之后。任一成功请求无法定位时不显示。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `createExecution` 授权 | `RuntimeError("invalid-input", "当前宿主不支持手动压缩")` |
| 有活动运行或排队请求 | `RuntimeError("invalid-input", "会话正在运行，结束后再压缩")` |
| 调用方取消 | `RuntimeError("invalid-input", "已取消压缩，原上下文保留")`，检查点不变 |
| 摘要失败 | `RuntimeError("agent-error", <摘要错误说明>)`，检查点不变 |

### 5. Scenarios and Examples

- Normal：两轮后压缩 → `true`，下一轮请求以「此前会话的检查点」开头，不再包含第一轮原文；再次压缩 → `false` 且不调用模型。
- Incorrect use：在串行区内直接 await 摘要，压缩期间的提交、历史查询全部卡住，宿主 20 秒调用超时会把工作进程判为失去响应。
- Correct handling：串行区内只做校验与占位，摘要在区外执行，结束时再进串行区写回并释放活动位；宿主为压缩调用单独放宽超时。

### 6. Tests Required

- `packages/agent-runtime/test/context-window.test.ts`「手动压缩」：全量归纳与续接、无新对话不调用模型、失败与取消保留检查点、压缩期间提交的请求排队并在之后完成、运行中与 `createExecution` 拒绝。
