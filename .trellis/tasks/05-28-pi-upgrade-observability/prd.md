# 升级 pi 依赖并增强首字耗时观测

## 目标

升级项目内 `@earendil-works/pi-*` 依赖,明确 Node 运行时基线是否需要调整,并增强 `flower-code-reviewer` 在 GitLab CI 日志里的 LLM 流式耗时观测能力。用户希望日志能区分 provider 请求、响应头、首个 agent 事件、首个文本 delta 等不同节点,并带中文说明,便于定位“等待首字慢”到底发生在哪一段。

## 背景与已知上下文

- 当前 lockfile 中 `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core` 均为 `0.75.3`。
- 上游 `0.75.4` / `0.75.5` / `0.76.0` 已发布;`0.76.0` 是当前 latest,也是本任务目标版本。
- 当前各 workspace 的 pi 依赖声明为 `^0.75.0`;按 semver 只会自动接受 `0.75.x`,不会自动升级到 `0.76.0`。
- pi 包从当前 `0.75.3` 已要求 `node >=22.19.0`;项目根 `package.json` 仍声明 `node >=22.0.0`,存在运行时基线不一致。
- 当前 Dockerfile 使用 `node:22-alpine` 浮动标签;通常能拿到足够新的 Node 22,但构建不可完全可重复。
- `packages/flower-code-reviewer/src/observability.ts` 已记录:
  - provider request start
  - provider response headers
  - `first_agent_message_event_ms`
  - `first_agent_message_after_provider_ms`
  - tool ready / tool execution / turn / agent 总耗时
- 当前 `first_agent_message_event_ms` 是任意 `message_update` 首次出现,可能是 `thinking_start` / `thinking_delta` / `text_start` / `toolcall_*`,不是严格的首个文本 delta。
- pi 扩展事件 `message_update.assistantMessageEvent` 支持 `text_delta`,可在仓库侧记录首个非空文本 delta 时间。

## 需求

- 依赖升级:
  - 统一升级项目内所有直接声明的 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core` 版本范围。
  - 更新 lockfile,确保实际安装版本与目标版本一致。
  - 目标版本为 `0.76.0`。
- Node 基线:
  - 明确项目声明的 Node 最低版本是否应提升到 `>=22.19.0`。
  - 如提升,同步检查 Dockerfile / README / CI 示例中是否需要体现该要求。
  - 不强行改业务运行逻辑来绕过上游 pi 包的 Node engine 要求。
- 首字耗时观测:
  - 在 `flower-code-reviewer` 的 verbose 日志中新增首个非空 `text_delta` 观测。
  - 在 turn 结束摘要中输出至少以下中文说明:
    - 本轮总耗时
    - provider 请求开始延迟
    - provider 响应头耗时
    - 首个 agent 流式事件耗时
    - 首个文本输出/首字耗时
    - 响应头到首字耗时
    - 首个工具调用就绪耗时
  - 字段名仍应保留机器可读形态,便于 grep / 日志平台检索。
  - 中文说明应简洁,避免让 GitLab CI 日志过度膨胀。
- 兼容性:
  - 保持 `FLOWER_VERBOSE=0/false/off/no` 关闭观测日志的行为。
  - 对没有文本输出、只调用工具或只输出 thinking 的 turn,首字相关字段应显示 `n/a`,不能误报。
  - 不改变 LLM provider 注册、工具注册、评论发布等业务流程。

## 验收标准

- [ ] 所有直接 pi 依赖声明与 `package-lock.json` 中的实际安装版本已对齐到选定目标版本。
- [ ] 根 `package.json` 的 Node engine 与 pi 包实际最低 Node 要求一致,或 PRD/实现说明中有明确不调整理由。
- [ ] `flower-code-reviewer` 日志能区分 `first_agent_message_event_ms` 与首个非空 `text_delta` 的耗时。
- [ ] turn end 摘要包含中文备注 + 机器可读字段,说明各耗时节点含义。
- [ ] 无文本输出场景不会把 thinking / toolcall 误记为首字。
- [ ] 相关单元测试覆盖新增耗时字段和中文说明。
- [ ] 构建、测试、类型检查中与本任务相关的质量门通过;如现有全局命令有历史问题,需说明替代验证命令与原因。

## 非目标范围

- 不重写 pi 上游 SSE parser。
- 不修改上游 `@earendil-works/pi-*` 包源码。
- 不为 ops-bot 新增完整流式观测面板;本任务只处理 code-reviewer 当前 CI 日志观测。
- 不引入新的日志采集系统或指标后端。

## 备注

- `prd.md` 只记录需求、约束和验收标准。
- 轻量任务可以只保留 PRD。
- 复杂任务在 `task.py start` 前需要补齐 `design.md` 技术设计与 `implement.md` 执行计划。
