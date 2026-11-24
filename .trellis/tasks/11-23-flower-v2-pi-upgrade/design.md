# 现有 Flower 宿主升级 pi 1.6.0

布局整理后的七个工作区是本次基线。先升级并验证 reviewer、ops-bot 和它们的依赖，Observer 复验观测入口。共享核心使用同组版本进入后续里程碑。当前仍采用应用自己的进程、工具、会话和参数契约。见[升级 PRD](prd.md)和[布局验收](../11-23-flower-v2-layout/verification.md)。

## 版本与预检证据

2026-11-23 复核 npm 的 `latest`，`pi-ai`、`pi-agent-core`、`pi-coding-agent` 和 `pi-schema` 均为 `1.6.0`，Node 下限为 `22.19.0`。现有直接依赖涉及 reviewer、ops-bot、providers、GitLab、compliance、telemetry 六个包。升级时这些直接使用的 pi 包固定到 `1.6.0`，由锁文件固定同组传递依赖。Observer 的 telemetry 构建依赖按当前边界处理。[npm 官方包元数据](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/1.6.0)

`/tmp/flower-pi-1.6.0-preflight-mf4738fp` 中的 `install.log` 记录了隔离目录的安装成功。`build.log` 是旧源码配 1.6.0 的失败证据，显示 `Type` 和 `streamSimple` 顶层导出消失、`ExtensionToolContext` 的测试桩缺字段，以及 GitLab 文件读取分支的 `details` 类型推导冲突。预检副本中的 `node_modules/@earendil-works` 包含下述声明、实现和发布说明。正式实现后再运行完整验收。

## 工具 schema 与评论

`pi-coding-agent` 的 `dist/core/extensions/types.d.ts` 仍用 `typebox` 的 `TSchema` 和 `Static` 声明 `defineTool`。随包 changelog 的 1.5.0 条目和 `docs/extensions.md` 说明，执行时由 `@earendil-works/pi-schema` 验证 JSON Schema。隔离类型探针确认，直接把 `pi-schema` 的 `obj()` 传入当前 `defineTool` 时，执行参数推导成 `unknown`。使用 TypeBox 的 `Object`、`String` 等构造器可保留推导。

因此 reviewer 的自审工具和 GitLab 工具直接声明与 coding-agent 同版使用的 `typebox@1.3.27`。保留现有字段、约束、说明和返回形状，由 1.6.0 的 pi-schema 运行时执行验证。现有 schema 的数值转换、可选字段及三档严重程度用真实工具调用核验。根据实际分支给文件读取结果显式标注共同类型，保留成功和错误正文。单测桩对齐 `ExtensionToolContext` 的 `tools` 和 `executeTool`。整体与行内评论继续共用 GitLab 包内的 `sanitizeQuickActions`。

## 模型选择和流式请求

- reviewer 保留 `pi.registerProvider` 和显式 `--provider`、`--model`、`--thinking`。继续使用 Flower 的四个 `havefun-*` 提供方、模型清单、默认模型及 `X-App-Source`。1.6.0 的 `ProviderConfig.apiKey` 使用 `$LLM_API_KEY` 指定环境变量。`resolve-config-value.js` 表明裸变量名按字面值处理。保留缺变量的启动失败，验证请求发送的是占位测试凭据解析后的值。
- ops-bot 保留每条请求创建 `Agent` 及其 `streamFn`。根据现有模型的 `api`，用 `hasApi` 收窄到四个已支持协议，委托 `@earendil-works/pi-ai/api/<协议>` 的 `streamSimple`。这些是 `package.json` 声明的公开入口。原样传递 Agent 给出的 `TranscriptContext` 与取消信号。由服务配置传入 API Key，保留 reasoning、Gemini 阶梯及 `xhigh` 的既有降级。普通 delta、终止和错误按声明处理。直接 API 可能在缺认证时同步抛错，也可能发出终止 `error`，两个入口都进入现有机器人失败处理。
- 用受控接收端比较请求路径、认证、模型和 payload。预期路径为 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 和 `/v1beta/models/<id>:streamGenerateContent`。核对 SDK 实际发送的路径及流式请求参数。钉钉仍按会话累积文本并回推。1.6.0 changelog 中的 GPT-6.2 默认变更适用于上游内置提供方，Flower 的产品模型选择继续显式配置。

## Reviewer 自带扩展

保留调用 `pi-coding-agent.main(argv, options)` 的 print 路径。1.6.0 的 `MainOptions.extensionFactories` 接受 `InlineExtension[]`。用命名 inline 工厂注入 Flower 扩展，使启动诊断可识别该扩展。该入口由应用提供，provider、telemetry、compliance、GitLab、自审工具和 trace 仍按现有顺序装配。使用临时 `PI_CODING_AGENT_DIR` 验证 settings 和运行边界。

当前 Flower 的 `buildPiCliArgs` 沿用 pi 扩展发现行为。先在隔离的项目和用户目录分别记录 0.76.0 基线，再用同一夹具验证 1.6.0 的 Flower 工厂、既有扩展加载和工具可见集合。如新增的上游默认工具影响现有合规边界，针对变化验证最小配置调整。业务资源发现策略的独立变更需单独评审。使用受控模型运行一次真实扩展工具，并核验启动错误、流错误及退出码。

## 旧会话与镜像

- ops-bot 的 Redis 键仍为 `flower:ops-bot:session:<conversationId>`，值为 `{ messages, updatedAt }`，写入 TTL 为 24 小时。使用 0.76.0 实际生成的脱敏 JSON 放进隔离 Redis，验证升级后恢复已有用户与模型消息、继续下一轮并回读写入。优先使用能读原格式的最小适配。若实测需要转换，在读取边界转换已知旧形状，保留原始值直至有效新一轮成功写入。额外用另一个会话核验隔离。回滚可先用原版本回读升级后的受控样本，确认无法回读时仅在备份后的隔离存储验证回退。
- reviewer 的 pi 会话文件是另一种格式。1.6.0 的 `SessionManager` 声明当前 JSONL 版本为 3，支持旧版 entry 迁移。用真实旧会话副本打开并核对历史与模型选择。记录明确的 fallback 或诊断。恢复历史只读会话内容，测试确认历史工具结果未引起新的 GitLab 请求。
- reviewer Dockerfile 现有的复制提升和 `koffi` 裁剪针对 0.76.0 的 shrinkwrap。1.6.0 npm 预检制品没有该 shrinkwrap，锁中有实际嵌套依赖和 `photon-node` 的 WASM。按升级锁定的真实生产依赖重新评估裁剪。保留 npm 的解析结构和必要资产，先得到可以运行的最终层，再保留有验收覆盖的裁剪。ops-bot 验证最终层的 agent-core、pi-ai 协议入口和流式回调。Observer 保留静态资源、SQLite 和既有运行层依赖边界。
