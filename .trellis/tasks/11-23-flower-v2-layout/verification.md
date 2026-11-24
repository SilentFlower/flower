# 目录整理验收记录

## 历史验收：目录迁移阶段

基线为 `v2` 整理前的 `58141e90`，本机使用 Node.js `22.23.4` 和 npm `10.9.9`。三应用及资源分别归入 `apps/code-reviewer`、`apps/ops-bot`、`apps/observer`，六个共享库位于 `packages/`。npm 和 Trellis 均发现九个包，移动前后的依赖锁定项一致。

| 检查 | 结果 |
| --- | --- |
| 整理前基线 | 干净安装、完整构建、类型检查及 671 项回归通过。 |
| 整理后工作区 | `npm ci`、清理后完整构建、`npm run typecheck` 及 672 项回归通过。根构建产出了 Observer 的 `dist/static`。 |
| 代码风格 | 变更配置和 CLI 文件通过 Biome。全量只读扫描与基线有相同的三处诊断，分别是 Observer 页面路由的格式错误和 ops-bot 工具装配的两处 `noExplicitAny` 警告。 |
| 包外运行 | 九个包均通过 dry-run 和实际打包。仓外安装 tarball 后，`flower-review --help`、评审清单、`flower-ops-bot /healthz`、Observer `/healthz`、`/traces`、`/metrics` 和四个静态资源均通过。 |

旧布局的 npm 符号链接启动可复现 reviewer 返回空帮助。应用入口改用 Node 的入口标记，新增测试覆盖符号链接和仓外工作目录。

### 目录迁移镜像

三个 Dockerfile 均从仓库根目录构建。首次下载依赖出现 registry 超时，最终构建使用本机的 HTTP 代理。冒烟容器通过自身回环地址完成检查。

| 镜像标记 | 镜像 ID 前缀 | 冒烟结果 |
| --- | --- | --- |
| `flower-v2-layout/code-reviewer:v2-final-58141e90` | `37a05307c791` | 默认 ENTRYPOINT 和 PATH 上的 `flower-review` 均输出帮助。四份评审清单可读，应用产物中的声明文件和 source map 已清理。 |
| `flower-v2-layout/ops-bot:v2-58141e90` | `1a62b08ac27a` | 默认命令启动，`/healthz` 返回成功。 |
| `flower-v2-layout/observer:v2-58141e90` | `c0629001c024` | 默认命令以 `node` 用户启动，`/healthz`、列表页、指标页、四个静态资源及 SQLite 文件通过检查。 |

本机验证日志位于 `/tmp/flower-layout-verification.LkeJh8/`。

## 历史验收：占位工具清理阶段

该阶段使用相同的 Node.js 和 npm 版本。三个应用与五个共享包组成当时的工作区。

| 检查 | 结果 |
| --- | --- |
| 工作区与构建图 | npm、Trellis、根 TypeScript references、锁文件的 workspace 链接和实际 tarball 均核对为相同八包。清单、锁、TS、Docker 和活动 Trellis 规则中的旧包引用为零。保留依赖的锁定版本集合一致。 |
| 编译和测试 | `npm ci`、`npm run clean`、`npm run build`、`npm run typecheck` 通过。37 个测试文件、672 项回归通过。 |
| 包外评论转义 | 从仓库外安装八个 tarball。Common 根入口仅导出 `sanitizeQuickActions`。检查了命令大小写、已转义行、普通文本和路径。调用打包后的 GitLab 整体及行内评论工具，通过本地请求拦截核对发出的 JSON 正文。 |
| 包外应用 | `flower-review --help`、四份评审清单、`flower-ops-bot /healthz`、Observer 的健康检查、列表页、指标页及四个静态资源通过。 |
| 钉钉收发及会话 | 从仓外启动打包后的 CLI，以本机 HTTP 服务模拟模型与钉钉回复地址。无效签名返回 401。三次有效回调均收到累积回复，同会话第二轮包含上一轮消息和回答，另一会话独立。三次模型请求的工具列表均为空。本次使用进程内会话存储。 |
| 代码风格 | 改动范围的 Biome 检查和 `git diff --check` 通过。应用及包级扫描仍有一处基线格式诊断，位于 Observer 的 `apps/observer/src/routes/pages.ts`。 |

### 增量清理镜像

三个镜像分别用仓库根作为上下文重新构建，本机 registry 下载使用 HTTP 代理。冒烟容器使用无外网网络模式。

| 镜像标记 | 镜像 ID 前缀 | 冒烟结果 |
| --- | --- | --- |
| `flower-v2-layout/code-reviewer:v2-cleanup-58141e90` | `a395d056e907` | 默认入口、PATH wrapper、四份评审清单及镜像内 Common 根导出与转义通过。 |
| `flower-v2-layout/ops-bot:v2-cleanup-final-58141e90` | `3ec2c5fe6961` | 默认入口和 `/healthz` 通过。镜像的 Flower 共享依赖只有 providers。 |
| `flower-v2-layout/observer:v2-cleanup-58141e90` | `e16ee45b30ed` | `/healthz`、两个页面、四个静态资源及 SQLite 通过。 |

本机详细日志与验证脚本位于 `/tmp/flower-v2-cleanup-verify.eOTv9D/`。

## 当前验收：GitLab 包内评论转义

最终工作区由 `apps/code-reviewer`、`apps/ops-bot`、`apps/observer` 和 GitLab、providers、compliance、telemetry 四个共享包组成。本机使用 Node.js `22.23.4` 和 npm `10.9.9`。

| 检查 | 结果 |
| --- | --- |
| 目录和构建图 | npm、Trellis、根 TS references、锁文件 workspace 链接和 tarball 清单对照一致，共七个包。旧包目录、依赖链接及活动构建引用已清除。锁文件相对上一阶段只删除 Common 包项和 GitLab 依赖边。 |
| 干净安装、构建和回归 | `npm ci`、`npm run clean`、`npm run build`、`npm run typecheck` 通过。37 个测试文件共 672 项通过。迁移的 50 个转义单测在 GitLab 包运行，原 4 个评论工具集成测试通过。 |
| 包外评论 | 仓外安装七个 tarball。从 GitLab 包根调用整体和行内工具，用本地拦截核对 `/notes` 和 `/discussions` JSON 正文。快捷指令转义正确，普通正文、路径及已转义内容保留。转义函数为包内模块。 |
| 包外应用 | `flower-review --help`、四份清单、ops-bot 健康接口、Observer 两个页面和四个静态资源通过。用本地模型及钉钉回调模拟验证了签名拒绝、回复、同会话历史和会话隔离。本次使用进程内会话存储。 |
| 代码风格 | 变更文件的 Biome 检查和 `git diff --check` 通过。应用和共享包扫描仍有一处既有格式诊断，位于 Observer 的 `apps/observer/src/routes/pages.ts`。 |

三个镜像以仓库根为上下文重新构建，冒烟运行在无外网网络模式。

| 本地镜像标记 | 镜像 ID 前缀 | 冒烟结果 |
| --- | --- | --- |
| `flower-v2-layout/code-reviewer:v2-gitlab-sanitize-58141e90` | `25e2d1f3356c` | 默认入口和 PATH wrapper 均输出帮助，四份评审清单可读。最终运行层验证了 reviewer 扩展、GitLab 工具，以及 reviewer、GitLab、providers 三处的 pi 依赖解析。在容器内再次拦截两种评论工具的出站 JSON 并核对转义。 |
| `flower-v2-layout/ops-bot:v2-gitlab-sanitize-58141e90` | `cab5e1e691d3` | 默认入口和 `/healthz` 通过。 |
| `flower-v2-layout/observer:v2-gitlab-sanitize-58141e90` | `497f81e41086` | `/healthz`、列表页、指标页、四个静态资源及 SQLite 通过。 |

本机验证日志、tarball 和验证脚本位于 `/tmp/flower-v2-gitlab-sanitize.Fw6X53/`。

## 后续公司 CI 配套

- `company/company` 和 `company/company-test` 的 reviewer `SUB_DIR` 使用 `apps/code-reviewer`。采用路径筛选的流水线纳入 reviewer 和 GitLab、providers、compliance、telemetry 四个实际依赖。
- `company/company` 的 Observer `SUB_DIR` 使用 `apps/observer`，路径筛选纳入新应用目录。部署清单路径改为 `apps/observer/deploy/k3s-observer.yaml`。
- ops-bot 的实际消费流水线以 `apps/ops-bot/Dockerfile` 和仓库根构建上下文为准。若接入同一模板，使用 `SUB_DIR=apps/ops-bot` 并纳入共享依赖 providers 的路径。
