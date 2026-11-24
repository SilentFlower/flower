# GitLab Reviewer 实施与验收

按 [设计](design.md) 迁移正常 `flower-review`。以当前 `v2` 工作区的 8 个包及 pi `1.6.0` 为基线，记录实际 HEAD、Node/npm 版本、旧 CLI 和镜像标识。

## 实施顺序

1. **固定对照夹具。** 将已验证的回环 HTTP 模型和 GitLab 响应整理为本任务可复跑测试入口。参考 `/tmp/flower-enterprise-plan.1BNBdn/verify-reviewer.mjs` 和该目录的 SDK 探针。用项目 `123`、IID `42`、固定源码、diff refs、已有 bot 评论和工具调用脚本。old 与 candidate 各用独立临时 checkout、agent dir、轻量模型服务状态和 Observer SQLite。启动真正的本地 Observer，通过 `FLOWER_TELEMETRY_URL` 接入 `/v1/events`，以只读 API 回读；模型、GitLab、Observer、SIEM 的测试配置仅指向本机或禁用。记录相同输入下的规范化 JSON，保留评论正文、位置和顺序，忽略每次生成的 trace ID、时间和耗时。先用原正常 CLI 记录对照。
2. **接到共享调度。** 在 `packages/agent-runtime/src/{index,types}.ts` 实现最小的可选执行适配；使用同一授权、排队、取消、持久化和终态路径。补适配器创建失败、创建时取消、等空闲后单次终态的回归。reviewer 适配模块封装 SDK 服务、model 解析、会话和扩展绑定。资源加载通过公开回调先接入现有 `project_trust` 决定，再加载最终扩展。保留对 `extension.ts` 的直接复用，由 `runReview` 提交一次。更新 reviewer 单测的 mock 边界，让 fixture 从真实 CLI 打到真实共享包及 SDK。以受控测试观测运行 ID、SDK 工具循环和唯一终态。
3. **对齐业务和退出。** 保留 MR 上下文、skill/harness、结果扫描、失败 warning、自审、遥测与收尾。核对 `--mr-iid` 生效后所有工具仍指向同一 MR。`--dry-run` 用刻意请求评论的模型验证外发次数为零。分别测试 provider timeout 与总软超时。对总超时使用挡住模型响应和挡住评论操作的 fixture，分别观察模型连接关闭、写中止后无新请求、一次 warning 和一次遥测收尾；已到替身但结果不明的评论单列，不能从取消推断未收到。沿用 provider 正常重试策略。旧会话仅用副本回读，验收新 CLI 每次开单独会话且旧 tool result 未自动送入模型。
4. **验证交付。** 更新 reviewer 清单、TS reference、根锁文件及 `apps/code-reviewer/Dockerfile`。从实际 consumer 目录检查裁剪后的 runtime 和 pi 解析。打包核心、reviewer 及四个依赖库，仓外用同批 tarball 安装后执行 `node_modules/.bin/flower-review`。从仓根构建 reviewer 镜像，用默认 ENTRYPOINT 和 PATH wrapper 分别接同一夹具，核对最终层入口、四个 skills、pi 动态加载资源与运行时依赖。记录构建/CLI/镜像指纹及原始证据到 `verification.md`。

## 对照矩阵

| 场景 | 通过条件 |
| --- | --- |
| 正常、blocker 与无依据 | 普通 `0`、blocker 和无依据 `1`。已有评论只作对照；捕获整体 `notes` 与行内 `discussions` 的完整 JSON，保留普通斜杠、转义、blocker marker、diff SHA、路径、行号。核对一次运行的调用计数、重定位或降级和自审结果。 |
| 权限、发现与模型 | 同一工具集合和 Havefun 默认 Responses/显式 Completions，按协议核对 auth、模型及 `X-App-Source`。被合规拦下的工具副作用为零，工具尝试早于 `security_block`。CI 目标和 dry-run 用实际 HTTP 捕获验收。 |
| 项目信任 | 在旧 CLI 与候选 CLI 各运行同组良性标记探针。非交互 `ask` 只加载用户扩展。无用户决定时，默认 `always` 和 store 已记忆允许分别可加载项目扩展。在这两个允许场景分别加入用户级 `no`，确认只加载用户扩展，项目初始化标记及项目 `project_trust` 标记均为零。用 `undecided → no → yes` 验证首个明确决定短路。前置处理器抛出哨兵错误时，诊断与后续拒绝均可见。普通拒绝保留原 store，`remember: true` 的拒绝写回 store。每例核对本地工具和评论载荷依旧一致。 |
| 失败与退出 | 网关 `401`、`503`、请求超时及总软超时为 `0` 加一条 warning。CLI 参数错误为 `2`，缺模型密钥为 `1`。模型收到 GitLab `401` 工具错误时保留基线行为，传到宿主的鉴权硬错误为 `2`。单列 pi 终止状态与 reviewer 退出码。 |
| Observer 与历史 | 从 `/api/traces` 和详情回读相同的 MR 关联、provider、工具尝试/结果、合规拦截、评论、自审、运行摘要、结束和聚合计数；HTTP 与 JSONL 可按序号对应。基线已有的 `incomplete` 另记，检查新增缺口和重复事件。重启本地 Observer 后从同一 SQLite 查回。正常 CLI 新建 pi JSONL，不触发历史评论重放。 |

## 命令

命令从仓根运行。新增夹具 `apps/code-reviewer/verification/local-review.mjs` 默认走仓内 CLI。用 JSON 数组 `FLOWER_VERIFY_COMMAND` 指定仓外 bin。用 `FLOWER_VERIFY_IMAGE` 指定本地镜像，另设 `FLOWER_VERIFY_IMAGE_PATH=1` 使用容器 PATH wrapper。向 `FLOWER_VERIFY_PRIOR_SESSION` 传入旧 JSONL 副本路径可核对新会话边界。

```bash
npm ci --no-audit --no-fund
npm run clean
npm run build
npm run typecheck
npm run test --workspace @flower-ai/agent-runtime -- test/dual-host.test.ts
npm run test --workspace @flower-ai/flower-code-reviewer
npm run test --workspace @flower-ai/flower-tools-gitlab
npm run test --workspace @flower-ai/flower-observer
npm test
node apps/code-reviewer/verification/local-review.mjs normal
node apps/code-reviewer/verification/local-review.mjs timeout-write
node apps/code-reviewer/verification/local-review.mjs trust-deny-memory
npx --no-install biome check packages/agent-runtime apps/code-reviewer
npm pack --dry-run --workspace @flower-ai/agent-runtime --workspace @flower-ai/flower-code-reviewer
docker build -f apps/code-reviewer/Dockerfile -t flower-enterprise/reviewer:local .
docker run --rm --network none flower-enterprise/reviewer:local --help
docker run --rm --network none --entrypoint flower-review flower-enterprise/reviewer:local --help
```

锁文件更新使用 npm 现有 workspace 机制。全仓类型检查以干净构建为准，若复现历史 `TS6310`，单列诊断并以包含新引用的干净 `tsc --build` 对照。镜像行为运行阶段使用 Linux 本地回环夹具；所有验收材料只记录合成凭据与载荷。
