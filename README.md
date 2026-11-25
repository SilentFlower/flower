# Flower

Flower 基于 [pi-mono](https://github.com/earendil-works/pi-mono) 构建。仓库包含 GitLab 代码评审、钉钉运维机器人和 Observer 观测服务。

## 应用入口

| 应用 | 当前能力 | 运行方式 |
| --- | --- | --- |
| [GitLab 代码评审](apps/code-reviewer/README.md) | 根据 MR 变更选择评审清单并读取相关代码，通过 GitLab 工具提交行内和整体评论。已接入只读约束、审计和评审 trace。 | `flower-review`，通常由 GitLab CI 启动，一次评审后退出。 |
| [钉钉运维机器人](apps/ops-bot/README.md) | 接收钉钉 webhook，按会话管理历史并流式回复。配置 `REDIS_URL` 后使用 Redis 保存会话。 | `flower-ops-bot`，默认监听 `3000`，健康检查为 `/healthz`。 |
| [Flower Desktop](apps/desktop/README.Windows.txt) | 本地工作区、Agent 会话与文件交付。可配置模型、主题和首页内容。 | Windows x64 安装 EXE、便携 ZIP 及两种 Mac 架构的手动安装 DMG 通过 [GitHub Releases](https://github.com/SilentFlower/flower/releases) 分发，详见[桌面发行说明](apps/desktop/RELEASE.md)。 |
| [Observer](apps/observer/README.md) | 接收遥测与审计事件，经 SQLite 幂等入库，提供 trace 列表、回放和指标页面。 | Node 常驻服务，默认监听 `4810`。访问 `/traces`、`/metrics` 和 `/healthz`。 |

评审 CLI 通过 `pi-coding-agent` 的 print 模式运行。钉钉机器人直接使用 `pi-agent-core` 的 `Agent`，根据用户提供的信息和会话历史给出运维排查建议。评审 trace 可写入 JSONL，配置 HTTP sink 后可发送给 Observer。更早的设计和源码样例见 [架构手册](docs/intro.html)。

## 仓库结构

```text
flower/
├── apps/
│   ├── code-reviewer/       # CLI、评审清单、GitLab CI 示例及 Dockerfile
│   ├── ops-bot/             # 钉钉 webhook、会话与 Dockerfile
│   ├── observer/            # 事件接收、SQLite、页面资源与 Dockerfile
│   └── desktop/             # Electron 工作台、界面组件与 Windows 打包
├── packages/
│   ├── agent-runtime/       # 企业与桌面共享的 pi 核心
│   ├── flower-providers/    # 提供方注册和模型配置
│   ├── flower-tools-gitlab/ # GitLab 读取、评审评论与快捷指令转义
│   ├── flower-compliance/   # 工具调用合规策略
│   └── flower-telemetry/    # 事件归一化和遥测输出
├── docs/
└── .trellis/
```

npm 工作区包含八个公开包（原三个应用与五个共享包）和私有的 Flower Desktop。现有应用保留 `@flower-ai/flower-*` 包名，共享核心使用 `@flower-ai/agent-runtime`。Flower Desktop 0.1.5 提供 Windows x64 安装 EXE、便携 ZIP 和手动更新的 Mac DMG，聚合用的根包 `flower` 保持 `private`。三个 Dockerfile 均以仓库根目录作为构建上下文。

开源分支 `v2` 的桌面直接进入本地工作台。企业桌面的员工身份及公司网关在 `v2-company` 维护。

## 本地开发

需要 Node.js `22.19.0` 或更高版本及 npm `10` 或更高版本。开发和测试命令从仓库根目录运行。

```bash
npm ci
npm run build
npm test
```

构建后可单独运行 Node 双宿主验收。

```bash
npm run test --workspace @flower-ai/agent-runtime -- test/dual-host.test.ts
```

```bash
# 查看评审 CLI 的参数
node apps/code-reviewer/dist/cli.js --help

# 本地启动钉钉机器人和 Observer，分别在不同终端执行
npm run dev --workspace @flower-ai/flower-ops-bot
npm run dev --workspace @flower-ai/flower-observer
```

评审试跑、钉钉 webhook 和观测接流的变量见各应用说明及 [环境变量样例](.env.example)。运行 `npm run build` 会同时准备 Observer 随包分发的静态资源。修改布局或资源后，可从根目录运行 `npm pack --dry-run --workspaces` 检查发布包清单。

## npm 发版检查

`npm run release:verify` 构建并新打包 Reviewer 和它依赖的 Flower 工作区包，在临时本机 registry 中提供这些制品。全新的仓外目录只安装 Reviewer，使用安装出来的 `flower-review` 对合成 MR 跑正常评审，检查两条评论和 Observer 回读。Flower 包由本机 registry 提供，第三方依赖从 npm 公共 registry 获取。运行 `node --test scripts/release-verify.test.mjs` 可验证缺包、错版本和同版本制品不一致时的发布阻断。

`npm run release` 在 Changesets 发布前检查公开 Reviewer 的当前版本是否待发。待发时，检查从目标 registry 匿名下载指定的核心 tarball，核对其 SHA-512 SRI 与本次仓外试装所用的核心 tarball 一致。同批制品还须通过正常评审。任一检查失败都会终止发布。Reviewer 的当前版本已存在于目标 registry、清单标记为 `private`，或发布访问级别为 `restricted` 时，其他包继续按原发布流程处理。

当目标 registry 缺少 Reviewer 固定依赖的核心版本时，先完成本批版本准备。有待发 Changeset 时，运行 `npm run version-packages`，再用 `npm install --package-lock-only` 同步锁文件。在同一个候选工作区运行以下命令。试装通过后，`--export-core` 保存本轮实际安装的核心 tarball。`npm publish` 直接发布这份制品。随后 `npm run release` 使用仓库 `.npmrc` 中的同一 npm registry，重新核对核心匿名下载、SRI 和正常评审，再交给 Changesets 发布其余待发包。

```bash
release_dir="$(mktemp -d)" &&
npm run release:verify -- --export-core "$release_dir/agent-runtime.tgz" &&
npm publish "$release_dir/agent-runtime.tgz" --access public --registry https://registry.npmjs.org/ &&
npm run release
```

目标 registry 已有本批精确版本的核心时，直接运行 `npm run release`。Changesets 会跳过已发布的核心版本。核心包按自己的 Changeset 升版，宿主可通过 `npm install --save-exact @flower-ai/agent-runtime@0.2.0` 安装。应用对 Flower 工作区依赖使用精确版本，Changesets 升版时同步依赖声明。同步锁文件后，按同批候选版本执行试装和发布。

## v2 计划

整理现有应用与共享库的布局后，验证企业端和 Desktop 加载同一份 pi 核心。随后分批接入实际企业业务、公司 CI 和 Desktop。运维机器人进一步诊断、告警响应和巡检的设想见 [运维机器人后续规划](apps/ops-bot/README.md#后续规划)。

## License

[MIT](LICENSE) © silentflower
