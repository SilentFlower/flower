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
