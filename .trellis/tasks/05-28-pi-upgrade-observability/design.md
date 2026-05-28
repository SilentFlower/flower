# 升级 pi 依赖并增强首字耗时观测

## 技术设计

### 依赖边界

项目直接消费三类 pi 包:

- `@earendil-works/pi-coding-agent`: code-reviewer CLI 路径、扩展 API、`defineTool`
- `@earendil-works/pi-ai`: provider/model 类型、`streamSimple`、`ThinkingLevel`、`ThinkingBudgets`
- `@earendil-works/pi-agent-core`: ops-bot 的 `Agent`、`AgentMessage`

升级目标为 `0.76.0`。升级应统一处理所有 workspace 的直接依赖声明,避免同一 lockfile 内出现多个 pi minor 版本。根 `package.json` 的 `engines.node` 应与 pi 包 engine 要求对齐到 `>=22.19.0`,因为当前锁定的 `0.75.3` 已经要求该版本,这不是 `0.76.0` 新增风险。

### Node / Docker

当前 Dockerfile 使用 `node:22-alpine` 浮动标签。实施时优先做两件事:

- 根 `engines.node` 改为 `>=22.19.0`。
- Dockerfile 是否固定到 `node:22.19-alpine` 或更高 patch 版本,由实施阶段根据可用镜像与项目偏好决定。若保留 `node:22-alpine`,需要在最终说明中标注其满足最低要求但构建不可完全固定。

### 首字耗时指标

现有 turn timing 以 `turn_start.timestamp` 为本轮起点。新增字段:

- `firstTextDeltaMs`: 第一次出现非空 `text_delta` 的绝对时间戳。

派生指标:

- `first_text_delta_ms = firstTextDeltaMs - turnStartMs`
- `first_text_delta_after_provider_ms = firstTextDeltaMs - providerLastResponseMs`

现有字段保留:

- `first_agent_message_event_ms`: 任意 `message_update` 首次出现。它用于判断模型是否先输出 thinking / toolcall 等事件。
- `first_agent_message_after_provider_ms`: 响应头之后到任意 agent 事件的耗时。

### 日志形态

turn end 摘要保留一行输出,避免 CI 日志膨胀。建议采用“中文说明(字段名)=值”的混合格式,例如:

```text
>>> 🤖 [turn 0] end · 本轮总耗时(duration_ms)=1234 · provider请求开始(first_provider_request_ms)=10 · provider响应头(provider_response_headers_ms)=800 · 首个流式事件(first_agent_message_event_ms)=820 · 首字(first_text_delta_ms)=1300 · 响应头到首字(first_text_delta_after_provider_ms)=500 ...
```

这样既能给人读,也能用 `first_text_delta_ms=` grep。

### 边界行为

- `text_delta` 的 `delta` 为空字符串时不记录首字。
- 只输出 thinking / toolcall 的 turn,首字字段输出 `n/a`。
- provider 没有响应头时,`first_text_delta_after_provider_ms` 输出 `n/a`。
- 多次 provider request 的 turn 沿用现有 `providerLastResponseMs` 语义:计算最近一次 provider response headers 到首字。若首字发生在 earlier provider 之后,实施时可考虑记录 `providerResponseAtFirstTextDeltaMs`,但 MVP 先与现有字段保持一致。

## 发布与回滚

- 升级依赖和观测日志均为内部工程行为,不改变业务 API。
- 若升级后运行异常,可回滚 pi 依赖声明和 lockfile 到 `0.75.3`。
- 新增日志字段为 additive change,回滚只需移除新增 timing 字段和测试断言。
