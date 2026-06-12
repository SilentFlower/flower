# Sink Guidelines

> `TelemetrySink` 实现约定(fail-open / 绝不抛错)与 httpSink 客户端线协议要点。

---

## Sink 接口契约(`types.ts`)

```typescript
interface TelemetrySink {
	name: string;                                  // 故障诊断标识
	critical?: boolean;                            // critical sink 不受 FLOWER_TELEMETRY=0 总开关影响
	onEvent(event: TelemetryEvent): void;          // 同步入口,绝不抛错
	flush?(): Promise<void>;                       // run 结束统一冲刷,绝不抛错
}
```

- `onEvent` 是**同步**方法:慢 IO(网络 / 磁盘)必须缓冲后异步处理,不能阻塞 emit 调用方
- pipeline 对每个 sink 调用都套 try/catch(`warnSinkFailure`),但 sink 自身仍应吞掉内部异步异常——
  pipeline 兜不住脱离调用栈的 Promise rejection
- `flush` 由 `pipeline.flush()` 经 `Promise.allSettled` 调用,单 sink 失败不影响其余 sink

## fail-open 姿态(全 sink 统一)

- **失败默认完全静默**(不刷屏 CI 日志),`DEBUG_TELEMETRY=1` 才打**单行** warn;
  错误信息附 `cause.code`(如 `ECONNREFUSED`)便于定位:

```typescript
// sinks/http.ts warnFailure / sendBatch
let msg = err instanceof Error ? err.message : String(err);
const code = (err as { cause?: { code?: string } })?.cause?.code;
if (code) msg += ` (${code})`;
```

- 网络请求一律 `AbortSignal.timeout(...)` 限时(http / siem 默认 2000ms),防观测端点抖动 hang 住主流程
- 观测数据**可丢,内存不可涨**:缓冲必须有上限,超限丢最旧(仅首次丢弃 DEBUG 提示)

## httpSink 客户端线协议(`sinks/http.ts`)

服务端实现要点见 [flower-observer backend ingest 指南](../../flower-observer/backend/ingest-guidelines.md)。

### 行格式 = jsonlSink 的网络孪生

- 每事件一行 `JSON.stringify(event)`,**入队即序列化**,保证与 JSONL 落盘逐字节一致;
  服务端用同一个解析器消费 HTTP 推送与文件导入两种来源
- 请求体为 NDJSON(`Content-Type: application/x-ndjson`),批末带换行
- 事件信封自带 `(traceId, seq)`,服务端按其幂等去重 → **重发不会写重**,客户端无需感知

### 批量与 drain 循环

- 缓冲达 `batchSize`(默认 50)立即发送;否则距上次发送超 `flushIntervalMs`(默认 2000ms)由**下一事件**触发——
  **不引入定时器**,避免挂住进程退出;尾部由 `flush()` 收口
- **单 drain 循环**:同一时刻最多一个 POST 在途(保序、简单),在途期间事件继续入缓冲
- `flush()` 置 `flushing` 标记抑制新 drain,等在途循环收尾后独占直发剩余缓冲

### 失败语义

- 非 2xx 或异常:**整批放回缓冲头**(它们仍是最旧的一批),等满一个间隔随下次触发重试
- **无进展即停**(一轮发送后缓冲未减少 = 整批失败回灌,立即退出 drain)——不对故障端点热重试
- `lastSendAt` 成败都更新:失败后等满一个间隔再试
- 缓冲超 `maxBufferedEvents`(默认 2000)丢最旧
- 鉴权可选:配置 `token` 时附 `Authorization: Bearer <token>`

### stream 事件不推送

```typescript
onEvent(event: TelemetryEvent): void {
	if (event.kind === "stream") return;   // 纯显示信号,且 thinking/text delta 不脱敏,推出去会泄 secret
	...
}
```

## Common Mistakes

- ❌ `onEvent` 里直接 `await fetch(...)` 或抛错(观测通道反向阻塞 / 击穿业务主流程)
- ❌ 失败时 `console.error` 常开刷屏(必须默认静默,`DEBUG_TELEMETRY=1` 才单行 warn)
- ❌ 用 `setInterval`/`setTimeout` 做批量定时(定时器挂住进程退出;用"下一事件触发 + flush 收口"代替)
- ❌ 失败后立即原地重试(热重试放大故障;整批回灌等下个间隔)
- ❌ 缓冲无上限(观测数据可丢,内存不可涨)
- ❌ 先截断再脱敏(截断可能把 secret 切半逃过正则;顺序必须 redact → truncate)
- ❌ 新 sink 把 `stream` 事件外发(delta 未脱敏)
- ❌ 随手把新 sink 标成 `critical: true`(critical 仅限审计类"不可关"通道,会绕过用户的总开关)
