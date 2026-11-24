# GitLab Reviewer 接入共享运行时

本批迁移 `flower-review` 的正常 CLI 路径。输入仍由 reviewer 解析，评审由 `@flower-ai/agent-runtime` 调度，模型和扩展由 reviewer 装配。用同一合成 MR 对照迁移前后的工具权限、评论请求、退出码和 Observer。钉钉、Desktop、公司 CI 和制品正式分发各有后续验收。 [企业 PRD](prd.md) · [父设计第 5.3 节](../11-23-flower-v2/design.md#53-业务接入与发布) · [runtime 验收](../11-23-flower-v2-runtime/verification.md)

## 现状与本地证据

| 边界 | 已核对的行为 |
| --- | --- |
| 正常 CLI | `cli.ts` 调用 `runReview`。后者解析 MR、选 skill、探测 GitLab 版本及 harness、限制 diff、生成 prompt、记录跑前评论 ID，随后调用 `piMain` print 模式。跑后由 reviewer 汇总 blocker、自审与无依据评论并冲刷遥测。跑前 ID 差集用于判定本轮评论。 |
| pi 1.6.0 | `MainOptions` 只接受 `extensionFactories`。print 内部创建并绑定 SDK 会话，处理最终消息、退出状态和销毁。公开 SDK 提供 `createAgentSessionServices`、`resolveCliModel`、`createAgentSessionFromServices`、`createAgentSessionRuntime`、`AgentSession.bindExtensions/prompt/abort/waitForIdle` 和 `AgentSessionRuntime.dispose`。直接用低层 `Agent` 重建会丢失 SDK 工具上下文、provider 扩展事件与会话处理。 |
| 扩展与权限 | 保留 `extension.ts` 注册顺序。Havefun provider → telemetry → `ci-readonly` 合规及 `security_block` → GitLab 与自审工具 → review trace；被拒工具的调用意图仍可见。两类评论经过既有 GitLab 工具和快捷指令转义。 |
| 会话和超时 | 正常 CLI 创建新的 pi JSONL 会话。当前总软超时用 `Promise.race`，引擎不随计时器停止。GitLab 写工具没有把 pi 中止信号交给客户端。现有 provider 请求超时与 provider/agent 重试来自 `preparePiSettings`。 |
| 包与镜像 | 当前 `flower-review` 指向 `dist/cli.js` 且随包带四个 skills。旧镜像从 `/workspace` 用默认 ENTRYPOINT 或 PATH wrapper 执行。builder 只复制 reviewer 依赖并按应用 TS reference 构建，再剪 dev 依赖；最终层保留 workspace 链接的目标包和 pi 运行资源。 |

实测正常 CLI 的合成 MR 为项目 `123`、IID `42`。普通评审退出 `0`、blocker 退出 `1`，两种各捕获一条整体评论和一条行内讨论。请求保留 diff refs、路径和 `new_line=2`，快捷指令转义后发出。网关 `401`、`503`、provider 请求超时和独立的总软超时均退出 `0`、各一条 warning。无效 CLI 参数退出 `2`，缺模型密钥退出 `1`。本地 GitLab `401` 作为模型可见工具错误时退出 `0`、评论为零。传播到宿主的鉴权硬错误另按退出 `2` 验证。默认 Responses、显式 Completions 均跑通。旧镜像 `0eb165beda77` 的默认 ENTRYPOINT 跑普通用例退出 `0`，PATH wrapper 跑 blocker 用例退出 `1`，两端均捕获两条评论。

临时公开 SDK 探针运行现有 `extension.ts`。普通场景的模型路径、工具集合、两种评论载荷和退出码与正常 CLI 逐项相同。默认只加载用户探针，设 `defaultProjectTrust=always` 后同时加载项目与用户探针。基线 CLI 的 HTTP sink 向本机 Observer 写入八条 trace，详情可回读 provider、工具、合规、评论、自审、运行摘要和结束事件。普通样例 JSONL 与入库均为 25 条，最大序号 42；流式展示事件进入编号后由两个 sink 跳过，既有详情状态为 `incomplete`。验收以同等事件和聚合字段为准，状态表现按基线单列。预检记录在 `/tmp/flower-enterprise-plan.1BNBdn/`。 [原 CLI](../../../apps/code-reviewer/src/run.ts) · [pi 升级验收](../11-23-flower-v2-pi-upgrade/verification.md)

## 接入提案

1. **共享核心实际调度。** 在 runtime 添加通用可选执行适配契约，默认继续使用原生 `Agent`。适配器只在服务主体和 workspace 绑定通过、队首复核后创建。核心负责实际调用 prompt、分配请求和运行 ID、订阅 pi 事件、取消、等待空闲和提交终态。reviewer 适配器使用真实 SDK `AgentSession`，从 `session.agent` 订阅底层 pi 事件，从 `session` 调用 prompt、abort 和 waitForIdle，以 SDK runtime dispose 触发 shutdown。启动期间记录取消并阻止后续 prompt。退出码和宿主业务仍由 reviewer 决定。
2. **复用 SDK 和 Flower 扩展。** 继续用 `preparePiSettings`、现有 env/default 模型解析及命名 inline 扩展。先按下节完成资源信任判定和 provider 加载，再显式解析 havefun provider、model、thinking，并绑定 print 扩展生命周期。保留可从根入口取得的 codemode、tool-search、MCP 工厂及其可信配置边界。内置 llama.cpp 装配仍是独立的兼容评估项。
3. **保持 MR 归属和写入安全。** 一次 CLI 调用只启动一个共享运行，服务主体由宿主构造，工作区绑定归一化 checkout、项目和有效 IID。显式 `--mr-iid` 优先于环境变量，所有上下文读取和写入使用同一解析结果。当前工具直接读 `CI_MERGE_REQUEST_IID`，首选在一次性 CLI 边界规范化该值，覆盖仅 CLI 提供与两来源冲突。保留 GitLab 现有安全读取、行内重定位、降级、转义及评论扫描。`--dry-run` 当前靠 prompt 约束，建议由同一扩展拒绝两类评论工具并保留审计，包含从 SDK 组合工具触发的调用。任何本地评论对照写入独立的 GitLab 替身，每边各一次，分别初始化评论快照。
4. **一轮一会话和可停止的超时。** 共享快照使用 reviewer 进程内存，pi `SessionManager.create` 继续记录原格式 JSONL 供诊断；每次 CI 调用创建新会话，恢复旧记录属于显式操作，本批正常命令不会自动装入旧 MR 历史。共享调度器取消后等待终态，适配器传播模型错误类型供 reviewer 区分网关失败、启动配置、一般错误和截断。总超时进入同一取消链路，待引擎收敛后按原语义写一次 warning 并冲刷遥测。变更最小限于将中止信号接到评论工具（包含行内降级）及其请求/重试边界，停止取消后的新写入；已发出但结果未知的写入由宿主记录，下一轮不会自动重放。运行事件供宿主调度验证，Observer 仍消费现有遥测。
5. **交付闭包。** reviewer 增加 runtime 的本地 workspace 依赖和 TS reference。Docker builder 安装前复制 runtime 清单、编译前复制源码，最终镜像复制 runtime 清单和 dist，保留 SDK 动态加载资源与四份 skills。仓外 CLI 只安装 Reviewer，由 npm 解析同批依赖。核心与其余工作区包均按公开 npm 分发。首次先提供已试装的精确核心版本，再走 Reviewer 的匿名下载、SRI 和正常评审检查。 [首次发布命令](../../../README.md#npm-发版检查)

## 保留 pi 项目信任决定

pi 1.6.0 的 `main` 对含需信任资源的项目先做预加载。存在已记忆允许的项目同样会进入这一轮。原 CLI 的 `resolveProjectTrusted` 先处理预加载扩展的 `project_trust` 决定，再查 `ProjectTrustStore` 和用户级 `defaultProjectTrust`。已安装包的根入口不导出 `resolveProjectTrusted`、`emitProjectTrustEvent` 或 `createProjectTrustContext`。根入口公开 `createAgentSessionServices`、`ProjectTrustStore`、`SettingsManager`、`hasTrustRequiringProjectResources` 和相应上下文类型。其 `resourceLoaderReloadOptions.resolveProjectTrust` 回调接收公开声明的 `LoadExtensionsResult`，其中 `extensions` 提供已加载扩展顺序和 `handlers`。

1. 对需要信任判定的工作区，用 `projectTrusted: false` 创建 SettingsManager，将信任回调传给 `createAgentSessionServices`。SDK 的预加载会暂缓项目级扩展和项目包，仅向回调提供此时可用的用户级、显式和 inline 扩展。在回调返回后由 SDK 加载最终资源集。
2. reviewer 的窄适配按 SDK 顺序快照并调用 `extension.handlers.get("project_trust")`。传入实际 cwd 及公开类型 `ProjectTrustContext`，使用 `mode: "print"`、`hasUI: false` 和非交互 UI 行为。首个明确的 `yes` 或 `no` 生效，`undecided` 继续。处理器异常按旧 CLI 记录诊断后继续。明确决定要求记忆时，通过 `ProjectTrustStore.set` 保存。保存故障按启动故障处理。
3. 所有处理器无明确决定时，才按 store 决定及用户级默认设置回退。非交互 `ask` 拒绝。没有需信任资源时，保持 SDK 原入口的已记忆决定或无保护资源默认分支。使用根入口公开契约实现，信任预加载失败时中止启动。

用户扩展的明确拒绝是本批兼容条件。即使默认允许或已有记忆允许，也应保留拒绝结果，项目扩展、项目包及项目设置继续受 SDK 门控。

临时适配按公开声明通过 TypeScript 严格检查。用同一合成 MR 对比现有 `flower-review` 和公开 SDK 探针。六组的加载标记、退出码、工具集合、评论请求和信任存储结果一致。默认允许及记忆允许遇到用户拒绝时，项目初始化标记和项目判断标记均为零。默认允许用例另验证前序处理器报错后仍会采用后续拒绝。`remember: true` 的拒绝将已记忆的允许改写为拒绝。复查脚本及逐例日志位于 `/tmp/flower-enterprise-project-trust.ufd0Vv/recheck/`。
