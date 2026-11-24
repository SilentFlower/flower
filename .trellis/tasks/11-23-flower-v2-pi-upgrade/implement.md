# pi 1.6.0 升级步骤与本地验收

按[设计](design.md)执行。以下是获准开工后的步骤。受控模型、GitLab、钉钉和 Redis 验收使用本机隔离实例与合成数据。布局任务的七包、37 个测试文件和 672 项结果作为回归对照。新增测试时记录新增数量和覆盖项。

## 实施顺序

1. **固定依赖和基线。** 在七包布局下记录 Node、npm、0.76.0 的实际依赖树、干净构建和测试结果。从旧版 ops-bot 与 reviewer 的 pi 会话生成脱敏夹具，分别保留 Redis JSON 与 JSONL 原样副本。核对六个直接消费包的清单。升级其 pi 直依赖到精确的 `1.6.0`，为 reviewer 与 GitLab 加入 `typebox@1.3.27`。重建根锁后以 `npm ci` 安装，检查工作区、锁和运行时解析。记录实际解析的 `pi-schema` 与同组 pi 包版本。
2. **先编译工具，再检查两宿主。** 在 `packages/flower-tools-gitlab` 与 `apps/code-reviewer` 替换工具 schema 的导入。检查 GitLab 文件读取结果、原评论转义测试和工具上下文桩。更新 providers 的 API Key 引用形式。把 ops-bot 流式分派换到四个公开子入口。核对 `AgentEvent` 的文本增量和终止事件以及 signal 传递。用窄 scope 测试验证，再清理所有 TS 增量产物后执行根构建和类型检查。
3. **验证真实 reviewer 入口。** 以编译后的 `flower-review` 进入实际 `piMain`。设置临时 `PI_CODING_AGENT_DIR`、合成 MR 和仅监听回环的模型及 GitLab 替身。用真实模型协议返回工具调用，验证 Flower 工厂先注册 provider，遥测先记录调用意图，合规拦截预期拒绝的操作，GitLab 和自审工具可执行。验证隔离目录的 settings 被使用，项目/用户目录的探针扩展发现行为及可用工具集与旧版业务契约一致。给临时项目写入本地判定标记检查加载范围，并核对现有评审 prompt、清单和上下文读取仍工作。
4. **验证流式与旧记录。** 四协议替身各运行一次同等文本增量和正常终止，核对 URL、认证、明确模型、reasoning 配置和结束回复。增加缺变量、断流/错误以及取消场景，核验既有错误处理及请求终止。用真实 ops-bot CLI 接收签名 webhook 并推到本地钉钉替身。先读旧版写入的 Redis 记录，再跑新一轮并检查先前两侧消息进入模型上下文。回读原键的新消息、`updatedAt` 和 TTL，并在另一会话检查无串历史。单独用临时副本打开旧 reviewer JSONL，加入可识别的历史工具结果，通过请求记录证明续用旧记录时只执行当前请求明确发出的工具。
5. **调整镜像并走最终制品。** 按实际 workspace 闭包装入编译产物、npm 生产依赖及资源。对照 1.6.0 锁文件审查 reviewer 的手工提升、裁剪及 `koffi` 逻辑，优先维持 npm 解析布局。现有 Dockerfile 只复制应用依赖闭包，若完整根锁的 `npm ci` 无法用于该模式，按镜像实际闭包验证安装结果和解析版本。构建期和最终层分别检查 pi 解析。最终镜像执行实际应用场景，再填写验收记录。

## 验收矩阵

| 面 | 本机通过条件 |
| --- | --- |
| 工作区和安装 | npm、Trellis、TS references 与实际 tarball 均为三个应用加四个共享库。对照锁和应用入口解析，证明所有 pi 依赖使用 1.6.0 稳定组。两个用 TypeBox 的包能从仓外安装直接解析其依赖。 |
| reviewer | 默认和显式模型命中 `havefun-*`，认证与 `X-App-Source` 正确。实际两种评论工具提交到本地替身的 `/notes` 与 `/discussions`，正文保持转义、行位置信息和普通文本。真实执行验证 telemetry、compliance 和自审追踪。正常、确认 blocker、GitLab 鉴权等硬错误分别为退出码 0、1、2。另测网关 5xx/超时的 fail-open 及 warning 路径。分别记录扩展装配失败、缺模型配置及模型网关 401 的分类，并与旧行为对照。 |
| ops-bot 与历史 | 签名拒绝、有效回调先应答、增量与最终回复正确。四协议通过受控流式替身。实际旧 Redis 消息可读回并继续，另外一个会话独立。Reviewer 旧 JSONL 在临时副本验收，记下模型缺失时的诊断及选模结果。 |
| npm 制品 | 仓外安装七个 tarball，验证 `flower-review --help`、四份清单、从 GitLab 包根调用两种评论工具、`flower-ops-bot` CLI 和 Observer 页面资源。 |
| 最终镜像 | 从仓库根按各 Dockerfile 本地构建，记录镜像架构与容器内 Node 版本。Reviewer 默认 ENTRYPOINT 与 PATH wrapper 都启动，最终层从实际消费目录解析 pi、TypeBox 和 pi-schema，并在其真实入口跑受控模型和工具调用。ops-bot 最终层验证 `/healthz` 和受控流式回调。Observer 验证 `/healthz`、列表、指标、静态文件及 SQLite，检查依赖裁剪。临时测试网络只连接本地替身。 |

## 已有命令与待新增验证

在仓库根执行已有命令。将 dry-run 与实际安装包验证都记入记录。

```bash
npm ci
npm run clean
npm run build
npm run typecheck
npm test
npm query .workspace
python3 .trellis/scripts/get_context.py --mode packages
npm pack --dry-run --workspaces
```

另用 `npm pack --workspaces --pack-destination <临时目录>` 生成 tarball，在仓外独立安装。镜像按现有入口执行 `docker build -f apps/<应用>/Dockerfile -t flower-pi-upgrade/<应用>:1.6.0 .`。受控 provider、旧会话夹具、真实入口测试与最终层探针属于实施阶段待新增或适配的测试，沿用当前 Vitest 和本地冒烟约定，记录实际执行命令、日志、镜像 ID、版本和场景结果。

如根 `npm run typecheck` 重现 company 研发日志第 742 行的 `TS6310` 或增量缓存问题，单列该结果并保留完整失败日志。清理增量产物后，用含七包的完整 `tsc --build` 核验类型，再分别记录结果。根脚本沿用基线。以布局验收中的 Observer 格式诊断作为 Biome 对照。升级通过后将实际依赖和验证记录交给 runtime 任务。
