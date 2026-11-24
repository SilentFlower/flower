# Flower v2 结构设计

Flower v2 已确定采用同仓。开源工作台在 `v2` 开发，公司身份和网关接入在 `v2-company` 维护。Desktop 和共享核心分别放在 `apps/desktop` 和 `packages/agent-runtime`。

本文承接父任务及各子任务的需求。现状以 `origin/main@58141e90` 和本地可读的公司分支引用为依据。 [父任务 PRD](prd.md) · [现有项目目录与内容整理](../11-23-flower-v2-layout/prd.md) · [共享 pi 运行时](../11-23-flower-v2-runtime/prd.md) · [企业服务接入](../11-23-flower-v2-enterprise/prd.md) · [新 Desktop](../11-23-flower-v2-desktop/prd.md)

## 1. 同仓布局

沿用 npm workspaces、根 `package-lock.json` 和 TypeScript 项目引用。将独立启动或分发的入口放进 `apps/`，将被入口按需引用的模块放进 `packages/`。工作区包含三个应用和五个库，八个 npm 包均按公开访问发布。根包保持私有。原 ARMS 和 Common 包从 v2 工作区退役。GitLab 工具包接管评论快捷指令转义及其测试。

| npm 工作区包 | 目标目录 | 责任与打包范围 |
| --- | --- | --- |
| `@flower-ai/flower-code-reviewer` | `apps/code-reviewer` | 一次性企业 CLI。负责 MR 上下文、评审 skill、GitLab 写入策略、退出码和 trace。由企业服务接入阶段切换到共享运行时。 |
| `@flower-ai/flower-ops-bot` | `apps/ops-bot` | 常驻企业服务。负责钉钉回调、模型回复与 Redis 历史。后续按企业接入顺序适配共享运行时。 |
| `@flower-ai/flower-observer` | `apps/observer` | 常驻观测服务。负责采集、SQLite 和 Web 页面，通过现有遥测协议接收事件。 |
| `@flower-ai/flower-compliance` | `packages/flower-compliance` | 企业工具策略，保留 reviewer 的 `ci-readonly` 和现有阻断规则，由企业入口装配。 |
| `@flower-ai/flower-providers` | `packages/flower-providers` | 保留现有模型目录、企业环境变量入口和 pi 扩展适配。通用模型描述可按需复用，企业配置由对应宿主提供。 |
| `@flower-ai/flower-telemetry` | `packages/flower-telemetry` | 保留事件类型、脱敏、发送端及 pi 适配。Observer 消费现有线协议，企业宿主选择 JSONL、HTTP 与 SIEM 接线。 |
| `@flower-ai/flower-tools-gitlab` | `packages/flower-tools-gitlab` | reviewer 使用的 GitLab 读写工具和工作区适配。包内统一处理整体和行内评论的快捷指令转义。CI 身份与目标限定在企业入口。 |
| `@flower-ai/agent-runtime` | `packages/agent-runtime` | 企业入口与 Desktop 共用的 pi 会话、工具执行和运行事件契约。 |

`packages/agent-runtime` 提供两侧共享的 pi 会话、工具执行与运行事件契约。`apps/desktop` 包含 Electron main、preload、renderer 和本地 Node 子进程入口。企业入口和 Desktop 通过同仓 workspace 引用 `agent-runtime`。Desktop 安装包包含子进程入口、共享核心和经授权的桌面适配器。Observer 通过既有采集接口接收事件，可独立构建和部署。

`sanitizeQuickActions` 及单元测试与它的使用方一起位于 GitLab 工具包。两个发评论工具在把正文交给 GitLab 客户端前应用同一规则。验收覆盖已知快捷指令、普通路径、重复转义及两种评论的出站内容，并用仓外安装包与 reviewer 最终镜像验证依赖闭包。 [GitLab 评论工具](../../../packages/flower-tools-gitlab/src/index.ts) · [出站内容测试](../../../packages/flower-tools-gitlab/src/__tests__/tool-sanitize.test.ts)

## 2. 共享 pi 核心

当前 reviewer 在 `run.ts` 中以 print 模式调用 `piMain`，用扩展注入 provider、工具、合规和观测。钉钉入口通过 `Agent` 装载按会话保存的 Redis 消息并监听流式事件。升级前基线为 `0.76.0`，当前锁文件解析的八个 pi 包均为 `1.6.0`。[升级验收](../11-23-flower-v2-pi-upgrade/verification.md)QoneAgent `c4788b2` 的运行时以 `1.5.2` 的 `createAgentSession` 作为嵌入式入口，根清单还有对应补丁。该实现可用于对照 API 和打包差异。

第 5.1 节完成后，先执行[pi 稳定版升级](../11-23-flower-v2-pi-upgrade/prd.md)，将已有应用统一到 1.6.0。第 5.2 节再在该版本上构建共享核心，以同一只读用例验证企业与桌面子进程的会话、工具和取消行为。

| 边界 | 建议契约 |
| --- | --- |
| 宿主 → 核心 | 提供已认证主体及会话权限、受限模型调用能力、授权工具集合、工作区、会话存储和观测回调。核心按运行实例使用这些输入，企业环境配置、Desktop 登录和存储实现由各宿主解析。 |
| 核心 → 宿主 | 归一化文本增量、工具开始和结果、失败、完成及取消。跨进程事件使用可序列化载荷并携带 `sessionId`、`runId` 和单调序号。运行错误返回稳定类别和可展示信息。 |
| 持久化 | 每个宿主维护其会话作用域与版本。企业 reviewer 管理 MR 工作目录和临时运行。钉钉迁移时保留 Redis 历史和 TTL，验证旧格式读取及既有会话授权。Desktop 使用本地用户数据目录，记录可恢复会话及工作区内交付物引用。 |
| 调度 | 同一会话按接收顺序串行执行。宿主按请求与运行标识反馈排队位置、开始执行和终态。不同授权会话可以并行。 |
| 企业能力 | reviewer 管理 MR/项目上下文、skill、评论去重、退出码和企业遥测。运维机器人管理钉钉和 Redis 生命周期。工具授权和凭据按宿主及主体解析，现有 `ci-readonly` 策略随 reviewer 接线，模型调用和工具执行上下文按会话隔离。 |

实施时优先复用现有工具定义、provider 模型目录和遥测管道。将 `piMain` 参数、进程级状态、pi 私有事件以及旧消息格式的转换集中在相应适配边界。迁移时核对已有模块级客户端、trace 和环境配置的生命周期。单 MR 进程使用的全局状态进入并发宿主前应由运行上下文替代。

### 单会话排队、取消和恢复

- 每条合法请求获得 `requestId`，按宿主接收顺序排队。宿主记录状态后反馈「已排队」和队列位置，位置变化时更新反馈。前一个运行实际到达终态并释放会话后，宿主复核队首请求的身份、会话权限和工作区授权。复核通过后分配 `runId` 并报告开始执行。授权失效时反馈该请求无法执行，再处理下一条。
- 取消排队请求按 `requestId` 移出队列并反馈「已取消排队」，当前运行继续执行，其余请求保持相对顺序。若请求已获 `runId`，返回当前运行状态，调用方可显式发起运行取消。取消运行按 `runId` 请求中止模型流和可取消工具，先反馈「正在取消」，实际停止后再报告终态并处理队首请求。终态后的迟到事件按原 `runId` 过滤。排队请求的取消与启动在会话内有确定顺序。
- 恢复只读取已持久化的会话记录、请求状态、运行结果和交付物引用。重启前仍在执行或等待的请求显示为中断，由用户或调用方显式重新提交。外部写入在恢复过程中始终禁止自动重做。已确认的写入保留其结果，发出后结果未明的写入标为「待核对」。确需重新提交时，由对应宿主先按目标与原操作记录核对外部状态并检查去重条件。

同一会话依次收到 A、B、C。A 正在运行，B 和 C 的排队位置分别为 1 和 2。假定其余请求的授权复核均通过。

| 取消对象 | 其余请求的执行顺序 |
| --- | --- |
| 正在运行的 A | 按 A 的 `runId` 取消。A 实际停止并报告终态后，B 执行，随后是 C。 |
| 排队中的 B | 按 B 的 `requestId` 取消。A 继续运行，C 的排队位置更新为 1。A 到达终态后执行 C。 |
| 排队中的 C | 按 C 的 `requestId` 取消。A 继续运行，B 保持队首。A 到达终态后执行 B。 |

## 3. Desktop 进程边界

```text
Renderer ⇄ Preload ⇄ Electron main ⇄ 本机 Node 子进程 → agent-runtime → pi SDK
                         │                 │
                     本机模型配置      会话和获准的工作区操作
```

| 进程或入口 | 责任 |
| --- | --- |
| Renderer | 会话列表、输入、运行进度、取消和交付物展示。启用 sandbox 与 `contextIsolation`，关闭 `nodeIntegration`，通过 preload 的具名接口发起操作。 |
| Preload | 暴露会话、开始、取消、订阅、选择工作区和打开交付物等有限操作。事件按窗口释放订阅。 |
| Electron main | 管理窗口、模型配置、系统凭据存储、文件选择与打开、子进程生命周期和 IPC。验证发送方、载荷和会话/工作区归属。模型配置由 main 向 renderer 提供脱敏视图，企业服务身份留在服务器。 |
| Node 子进程 | 调共享核心执行已授权工具，维护本地会话和交付物引用。使用专用父子进程 IPC 承载有版本的命令和事件，运行日志走独立输出。模型调用由 main 提供受限授权或经宿主代理。凭据排除在通用事件、历史和日志之外。 |

启动后等子进程握手成功及协议版本匹配再接受请求。身份切换、关闭和崩溃时隔离旧进程世代及其事件，清理本产品创建的子进程树。Desktop 按第 2 节的恢复规则加载记录和交付物引用。访问和打开文件均基于获准工作区校验实际路径，测试覆盖 Windows 路径、符号链接或目录联接的越界情形。进程分离主要隔离故障和依赖。子进程继承当前用户的系统权限，首发工具限定在明确授权的文件和操作。

QoneAgent 的 sidecar 管理启动、事件转发、重启和进程树清理，安装包通过资源目录加载 Node 入口。小仙的账户插件由 Host 持有模型授权，Windows 已验收真实账户、Excel 分析和重启恢复。Flower 采用上述进程与凭据边界，小仙样例用于核对结果和恢复体验。 [QoneAgent sidecar](../../../../QoneAgent/apps/desktop/electron/sidecar.ts) · [QoneAgent 打包配置](../../../../QoneAgent/apps/desktop/electron-builder.json) · [小仙账户插件](../../../../xiaoxian-desktop/packages/credentials/xiaoxian-account/README.zh.md) · [小仙 Windows 验证](../../../../xiaoxian-desktop/.trellis/tasks/11-05-xiaoxian-first-business-scenario/verification.md)

### 桌面版本边界

`v2` 启动即显示本地会话和工作区。用户在模型设置中配置自己的端点、模型与可选凭据。开源版和企业版各自使用独立的资料目录。主题及首页文案由本机偏好决定。企业登录需求随 `v2-company` 维护。

## 4. 未来源码读取范围变化时的分仓备选

仅当未来源码或历史的读取范围变化，且需要按仓库隔离读权限时，才评估以下备选。届时按授权范围划分仓库和可迁移的文件与历史。目录、分支保护和 CI 路径规则用于组织代码与约束写入。

- 企业仓承载三个企业应用、企业适配、内部 CI、部署配置和凭据入口。Desktop 仓承载桌面应用、桌面适配和安装交付。现有 npm 库按源码读权限归入对应仓，业务工具只随获准的宿主交付。
- `agent-runtime` 源码保留在双方获准读取的仓。需要独立授权时放入单独核心仓。由唯一来源构建并发布经批准的版本化制品，企业仓与 Desktop 仓按精确版本及完整性信息消费。核心制品附契约测试、版本及源提交映射。跨仓更新按核心候选、各宿主验证、各自产物发布的顺序推进。
- Git 源码和制品读权限分别核对。npm tarball、桌面安装包、容器层和 sourcemap 均按可提取内容审查。受限的源码由相应仓库控制读权限。若未来制品访问范围也收窄，评估相应的私有 registry 或制品库。涉及共享核心时，先明确两侧的执行与分发授权，再验证核心能否由两个宿主共同消费。
- 分仓时核查目标仓、镜像、制品和 CI 缓存的可见性。需要改变制品访问级别时，单独确认消费者的迁移方式。

## 5. 迁移及验收顺序

布局整理前的 `v2` 根目录使用 `packages/*` workspaces，九个清单声明 npm 公开访问，根 `.npmrc` 将 `@flower-ai` 指向公网 registry。发布入口为 `npm run build && changeset publish`。`flower-review` 与 `flower-ops-bot` 有 npm `bin`，Observer 以 `dist/server.js` 为入口。三者分别有 Dockerfile。 [根工作区基线](../../../package.json) · [Changesets 配置](../../../.changeset/config.json)

### 5.1 现有项目目录与内容整理

第一项工作是在 `v2` 仓内把三个现有应用物理移动到 `apps/`，整理随应用移动的内容、仓内文档及路径契约。为根 npm workspaces 加入 `apps/*`，与 `packages/*` 并行使用。同步 lockfile、根及逐包 TS references、包元数据、脚本、示例、Dockerfile 和 `.dockerignore`。验收沿用现有 npm `name`、`main`、`bin` 和业务行为。布局验收以干净安装、构建、现有测试及三个应用在新路径上的仓内入口检查为准。公司分支 CI 配套在第 5.3 节集成。 [布局整理 PRD](../11-23-flower-v2-layout/prd.md)

| 应用 | 新目录与仓内移动契约 |
| --- | --- |
| Reviewer | `packages/flower-code-reviewer` → `apps/code-reviewer`。移动随包的 `skills` 和示例。根 TS reference 改为 `./apps/code-reviewer`，包内依赖引用 `../../packages/`。从仓根检查 `apps/code-reviewer/Dockerfile` 的 COPY、构建目标、PATH wrapper 和 ENTRYPOINT，验收 `flower-review` 入口和 pi 依赖解析。 |
| Observer | `packages/flower-observer` → `apps/observer`。根 TS reference 改为 `./apps/observer`，保留 `../../packages/flower-telemetry` 依赖。校准仓根 Docker 构建入口、静态资源打包和 CMD 路径，检查现有启动、`/healthz` 和 SQLite 卷约定。 |
| Ops-bot | `packages/flower-ops-bot` → `apps/ops-bot`。根 TS reference 改为 `./apps/ops-bot`。用应用 tsconfig 核对 Docker 构建目标及 providers 依赖，验收 `flower-ops-bot` 入口、健康接口与会话处理。 |

### 5.2 共享核心双宿主验证

以第 5.1 节交付的新布局和本地验证结果为基线。在 `packages/*` 工作区加入 `packages/agent-runtime` 的清单、根 TS reference 和锁文件记录。企业 Node 验证入口使用 `apps/code-reviewer` 的现有只读评审用例。`apps/desktop` 的最小 Node 子进程通过父子进程 IPC 跑同一只读用例。两个入口加载同一核心产物，记录产物标识、pi 版本组、工具结果、流式事件、双主体隔离和历史恢复。 [运行时实施清单](../11-23-flower-v2-runtime/implement.md)

同会话连续提交三条请求，验证接收顺序、排队位置及变化反馈、启动前身份与授权复核，并分别验证第 2 节的三种按 ID 取消结果。用正在进行的文件读取验证运行取消，确认收到实际终态之后下一请求才开始。用替身验证恢复阶段的外部写入调用次数为零。企业业务切换和 Windows 安装版继续在第 5.3 节验收。

### 5.3 业务接入与发布

双宿主验证完成后，企业业务按新路径接入共享核心。候选制品验收前记录 reviewer 的 MR 样例、评审参数与退出码 `0/1/2`、评论与遥测结果，以及 Observer 镜像、协议与持久卷和 ops-bot 的 Redis 历史。使用只读凭据或测试替身记录拟写入的载荷。

公司集成以 `company/company@23a2fb3a` 和 `company/company-test@c1389b12` 的 `.gitlab-ci.yml` 为参考。现有 company 通过 `.node-cli-image` 在 Harbor 构建 reviewer 与 Observer，MR 自评调用 `flower-review`。company-test 使用独立测试 tag。以下配套与实际业务入口切换在相应集成批次验收。

| 应用 | 业务接入与公司集成 |
| --- | --- |
| Reviewer | 在 `apps/code-reviewer` 接入共享核心，同步 TS references 和镜像依赖。公司 CI 的 `SUB_DIR` 改为 `apps/code-reviewer`，`reviewer-change-paths` 按 `apps/code-reviewer/**/*` 和实际传递依赖更新，包含接入后的 `packages/agent-runtime/**/*`。验收仓外 CLI、容器直接启动和 CI PATH 调用，按固定 MR 用例核对评论转义、blocker、退出码、网关失败、遥测和写入去重。 |
| Observer | 保持现有采集接口，验证共享核心接入后的遥测兼容。公司 CI 的 `SUB_DIR` 改为 `apps/observer`，`observer-change-paths` 纳入新应用路径和现有构建依赖，部署清单改用 `apps/observer/deploy/k3s-observer.yaml`。验证同提交镜像、部署与通知门控、事件接收、页面以及重启后的卷读回。 |
| Ops-bot | 在 `apps/ops-bot` 按批次适配共享核心，验收钉钉回调、流式回复、Redis 旧历史恢复和用户隔离。实际消费流水线采用新路径，部署归属待确认。采用同一构建模板时，使用 `SUB_DIR=apps/ops-bot` 并按新应用路径及实际构建依赖配置 `rules:changes`。 |

1. **npm 与 CLI**。八个工作区使用公开 npm 分发。按 Changesets 的 `main` 基线核对版本及发布集合，用实际发布构建生成候选 tarball。校验 `main`、`bin`、库 `exports`、内部依赖版本、reviewer `skills`、Observer `static`、shebang 和可执行权限。`npm run release:verify` 从仓外只安装 Reviewer 并执行正常评审。目标 registry 尚缺核心版本时，导出并单独发布该次通过试装的核心 tarball。随后 `npm run release` 检查 Reviewer 固定依赖的核心可匿名下载，并对比下载制品和同批试装核心的 SHA-512 SRI，再发布其余待发包。 [首次发布命令](../../../README.md#npm-发版检查)
2. **Docker 与公司 CI**。公司候选提交基于已验收的仓内新路径，配套上述 CI 调整。逐应用从仓根构建并冒烟最终镜像。保留 Harbor 基础镜像、`[build-all]` 和 `[force-deploy]`，保证 Observer 部署每次都有同提交镜像。用 `company-test` 或等效隔离线验证应用、核心、公共构建文件、无关路径和强制触发的 job 矩阵。测试使用 `company-test-<sha>` 或等效不可变引用，正式 `latest` 随通过验收的公司发布才切换。测试 MR 按候选 tag/digest 试跑，实际写入仅在专用 MR 单次执行。
3. **联合验收与分批发布**。开源 Desktop 与企业服务加载同一核心版本。开源桌面需通过离线首次启动、模型配置、执行及交付恢复。使用四行合计 500、两组各 250 的 Excel 场景验证。外观设置在重启后应保留。公司版另外验证员工授权及企业网关。
   - npm 首发遵循第 5.3 节的核心先行顺序。公司部署和 Desktop 安装包各自按对应验收结果发布。

回退以失败的交付面为单位。GitLab 消费方重新锁定上一个通过验收的镜像 tag/digest。Observer 重新部署已知健康的镜像与兼容清单并沿用经验证的卷。npm 消费方锁回旧版本或使用已验证的修正版本。Desktop 用旧安装包恢复时验证已有会话与文件可读。若历史格式必须升级，先验证兼容读取或升级前的可恢复副本，再切换默认版本。

## 6. 待决项

| 决策 | 当前建议与所需依据 |
| --- | --- |
| Desktop 安装签名 | 安装签名渠道由 Desktop 子任务确认。 |
| Desktop 子进程启动方式 | pi 目标版本已定为 `1.6.0`。以 Windows 候选构建验证 Electron 的 Node 模式或随包 Node 的启动、原生依赖和资源布局。 |
| 企业业务接入批次 | 建议 reviewer 先接，Observer 随遥测兼容测试，ops-bot 按 Redis 历史验证结果单独安排。公司测试线需确认新的 Observer 候选 job、常驻服务部署归属和正式切换窗口。 |

## 核对入口

- 布局前源码以 `58141e90` 的 `packages/flower-code-reviewer`、`packages/flower-ops-bot` 和 `packages/flower-observer` 为历史对照。后续实现以 `apps/code-reviewer/src/run.ts`、`apps/code-reviewer/src/extension.ts`、`apps/ops-bot/src/agent-factory.ts`、`apps/ops-bot/src/session-store.ts`、`apps/observer/src/server.ts` 及三个新目录中的 Dockerfile 验收。
- 公司集成参考 `company/company@23a2fb3a` 的 `.gitlab-ci.yml` 与 `packages/flower-observer/deploy/k3s-observer.yaml`。
- pi 对照。 [Flower lockfile](../../../package-lock.json) · [QoneAgent 运行时清单](../../../../QoneAgent/apps/agent-runtime/package.json) · [QoneAgent pi 适配](../../../../QoneAgent/apps/agent-runtime/src/pi-adapter.ts)
