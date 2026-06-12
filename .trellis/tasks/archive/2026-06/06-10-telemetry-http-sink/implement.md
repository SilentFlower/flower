# implement.md — flower-telemetry httpSink

## Implementation Checklist

- [ ] Step 1 `flower-telemetry/src/sinks/http.ts`:httpSink 本体
      (入队即序列化 / stream 过滤 / batchSize+flushIntervalMs 触发 / 单飞行请求 /
      失败留缓冲 / maxBufferedEvents 丢最旧 / AbortSignal.timeout / fail-open / flush 收口)
- [ ] Step 2 `flower-telemetry/src/__tests__/http.test.ts`:
      批量触发(条数/间隔)、stream 过滤、Bearer 头、失败重试入缓冲、
      缓冲上限丢最旧、flush 等待在途+清空缓冲、fetch 抛错/超时不抛出、
      NDJSON 行与 `JSON.stringify(event)` 逐字节一致
- [ ] Step 3 R4:`siem.ts` projectAuditRecord 四类投影补 `traceId`;
      `siem.test.ts` 断言同步
- [ ] Step 4 `index.ts` 导出 httpSink/HttpSinkOptions;`types.ts:7` 注释补 httpSink
- [ ] Step 5 `flower-code-reviewer/src/telemetry-setup.ts` 挂载逻辑 + doc 注释;
      `telemetry-setup.test.ts` 增配置/未配置用例
- [ ] Step 6 文档:`.env.example`、flower-telemetry README、flower-code-reviewer README
- [ ] Step 7 changeset ×2(flower-telemetry minor;flower-code-reviewer patch)

## Validation

- `npm run check`(biome,根目录)
- `npm run typecheck`
- `npm test`(workspaces vitest;或单包 `npm test -w packages/flower-telemetry`)

## Review Gates

- 开工前:前置任务 `06-10-flower-telemetry-pipeline` 的 PR 已合入 main,
  本任务从最新 main 开新分支(避免基于未合入分支叠加)
- 完成后:trellis-check-all(对照本三件套);commit/push 走 trellis-push
