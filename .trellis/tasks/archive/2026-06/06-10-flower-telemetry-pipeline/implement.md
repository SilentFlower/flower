# implement.md — flower-telemetry 管道与 sink 体系

## Implementation Checklist

按依赖顺序执行;每步完成即可独立 typecheck。

### Step 1:新包骨架

- [x] `packages/flower-telemetry/`:package.json(`@flower-ai/flower-telemetry`,依赖 `@earendil-works/pi-coding-agent`,devDep vitest)、tsconfig.json、LICENSE、README.md —— 以 flower-compliance 为模板抄
- [x] 根 `tsconfig.json` references 增加 `./packages/flower-telemetry`(放在 flower-compliance 之后、两个产品之前)
- [x] `npm install` 刷新 workspaces 链接

### Step 2:telemetry 内核(与 pi 解耦部分)

- [x] `src/types.ts`:TelemetryEventBase / TraceStartEvent / SpanEvent / OutcomeEvent / TraceEndEvent / TelemetrySink(字段按 design.md 显式声明)
- [x] `src/redact.ts`:secret 正则集(glpat / Bearer / AKID+AKSK / PRIVATE KEY 块 / URL 凭证 / token 赋值)+ `redactText()` + `truncateText()`;**先 redact 后 truncate**
- [x] `__tests__/redact.test.ts`:每条正则正例(被替换)+ 反例(普通文本不动)+ 截断边界
- [x] `src/pipeline.ts`:TelemetryPipeline(seq 递增、redact/truncate 应用、sink fanout try-catch、`flush()` 聚合、`FLOWER_TELEMETRY=0` 时跳过非 critical sink)
- [x] `__tests__/pipeline.test.ts`:fanout 顺序、单 sink 抛错不影响其他 sink、critical 豁免总开关、flush 全调用

### Step 3:三个内置 sink

- [x] `src/sinks/jsonl.ts`:append 行写 + flush;路径不可写时降级 warn(不抛)
- [x] `src/sinks/siem.ts`:迁移 `flower-compliance/src/audit.ts` 逻辑;metadata-only 投影(tool_call→inputKeys;新增 tool_blocked;trace_start→session_start);payload 字段与旧 sendAudit 兼容;fail-open + 2s 超时 + DEBUG_AUDIT 行为保留
- [x] `__tests__/siem.test.ts`:迁移并扩展原 `audit.test.ts` 110 行(URL 缺省静默 / DEBUG_AUDIT 打印 / 失败不抛 / **断言 payload 无 input 值** / tool_blocked 投影)
- [x] `src/sinks/console.ts`:迁移 `observability.ts` 374 行的格式化与 turn 计时;`format:"pretty"|"json"`;json 每行含 traceId/seq
- [x] `__tests__/console.test.ts`:pretty 关键行(工具调用/截断/计时)快照级断言;json 行可 parse 且含 traceId

### Step 4:pi adapter

- [x] `src/pi-adapter.ts`:`registerTelemetry(pi, {product, traceId?, sinks})`;订阅 session_start / agent_start / turn_start / before_provider_request / after_provider_response / message_update / tool_call / tool_execution_start|end / turn_end / agent_end(**不订阅 before_agent_start**,prompt 不落 trace — 决策见 design.md 补充记录);correlation 从 CI env 读取缺省容忍;导出 `recordSecurityEvent`(onBlock 接线用)与 `getTelemetryPipeline`(run.ts 用)
- [x] `src/index.ts` 汇总导出;`__tests__/pi-adapter.test.ts`:mock pi 事件 → 断言归一化事件序列

### Step 5:compliance 瘦身(breaking)

- [x] `src/index.ts`:options 增加 `onBlock?`;三处拦截 return 前回调(write/edit、bash 白名单、空命令);回调包 try-catch(回调抛错不影响拦截)
- [x] 删除 `src/audit.ts`、`registerAudit`、`sendAudit` 导出、`__tests__/audit.test.ts`(已迁 Step 3)
- [x] `__tests__/index.test.ts`:删审计断言;增 onBlock 断言(拦截回调一次/放行不回调/回调抛错仍拦截);拦截行为测试保持全绿
- [x] package.json 去掉不再需要的依赖(若 audit 是唯一 fetch 使用方,无依赖变化则跳过);README 重写为"纯策略包"

### Step 6:code-reviewer 接线

- [x] 新增 `src/telemetry-setup.ts`:装配 sinks(consoleSink 按 FLOWER_VERBOSE / jsonlSink 按 FLOWER_TELEMETRY_FILE 缺省 `flower-review-trace.jsonl` / siemSink critical)
- [x] `extension.ts`:registerTelemetry 提到 registerCompliance 之前;compliance 传 `onBlock: recordSecurityEvent`;删 registerObservability 调用
- [x] 删除 `src/observability.ts`(逻辑已迁 console sink;若 __tests__ 有对应测试同步迁移)
- [x] `run.ts` finalize:trace 产物 → outcome(line_comment×N / self_check / run_summary)+ trace_end + `await flush()`(在 exitCode 决定之后、return 之前)
- [x] package.json 增加 `@flower-ai/flower-telemetry` 依赖;tsconfig references 同步

### Step 7:文档与发布

- [x] `.gitlab-ci.example.yml`:artifacts 注释示例(JSONL 路径)+ FLOWER_TELEMETRY_FILE 变量说明
- [x] README ×4:telemetry 新包(架构图+sink 表+env 表)/ compliance(瘦身后职责)/ code-reviewer(env 表增 FLOWER_TELEMETRY*)/ 根 README(包清单、"接通审计"路线图措辞更新)
- [x] changeset:flower-telemetry minor(新包)、flower-compliance minor(breaking options)、flower-code-reviewer patch

## Validation

```bash
npm run build        # tsc --build 全仓
npm run typecheck
npm run check        # biome
npm run test         # vitest 全 workspaces
```

手工验证(可选,本地无 GitLab 时跳过):`DEBUG_AUDIT=1 FLOWER_TELEMETRY_FILE=/tmp/t.jsonl` 跑一次 dry 评审,检查 JSONL 行序与 console 输出。

## Review Gates

- 开工前:本三件套经用户确认(brainstorm Step 8)→ `task.py start` → trellis-route(implement)
- Step 5 完成后:compliance 拦截测试必须全绿才进 Step 6(策略行为零回归是底线)
- 全部完成后:trellis-check-all(提交前综合检查)
