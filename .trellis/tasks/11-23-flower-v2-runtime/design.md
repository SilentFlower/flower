# 共享 pi 运行时设计

范围是父设计第 5.2 节的共享核心双宿主验证。以前置布局任务交付的 `apps/code-reviewer`、`apps/ops-bot` 和 `apps/observer` 为基线，在同一仓库构建 `packages/agent-runtime`。企业 Node 验证入口和最小桌面 Node 子进程加载同一份产物，使用受控主体和同一个只读评审用例。真实企业业务切换、company 分支 CI 和 Windows 安装版另随集成验收。 [前置布局任务](../11-23-flower-v2-layout/prd.md) · [父设计第 5.2 节](../11-23-flower-v2/design.md#52-共享核心双宿主验证) · [运行时 PRD](prd.md)

## 工作区和 SDK

`@flower-ai/agent-runtime` 接入整理后的根 npm workspaces（`apps/*`、`packages/*`）、`package-lock.json` 和 TS project references。`package.json` 使用 ESM，包根导出 `dist/index.js` 和 `dist/index.d.ts`。`tsconfig.json` 继承根 `tsconfig.base.json`，以 `src/` 为输入和 `dist/` 为输出。核心随现有工作区包采用公开 npm 分发，发布顺序见父设计。应用原有 CLI、服务和发布契约在各自的新目录上验收。 [父设计第 5.3 节](../11-23-flower-v2/design.md#53-业务接入与发布) · [根工作区](../../../package.json) · [根 TS 配置](../../../tsconfig.json) · [TS 基础配置](../../../tsconfig.base.json)

主路径使用 `@earendil-works/pi-agent-core` 的 `Agent` 与 `@earendil-works/pi-ai`，目标版本均为 `1.6.0`，以现有应用升级通过后的依赖图为准。布局后的 `apps/ops-bot/src/agent-factory.ts` 延续既有的 `Agent` 嵌入方式，`apps/code-reviewer/src/extension.ts` 是既有评审扩展装配的对照入口。本阶段验证现有只读评审工具契约可接到共享核心，完整扩展替换随企业子任务验证。 [锁文件](../../../package-lock.json) · [布局前源码基线](../11-23-flower-v2/design.md#核对入口)

已核对隔离副本中 1.6.0 安装产物的声明。`pi-agent-core/dist/agent.d.ts` 提供 `AgentOptions.initialState`、`streamFn`、`prompt()`、`subscribe()`、`abort(): void` 和 `waitForIdle(): Promise<void>`。`dist/types.d.ts` 的 `AgentTool.execute()` 接收 `AbortSignal`，`AgentEvent` 包含 `message_update`、`tool_execution_start`、`tool_execution_end` 和 `agent_end`。`pi-ai` 提供 `createAssistantMessageEventStream()`，工具参数使用 1.6.0 的公开 schema 定义，流的事件类型按 `dist/types.d.ts` 构造。`pi-coding-agent/dist/core/sdk.d.ts` 另有 `createAgentSession()`，其资源加载、鉴权存储和工具装配由更高层 SDK 管理，本阶段选择可直接注入受控模型流的 `Agent`。

## 双宿主与 IPC

| 边界 | 设计 |
| --- | --- |
| 共享核心 | 接收宿主核验过的主体、会话与工作区许可、模型能力、工具列表和存储接口。以宿主范围、主体和会话标识共同分区。每个实际运行从该会话已提交的消息历史创建 `Agent`，将允许的工具和 `streamFn` 注入运行。模型环境配置和员工授权由对应宿主装配。 |
| 企业验证入口 | 在测试入口直接使用包根 ESM 导出。以受控服务身份、临时评审文件和只读工具运行。参考 `apps/code-reviewer/src/__tests__/extension.test.ts` 的 `gitlab_get_file_content` 用例和行窗语义，以本地文件适配提供可复现结果。 |
| 桌面验证入口 | 父进程用 `node:child_process.fork()` 启动 `apps/desktop/verification/runtime-child.mjs`，通过 `ChildProcess.send()`、`process.send()` 和 `message` 收发可序列化帧。新 Node 进程从同一 workspace 解析包根导出，并以受控员工身份装配模型、工具和存储。身份、授权工具和可读工作区由宿主夹具确定，运行请求只引用可用会话和输入。 |
| 通信与产物 | 子进程完成导入后通过 IPC 返回协议版本、PID、包版本、入口真实路径和构建指纹。父进程核对版本与构建指纹，再提交请求。日志走独立输出。命令覆盖提交、取消排队、取消运行、查询会话和关闭，事件覆盖排队位置、开始、文本增量、工具开始/结果和终态。以 `sessionId`、`requestId`、运行开始后的 `runId` 及会话内递增序号关联。 |

企业与桌面共用同一测试夹具格式和编译产物，两个宿主记录各自的解析路径和 PID。Node 子进程用独立 PID 验证通信、启动、退出和重启。Windows 的 Electron 承载、系统凭据、员工双登录入口、撤权、实际模型访问及安装版由 Desktop 子任务验收。 [只读行窗测试](../../../packages/flower-tools-gitlab/src/__tests__/safe-read.test.ts) · [Desktop PRD](../11-23-flower-v2-desktop/prd.md)

## 受控模型、排队与恢复

受控模型由夹具向 `AgentOptions.streamFn` 注入。使用 `createAssistantMessageEventStream()` 发送 `start`、文本增量与终止事件。首轮 `done` 带有 `stopReason: "toolUse"` 和指向只读工具的 `toolCall`。真实 `Agent` 运行工具，将 `toolResult` 交给下一轮受控模型。下一轮断言结果中的样例内容，再发文本增量和 `done`。中止时模型检查 `options.signal`，按声明以 `error` 事件和 `aborted` 结束。运行时从 `message_update.assistantMessageEvent` 的 `text_delta` 及工具执行事件生成宿主事件。

同一会话的调度队列按接收顺序推进，`requestId` 在入队时返回，队首通过身份、会话和工作区授权复核后再分配 `runId`。取消排队项按 `requestId` 定位并更新其余位置。运行取消按 `runId` 调用 `Agent.abort()`，读文件工具沿用 pi 传入的中止信号。运行器在事件监听器外等待 `prompt()` 收敛及 `waitForIdle()`，然后根据取消状态、异常和最终模型消息判定终态。完成持久化后再发送终态并启动下一项。工具错误保留在工具结果中。中止所得的部分输出保留在对应运行记录，恢复给模型的消息历史采用上一个完整回合。

宿主存储在临时目录中按同一分区键保存会话、请求状态、完整消息、运行结果与交付物引用。入队确认和运行终态在对应记录提交后返回。恢复时加载已提交记录，将重启前仍等待或运行的记录显示为中断。只有显式的新请求才触发模型或工具。恢复验证使用写入替身计数，已确认和结果待核对的外部操作记录以原状态呈现。

隔离验证让服务主体和员工主体使用相同公开 `sessionId` 和相同相对路径。使用不同文件内容和各自允许的工具，核对模型上下文、返回事件与恢复记录的归属。模型访问凭据以夹具标记注入，只在模型适配器内核对。另在同一运行时实例注册两个受控主体，验证跨主体查询、取消和读取均被拒。
