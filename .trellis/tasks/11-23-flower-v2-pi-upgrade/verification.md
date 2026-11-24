# pi 1.6.0 本地验收

2026-11-23，`v2` 的七工作区布局。宿主 Node.js `22.23.4`、npm `10.9.9`。0.76.0 对照使用布局任务的七个已安装 tarball 与既有验收。流式模型、GitLab、钉钉推送均由本机替身提供。Redis 使用临时 `redis:8.4-alpine` 实例和合成数据。

## 安装、构建和回归

| 检查 | 结果 |
| --- | --- |
| 版本和工作区 | npm、Trellis、TS references、锁文件链接、打包清单均为三个应用加四个共享库。八个实际解析的 `@earendil-works/pi-*` 包均为 `1.6.0`。reviewer 与 GitLab 直接声明并解析 `typebox@1.3.27`。 |
| 基线命令 | `npm ci --no-audit --no-fund`、`npm run clean`、`npm run build`、`npm run typecheck`、`npm test` 通过。37 个测试文件、674 项通过。新增两项覆盖 pi print 终止消息、进程状态及 reviewer 的 warning/硬错误分支。 |
| 仓外安装 | 七包 dry-run、实际打包及仓外独立安装通过。reviewer CLI 与四份清单、两种评论、ops-bot 健康检查、Observer 健康检查、两个页面及四个静态资源通过。仓外 reviewer 也完成了真实 pi 工具链路。 |
| 格式 | 改动文件的 Biome 与 `git diff --check` 通过。应用级扫描的唯一诊断是既有 Observer 格式问题，见下表。工作区级编译入口用 `node apps/<应用>/dist/...`。独立安装和镜像另验证实际可执行入口。 |
| 文档复核 | Providers README 的三个 TypeScript 示例按当前依赖通过编译。四个流式协议子入口均可导入。Providers 工作区的 124 项测试通过。 |

## 基线对照与升级回归

| 归属 | 现象与复核结果 |
| --- | --- |
| 既有布局基线 | Observer 的 `apps/observer/src/routes/pages.ts` 格式诊断在布局任务和升级后均存在。参见[布局验收](../11-23-flower-v2-layout/verification.md)。 |
| 既有 reviewer 缺陷 | 0.76.0 实测网关 503、超时、401 均退出 0，仅由 pi print 输出错误，缺少应用 warning 评论。1.6.0 最初也复现该缺口，现已通过终止事件和进程状态适配进入应用 warning 分支。 |
| 历史类型检查风险 | company 研发日志第 742 行记录旧的 `TS6310` 和增量缓存问题。当前 `v2` 干净构建后的 `npm run typecheck` 通过。 |
| 本次 SDK 接口变化 | 1.6.0 预检复现旧 `Type`、顶层 `streamSimple` 和工具上下文的编译失败。更新构造器来源、协议子入口与上下文后，类型检查及 674 项回归通过。 |
| 本次上游行为变化 | 1.6.0 在干净项目按信任规则跳过项目扩展。受信项目和用户扩展在本地复验均能加载。Flower 沿用原发现参数和配置来源。 |

## 产品链路

- **Reviewer**。真实 `flower-review` 固定使用 `havefun-*`。默认命中 Responses 的 `gpt-6.1-sol`，显式模型命中 Completions。收到测试认证和 `X-App-Source: code-reviewer`。模型依次调用文件行窗、合规拒绝样例、整体评论、行内评论和自审工具。数值字符串行号由 pi-schema 正常解析。GitLab 替身收到两个正确的 REST 写入，行首快捷指令被转义，正文和行内位置保留。JSONL 确认工具尝试先于 `security_block`，记录 provider span 和自审结果。正常退出 0，确认 blocker 退出 1，无效 CLI 参数退出 2。
- **Reviewer 失败行为**。本地网关替身的 503、超时、401 均走模型失败 warning、退出 0。缺模型密钥时两个版本均由 pi 报启动配置错误、退出 1。GitLab 替身 401 时，真实工具调用给模型错误结果，评论写入为零。传播到宿主的 GitLab 鉴权硬错误另有单测。
- **扩展发现**。保留 reviewer 原 argv 和配置来源，Flower 自带工厂使用命名 inline 入口。两版同一夹具的常用工具集合一致。0.76.0 默认加载项目与用户扩展探针。1.6.0 默认信任规则在该干净项目只加载用户探针。把临时项目设为受信后，1.6.0 两处探针均加载。项目是否受信由 pi 配置决定。
- **Ops-bot**。四协议的实际 HTTP 路径与认证均通过，覆盖 Responses、Completions、Anthropic、Gemini。当 Gemini 设为 xhigh 时请求使用 high 的 24576 预算。有效签名触发流式回推与最终消息，无效签名返回 401。模拟模型错误返回用户可见失败，并保留之前有效会话。缺密钥时模型请求为零。通过 1.6.0 Agent 中止本地进行中的请求，服务端观察到连接关闭，记录 `aborted`。
- **旧会话**。0.76.0 的 ops-bot CLI 实际写入 Redis 后退出。1.6.0 在同一键恢复旧用户及模型消息、续写并回读，键和值结构沿用原样，验证 TTL 为 86400 秒。另一会话的模型请求独立。真实 0.76.0 reviewer JSONL 版本为 3，1.6.0 从副本读回历史，向本地模型发送旧工具结果并续答，无历史评论重放。模型缺失的派生夹具报告回退诊断并选中测试配置模型。

## 最终镜像

以仓库根为构建上下文，三个镜像均为 amd64、Node.js `22.23.5`。镜像健康和依赖探针在无外网模式运行，流式应用场景只使用本机回环替身。

| 镜像 | 镜像 ID 前缀 | 结果 |
| --- | --- | --- |
| `flower-pi-upgrade/code-reviewer:1.6.0` | `0eb165beda77` | 默认 ENTRYPOINT、PATH wrapper、四份清单通过。最终层从实际消费目录解析 pi 1.6.0、TypeBox、pi-schema，并读取 photon WASM。默认入口完成真实工具链、双评论、合规和遥测，PATH 入口复验网关 503 的 warning。 |
| `flower-pi-upgrade/ops-bot:1.6.0` | `4f7d0ceb82a1` | 默认入口、健康检查、真实流式回推、旧 Redis 记录续写和失败回复通过。 |
| `flower-pi-upgrade/observer:1.6.0` | `82e6290e2ece` | 默认入口、健康检查、列表页、指标页、四个静态资源及 SQLite 通过。 |

本机详细日志、会话夹具、镜像探针和替身脚本位于 `/tmp/flower-pi-upgrade-verify.LS7HR4/`。
