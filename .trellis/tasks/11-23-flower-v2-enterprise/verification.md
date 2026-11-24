# GitLab Reviewer 本地接入验收

2026-11-23，`v2`，HEAD `58141e90`，Node.js `22.23.4`，npm `10.9.9`。八个工作区。正常 `flower-review` CLI 经 `runReview` 向 `@flower-ai/agent-runtime` 提交一次。共享核心以服务主体和 MR 工作区授权调度公开 SDK `AgentSession`，负责取消、等待、销毁和终态。reviewer 继续装配 provider、工具、合规和观测，判定原评审退出码。 [执行接线](../../../apps/code-reviewer/src/review-execution.ts) · [夹具](../../../apps/code-reviewer/verification/local-review.mjs)

## 业务对照

基线使用本机留存的 pi 1.6.0 升级任务的仓外旧 `flower-review`。候选使用本次构建入口。GitLab 项目为合成的 `123` 和 MR `42`，每次各自建工作目录、pi 配置目录、GitLab 记录和 Observer 数据库。模型网关、GitLab、Observer 使用本地服务，备注中旧 blocker 用于核对跑前评论 ID 差集。代理修复后复跑，候选 27 个场景通过。旧 CLI 与候选的 16 组配对中，规范化的模型请求路径、工具、评论载荷、退出码、扩展标记与 Observer 摘要逐项一致。

| 场景 | 本地验收 |
| --- | --- |
| 普通评审和 blocker | 普通退出 `0`，blocker 退出 `1`。各捕获一条 `notes` 和一条 `discussions`。整体和行内正文保留普通路径并转义快捷指令。行内位置为 `src/index.ts:2`，完整保留 `base/start/head`，blocker 保留 HTML marker。旧评论不计入当前轮。 |
| 无依据和自审 | 无文件读取的行内评论触发额外一条整体无依据通知并退出 `1`。自审工具结果返回给模型。 |
| 环境及目标 | 验证默认 Responses 和显式 Completions 的请求和 `X-App-Source`。CI 环境为 IID `43` 时，显式 `--mr-iid 42` 的所有 MR 请求一致使用 `42`。只提供 CLI 参数时同样通过。 |
| 试跑与合规 | 模型仍实际尝试整体和行内评论。两次尝试均由工具门禁拒绝，捕获的评论 POST 为零。原 CI shell 门禁仍生效，工具尝试事件先于 `security_block`，文件标记出现次数为零。 |
| 网关和错误处理 | 网关 `401`、`503`、provider 请求超时各发一条 warning 并退出 `0`。GitLab 401 作为工具错误回到模型，评论为零。传播到宿主的鉴权硬错误由 reviewer 单测验证。无效参数退出 `2`，缺模型密钥退出 `1`，两例模型请求和评论均为零。 |
| 总超时 | 模型响应挂起、整体评论响应挂起和行内降级评论响应挂起均触发共享运行取消。夹具观察对应连接关闭。已发出的评论记录为结果待核对，后续评审评论为零。每轮仅另发一条超时提示，退出 `0`，Observer 只收到一条结束事件。 |
| 项目信任 | 旧 CLI 与候选覆盖非交互 `ask`、默认允许、记忆允许、两种允许被用户级 `no` 覆盖及记忆拒绝。两种明确拒绝的项目扩展初始化及信任回调标记均为零。前序处理器报错及 `undecided` 后仍可采纳拒绝。 `remember: true` 将已记忆的允许改为拒绝。 |

## 会话与观测

- 用旧正常 CLI 生成的 pi JSONL 副本预置旧历史，SDK 能读到旧工具结果。候选正常入口生成第二份 JSONL，首个模型请求无旧工具结果，两条评论仅对应当前请求。共享运行时快照在 reviewer 进程中。独立原生 Agent 双宿主用例复跑，另覆盖 SDK 装配失败、装配中取消、释放完成后启动下一项及单一终态。
- Observer 使用真实 HTTP NDJSON 写入 SQLite。候选的事件详情逐条与原始 JSONL 相同，包含模型、工具、合规、评论、自审、运行摘要和结束事件。普通用例重启 Observer 后可回读。普通用例 25 条事件和最大序号 42 与旧 CLI 一致。既有流式事件编号缺口使该 trace 展示 `incomplete`。
- 总超时等待 SDK 及可取消 I/O 收敛。第三方扩展若阻塞且不响应中止，仍由外部 Runner 硬时限兜底。内置 llama.cpp 仍按设计列为独立兼容评估项。

## 企业网络兼容回归

独立复核在同一用户级 `settings.json` 下观测到旧 CLI 的 `FLOWER-PROXY-MATCH true` 与迁移候选的 `false`。pi 1.6.0 的 CLI 引导会应用用户级 `httpProxy` 并装配全局 dispatcher。公开 SDK 的会话入口由宿主负责该引导。[网络接线](../../../apps/code-reviewer/src/review-network.ts) · [代理夹具](../../../apps/code-reviewer/verification/local-proxy.mjs)

Reviewer 在首次 GitLab 预检前装配与 pi 1.6.0 同版本的 Undici `8.12.4`，`httpProxy` 仅补未设置的 `HTTP_PROXY` 和 `HTTPS_PROXY`。沿用 Undici 的环境优先规则、`NO_PROXY` 和 HTTP CONNECT。用户和项目资源完成信任判定后，生效的 `httpIdleTimeoutMs` 同时设置响应头和响应体。代理配置无效时以退出码 `2` 停止，诊断隐去代理值。

| 场景 | 仓内、仓外 npm bin 及最终镜像的实测结果 |
| --- | --- |
| `proxy-settings` | 用户扩展在 `session_start` 看到代理环境。源站按上游 socket 核对 GitLab 预检、评论和模型的全部 12 条请求均经设置中的代理抵达。 |
| `proxy-bypass` | `NO_PROXY` 用回环主机和端口匹配源站，全部 12 条 GitLab 与模型请求直达，代理收到零条 CONNECT。 |
| `proxy-explicit` | 12 条 HTTP 模型和 GitLab 请求经 `HTTP_PROXY` 抵达。1 条使用本地测试 CA 的 HTTPS 请求经另一个 `HTTPS_PROXY` 抵达。设置中的代理收到零条 CONNECT。 |
| `proxy-idle` | 生效时限设置为 400 毫秒。停在响应头和停在首块后的响应体分别报告 `UND_ERR_HEADERS_TIMEOUT` 与 `UND_ERR_BODY_TIMEOUT`，随后正常完成评审。 |
| `proxy-invalid` | 启动退出 `2`，源站请求、模型请求及评论均为零。 |

## 构建和制品

| 检查 | 结果 |
| --- | --- |
| 安装、构建与类型 | `npm ci --no-audit --no-fund` 干净安装 293 个依赖。根 `npm run clean`、`npm run build`、`npm run typecheck` 通过。历史 `TS6310` 本次未复现。reviewer 与共享核心均解析 pi `1.6.0`。 |
| 全仓与规范 | 最终复跑 38 个测试文件、690 项通过。reviewer 194 项、runtime 19 项、GitLab 工具 153 项。修改范围 Biome 及 `git diff --check` 通过。首轮并行验证触发 CLI 帮助测试超时，参数解析提前到 SDK 加载之前后已复验。旧 `Promise.race` 包装器的测试由共享运行取消回归与真实 HTTP 超时夹具接替。 |
| 仓外 npm bin | 共享核心、reviewer 和四个产品依赖打成同批本地 tarball，在独立目录安装。真实 `node_modules/.bin/flower-review` 的帮助、正常评审、dry-run 及五种代理用例通过。普通评审和 dry-run 分别退出 `0` 且捕获两条与零条评论，并通过 Observer 回读。 |
| 最终镜像 | `flower-enterprise/reviewer:local`，镜像 ID `sha256:2787fd993cab254d15c67b88187e9294b5aac9f5d490581f754a5adb965b7721`。最终层 Node `22.23.5`，实际消费目录可导入 runtime、pi SDK 和 Undici。四份 skills、可执行 CLI 和 photon WASM 可读。无网络帮助冒烟通过。默认 ENTRYPOINT 的正常评审退出 `0`，PATH wrapper 的 blocker 退出 `1`，各捕获双评论。PATH wrapper 试跑退出 `0`，评论为零。默认 ENTRYPOINT 和 PATH wrapper 合计五种代理用例均通过。 |

## 本机 registry 单包试装（公开分发决定前）

复用候选 `0.1.0` 已验收的六份 tarball。临时 registry 在 `http://127.0.0.1:42823/` 按原清单提供元数据和制品，核心清单的 `private: true` 原样保留。两个仓外消费目录分别使用空缓存。隔离的 `.npmrc` 将 `@flower-ai` 全部指向该地址，公开第三方包从 `registry.npmjs.org` 获取。

```bash
npm install @flower-ai/flower-code-reviewer@0.1.0
```

- 仅缺核心时，npm 对 `@flower-ai/agent-runtime@0.1.0` 报 `E404`，退出 `1`。补入同批真实核心制品后，在全新目录重跑同一命令，退出 `0`。registry 记录六个 Flower tarball 全部收到 GET 并返回 `200`。
- 成功目录的 `package.json` 和 lockfile 根 `dependencies` 均为 `{"@flower-ai/flower-code-reviewer":"0.1.0"}`。核心和其余 Flower 依赖由 npm 自动解析。安装无 workaround。
- 核心锁定为 `0.1.0`，`resolved` 为 `http://127.0.0.1:42823/@flower-ai/agent-runtime/-/agent-runtime-0.1.0.tgz`，`integrity` 为 `sha512-Kmy9CNskMpiCPUxtLvIwtGKI6UdbTxqTVFkDnZc3VxjelaGrwhTuUZG/RgErUiarZyUx9bVDytIASU8kxq/Zlg==`，与 tarball 字节一致。六包安装清单与原封包清单一致。
- 从成功目录的 `node_modules/.bin/flower-review` 启动合成 MR。bin 解析到该目录下的 `@flower-ai/flower-code-reviewer/dist/cli.js`，从 CLI 位置解析的核心是同一消费目录下的 `@flower-ai/agent-runtime/dist/index.js`。评审退出 `0`，捕获一条整体评论和一条行内讨论。Observer 写入并回读 25 条事件，重启后回读一致，`incomplete` 与既有基线相同。

证据位于 `/tmp/flower-enterprise-registry.UWXS2u/`。查看 `summary.json`、`registry.jsonl`、`missing-core.log`、`with-core/package-lock.json` 和 `reviewer-fixture.log`。运行 `node --experimental-import-meta-resolve /tmp/flower-enterprise-registry.UWXS2u/trial.mjs` 可重新分配端口和消费目录。

## 根 npm 发版检查（公开分发决定前）

| 检查 | 实测结果 |
| --- | --- |
| `npm run release:verify` | 从当前工作区构建并新打包六个制品。空缓存的仓外目录只运行 `npm install @flower-ai/flower-code-reviewer@0.1.0`。npm 解析并下载全部六个制品，安装无 workaround。核心锁定为 `0.1.0`，`resolved` 指向回环 registry，`integrity` 与此次 tarball 一致。核心和真实 CLI 均解析至消费目录自己的 `node_modules`。 |
| 合成 MR | 使用消费目录的 `node_modules/.bin/flower-review` 运行现有 `normal` 夹具，退出 `0`，捕获转义后的整体评论和行内评论。Observer 回读 25 条事件，重启后结果一致。 |
| 实际候选的安装负例 | 新封包的当前 Reviewer 与其他依赖相同。registry 缺核心时 npm 退出 `1`，报 `E404`。仅有不匹配的核心时 npm 退出 `1`，报 `ETARGET`。两次错误均指向 Reviewer 所需的 `@flower-ai/agent-runtime@0.1.0`。 |
| `node --test scripts/release-verify.test.mjs` | 9 项通过。目标 registry 缺核心或只有错版本均阻断公开 Reviewer。可下载准确版本时从无鉴权配置的隔离目录取得真实 tarball。Reviewer 当前版本已存在或采用私有或 restricted 设置时跳过检查。隔离目录运行根命令链，用探针替代最后的发布命令，验证检查失败时未到达该步骤。 |
| 回归 | `npm run typecheck` 通过。根 `npm test` 通过 38 个文件、690 项。修改范围 Biome、`git diff --check` 和任务上下文检查通过。 |

本地 registry 保留核心的 `private: true`。Changesets 会跳过该核心。公开 Reviewer 当前版本待发时，目标 registry 必须能够匿名提供清单指定的核心制品。当前版本已存在时，独立包沿用原发布流程。核心的实际分发渠道待定，保持现有版本及 Changesets 记录。

日志在 `/tmp/flower-release-check.eJBRzO/`。`release-verify-final.log` 含直接安装项、CLI 与核心路径、核心完整锁定信息及夹具输出。`actual-candidate-negative-final.log` 和对应消费目录的 `stderr.log` 记录实际封包负例。`guard-tests-final.log` 记录命令链检查。正例 MR、评论和 Observer 证据在 `/tmp/flower-review-normal-6hh451/`。

### 目标核心的完整性复核

`--publish-check` 以 `npm pack --json` 匿名下载目标 registry 中的指定核心。npm 以 tarball 实际字节计算 SHA-512 SRI。该 SRI 须等于本轮本机 registry 所提供的核心制品的 SRI，仓外 npm lockfile 也须记录相同值。

同版本差异回归在隔离目录复用根发布命令链。目标核心和同批核心的名称、版本及清单一致，目标 tarball 多一个 README。目标下载成功，SRI 检查失败，发布探针未运行。`node --test scripts/release-verify.test.mjs` 通过 11 项。根类型检查和全仓 690 项测试通过。

正式检查路径用独立的回环 registry 提供当前核心真实封包。匿名下载、同批封包和消费 lockfile 的 SHA-512 SRI 一致。仓外 CLI 的正常评审退出 `0`，两条评论及 25 条 Observer 事件通过夹具断言。证据位于 `/tmp/flower-release-sri.DPJeH3/publish-check-positive.log` 和 `/tmp/flower-release-sri.DPJeH3/guard-tests.log`。

Changesets 2.31.0 会以 `Promise.all` 调度待发包。未来公开核心尚未可下载时，同批首次发布会被拦下。若获准公开，需先单独发布核心并确认可匿名下载，再发布 Reviewer。回归覆盖把核心设为非私有但目标仍缺包的场景。

## 八个 npm 工作区公开分发（版本覆盖复核前）

当前工作区的八包均为 `0.1.0`，清单使用 `publishConfig.access: public`。根聚合包继续 `private: true`。核心首发沿用仓库已有包的 `0.1.0` 首发标签惯例，本轮保留原有三个待发 Changeset。隔离副本运行 `npm run version-packages`、更新锁文件并重新 `npm ci` 后，Reviewer、Observer、Compliance、Telemetry 计划为 `0.2.0`，其余四包保持 `0.1.0`。Reviewer 清单与锁文件均精确要求核心 `0.1.0`。版本演练记录见 `/tmp/flower-public-release.bgozf5/version-plan.json`。

核心使用 MIT 许可证。导出的 tarball 含清单、`LICENSE`、`dist` 的 ESM 入口和声明及其映射，共 10 个文件。`npm publish --dry-run` 对回环目标确认访问级别为 public，SRI 与仓外 Reviewer 消费 lockfile 一致。首发命令见[根 README](../../../README.md#npm-发版检查)。

隔离副本的根 `npm run release` 用探针替代最终 Changesets 发布。目标缺核心时退出 `1`，未触达探针。随后同一个回环 registry 提供 `--export-core` 导出的 tarball。完整发布检查匿名下载核心，锁定 SRI 与导出及 dry-run 一致。干净目录只安装 Reviewer `0.2.0`，真实 CLI 退出 `0`，捕获两条测试评论并回读 25 条 Observer 事件，最终到达发布探针。模拟 registry 只收到 GET。证据位于 `/tmp/flower-public-release.bgozf5/` 的 `summary.json`、`release-before-core.log`、`release-verify-export.log`、`core-publish-dry-run.log`、`release-after-core.log` 和 `registry.json`。

隔离副本干净安装和构建、当前工作区 `npm run typecheck`、全仓 690 项、发版检查 11 项、修改范围 Biome 和 `git diff --check` 通过。

## 公开候选的版本覆盖复核

对照已发布 `0.1.0` 标签，Providers、GitLab 工具和 Ops-bot 仍声明 pi `^0.75.0` 系列。三包的当前工作区已升至 pi `1.6.0`。新增一条 minor Changeset 覆盖这三包，原有三条记录继续覆盖 Reviewer、Observer、Compliance 和 Telemetry。首发核心保持 `0.1.0`。

隔离副本运行 `changeset status`、`npm run version-packages`、锁同步、干净安装、构建和类型检查。七个待发工作区变为 `0.2.0`。Reviewer 的核心依赖精确为 `0.1.0`，其余四个 Flower 库均精确为 `0.2.0`。Observer 精确依赖 Telemetry `0.2.0`，Ops-bot 精确依赖 Providers `0.2.0`。工作区清单与锁文件一致。版本计划和依赖图见 `/tmp/flower-release-versions.hUDdZo/changesets-plan.json` 和 `/tmp/flower-release-versions.hUDdZo/versions-and-dependencies.json`。

同一个回环 registry 先仅列出 Providers、GitLab 工具的旧 `0.1.0`，安装 Reviewer `0.2.0` 报 `ETARGET`。加入真实候选制品后，mock 的旧包 `latest` 仍指向 `0.1.0`。新消费目录只安装 Reviewer `0.2.0`，npm 按精确版本安装六个同批 Flower 制品。消费 lockfile 里的版本和 SRI 与封包逐一匹配，旧 tarball 请求为零。实际 CLI 退出 `0`，捕获两条测试评论，Observer 回读 25 条事件。隔离副本全仓 690 项通过。证据见 `/tmp/flower-release-versions.hUDdZo/summary.json`、`registry.json` 和 `workspace-tests.log`。

## 复跑

从仓根执行以下示例。夹具输出根目录内保留 `observations.json`、`cli.log`、完整 Observer 详情与 SQLite，所有评审载荷均为合成数据。

```bash
node apps/code-reviewer/verification/local-review.mjs normal
node apps/code-reviewer/verification/local-review.mjs trust-deny-memory
node apps/code-reviewer/verification/local-review.mjs timeout-write
node apps/code-reviewer/verification/local-review.mjs proxy-explicit
FLOWER_VERIFY_IMAGE=flower-enterprise/reviewer:local FLOWER_VERIFY_IMAGE_PATH=1 \
  node apps/code-reviewer/verification/local-review.mjs blocker
```

用 `FLOWER_VERIFY_COMMAND='["/绝对路径/node_modules/.bin/flower-review"]'` 选择指定仓外入口。旧入口配合 `FLOWER_VERIFY_MODE=baseline`。用同一场景生成两份 `observations.json` 对照。代理修复后的日志在 `/tmp/flower-enterprise-proxy.nuun4n/`，分别见 `candidate/`、`parity.log`、`consumer-*.log`、`docker-*.log` 和 `test.log`。旧入口的配对基线及旧 JSONL 验证记录保留在 `/tmp/flower-enterprise-verification.DT4PBN/`。
