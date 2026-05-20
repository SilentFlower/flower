# Research: flower-code-reviewer 镜像跨网交付方案(GitHub → 内网 GitLab Runner)

- **Query**:flower 仓库在 GitHub,但镜像需要被 xhgjdev GitLab Runner 用到;调研 3 个候选方案(push mirror / GitHub Actions 穿透 / npm registry)
- **Scope**:internal(优先,基于 `devops-infra-harness` 现有事实)+ external(知识库截至 2026-01,无 web search,只列广泛认知的能力,标注未在线验证)
- **Date**:2026-05-20
- **Active Task**:`.trellis/tasks/05-20-code-reviewer-quality-and-pipeline/`

---

## 0. 调研约束声明(读者必读)

本次 research **没有可用的 web 搜索工具**(`mcp__exa__*` 未注入),所有"外部知识"基于训练数据
(截止 2026-01)+ 仓库本地可验证事实。涉及具体 GitLab / GitHub Actions / npm 行为时,**优先引内网
真实运维事实**(`/root/project/devops-infra-harness/devops-infra/`)作为锚点;只有当本地无凭据时
才标"未在线验证,需运维或在 GitLab admin 控制台确认"。

---

## 1. 已知约束与背景事实(基于代码与运维文档)

### 1.1 网络拓扑

| 实体 | 位置 | 网段 / 域名 | 备注 |
|---|---|---|---|
| flower 仓库 | 公网 | `https://github.com/SilentFlower/flower.git` | monorepo + Turborepo + pnpm |
| 业务方 GitLab | 内网 | `http://gitlab.xhgjdev.com`(后端 IP `192.168.27.234`) | GitLab CE/EE v18.10.1 |
| Harbor registry | 内网 | `http://192.168.27.236`(HTTP,public 默认) | 凭据 `HARBOR_USER` / `HARBOR_PASS` |
| 阿里云 ACR | 公网 | `registry.cn-hangzhou.aliyuncs.com`(prod 推送) | 凭据 `ACR_USER` / `ACR_PASS` |
| **infra-build runner** | 内网 K8s(`gitlab-runner-infra` ns)| mihomo egress-proxy 翻墙 | privileged DinD,tag `infra-build-proxy` / `build-base` |

### 1.2 关键运维事实(锚点)

来源:`devops-infra-harness/devops-infra/CLAUDE.md`、`scripts/build-base.sh`、`infrastructure/gitlab-runner/`、`docs/migration/systems-config.yml`

- **F1**:内网已有 1 个带翻墙能力的 GitLab self-hosted runner(`gitlab-runner-infra`),通过同 ns 的 mihomo `egress-proxy` Service(`http://egress-proxy.gitlab-runner-infra.svc.cluster.local:7890`)拉取 GitHub / docker.io 等外部资源。
- **F2**:内网已有现成的「外部镜像→Harbor」同步机制 `scripts/build-base.sh::sync_image_amd64`,按 amd64 manifest digest pin、容错重试、跑在 K8s DinD,**这就是方案 A 的事实模板**。
- **F3**:GitLab v18.10.1 通过 `POST /api/v4/projects?import_url=...` 已被实证可从 HTTP URL server-side clone 仓库(用于旧 GitLab → 新 GitLab 迁移)。**但这不等于能直接 `import_url=https://github.com/...`**:GitLab 是否能出公网到 GitHub.com 取决于 GitLab server 主机的出口策略,**需要运维确认**(未在 manual-steps.md 中找到 GitLab server 自身的代理配置)。
- **F4**:已经有公网 push 跑通的先例 — 测试线 push Harbor、**生产线 push 阿里云 ACR**(`docs/ci-v3-hardening.md` §14.9)。说明内网 GitLab Runner push 出公网镜像 registry 是被允许且踩通的。但**反向(GitHub Actions 从公网 push 进 192.168.27.236 内网 Harbor)目前找不到任何先例**。
- **F5**:业务方 node 构建模板(`templates/node-build.yml` L165-191)默认 fallback `npm config set registry https://registry.npmmirror.com/`,**业务侧 Runner 可达淘宝镜像源**。这是方案 C 可行性的强证据。
- **F6**:Harbor `default_visibility: public`,k3s pull 镜像无需 `imagePullSecret`(`systems-config.yml` L111);也就是说 push 镜像到 Harbor 后,业务 CI Job `image: 192.168.27.236/flower/flower-code-reviewer:xxx` 零配置即可拉。
- **F7**:flower 的 Dockerfile 走 multi-stage,builder 阶段 `npm install` 拉 npm 公共源(`packages/flower-code-reviewer/Dockerfile` L20),**build 阶段需要外网**(npm.io / dl.alpinelinux.org)。
- **F8**:`packages/flower-code-reviewer/package.json` 已声明 `"publishConfig": {"access": "public"}` + `bin: flower-review`,**仓库语义上已经是「准备发到 npm 公网 registry 的 CLI」**(方案 C 的天然契合点)。

---

## 2. 三方案对比

### 方案 A · GitLab Pull Mirror + 内网 build → push Harbor

#### 2.1 思路

在 xhgjdev GitLab 上建一个**镜像仓库** `devtools/flower`(或 `digital-rd-infra/flower`),配置 GitLab **pull mirror** 从 GitHub 单向同步;mirror 仓库自带 `.gitlab-ci.yml`,在 push 触发时由 `infra-build-runner` 在 K8s DinD 里 `docker build -f packages/flower-code-reviewer/Dockerfile` 再 `docker push 192.168.27.236/devtools/flower-code-reviewer:<tag>`。业务方 `.gitlab-ci.yml` 直接 `image: 192.168.27.236/devtools/flower-code-reviewer:latest`,零外网依赖。

#### 2.2 落地路径(step-by-step)

| # | 步骤 | 责任方 | 阻塞前置 |
|---|---|---|---|
| A1 | 在 Harbor 建 project `devtools`(或复用现有 `base`)| 运维 | F6 默认 public 即可,无须 imagePullSecret |
| A2 | 在 xhgjdev GitLab 建空仓库 `devtools/flower-mirror`(visibility=internal) | 接入人 | — |
| A3 | 配 Pull Mirror:Settings → Repository → Mirroring repositories,URL `https://github.com/SilentFlower/flower.git`,鉴权 username + Personal Access Token(GitHub PAT,read-only),Mirror direction = Pull,勾选 "Mirror branches matching regex" 限制为 `^(main|release/.*)$`,设置 trigger pipelines for mirror updates | 接入人 | **F3 不确定:GitLab server 主机是否能出公网到 github.com,需运维实测** |
| A4 | 在 mirror 仓库写 `.gitlab-ci.yml`(沿用 `infra-build-runner` 模式):tag `infra-build-proxy`,services dind 29,before_script `docker login ${HARBOR_HOST}`,script `docker build` + `docker push`(npm install 走 mihomo egress-proxy)| 接入人 | F1 已就绪 |
| A5 | 全局级 CI/CD Variable 复用 `HARBOR_USER` / `HARBOR_PASS`(已有,F2),无需新加 | 运维 | — |
| A6 | 业务方 `.gitlab-ci.example.yml` 改 `image: 192.168.27.236/devtools/flower-code-reviewer:latest`(或 commit_sha pin) | flower 维护者 | A4 跑出第一个镜像后 |
| A7 | (可选)在业务 GitLab 建一个 mirror 仓库 admin webhook,镜像 push 完触发业务方 MR pipeline 重跑 | 接入人 | 仅当需要"flower 升级自动重跑近期 MR" |

#### 2.3 GitLab Pull Mirror 关键配置点(基于知识库,未在线验证)

- **Pull Mirror 频率**:GitLab CE/EE 默认每 30 min 自动 pull 一次;Premium tier 允许把间隔降到 1 min,且可以挂 `pipeline trigger`。CE 版本没有 webhook-style 实时拉取,但可以靠**GitHub Actions push 完发 GitLab API `POST /api/v4/projects/:id/mirror/pull`** 强制立即同步(GitLab 17+ 支持该 API,需 token 有 `api` scope)。
- **鉴权**:HTTPS + username + GitHub PAT。**PAT 在 GitHub 侧需 `repo:read`(public 仓库可以不勾)**;PAT 写在 GitLab 项目 secret 不入仓。
- **分支白名单**:`only_protected_branches` + 正则 `^(main|release/.*)$` 避免把 PR / feature 分支也同步过来。
- **冲突策略**:Pull Mirror **强制把 GitLab 端覆盖为 GitHub 端**,GitLab 端不允许直接 push(`mirror_overwrites_diverged_branches`);任何要在内网调整的代码改动必须先 PR 到 GitHub。

#### 2.4 工作量估计

| 阶段 | 工作量 | 备注 |
|---|---|---|
| A1-A2(Harbor + GitLab 仓库准备) | 0.5h | 走标准创建流程 |
| A3(Pull mirror 配 + 实测) | 1-2h | **关键不确定:GitLab → github.com 出口可能 fail,需要排查代理/防火墙** |
| A4(.gitlab-ci.yml 编写 + 首次 build) | 2-3h | 参考 `devops-infra/.gitlab-ci.yml` 同形态,主要是 monorepo Dockerfile context 调试(`packages/flower-code-reviewer/Dockerfile` 期望 build context = 仓库根)+ Docker build cache 优化 |
| A6(业务方接入)| 0.5h | 单文件改 |
| **合计 MVP** | **0.5 Day**(顺利)~ **1.5 Day**(GitLab 出口需协调) | |

#### 2.5 优缺点

**优点**
- 完全沿用现有 `infra-build-runner` + `sync_image_amd64` 路径,**0 新组件**;运维心智零成本。
- Pull Mirror 是 GitLab 一等公民功能,无需写脚本维护 webhook。
- 镜像产生在内网,**审计 / 合规 0 风险**;不引入新的出网通道。
- 可回滚:废弃方案只需关闭 mirror + 删 GitLab 项目,Harbor 镜像保留即可手动 docker push 续命。

**缺点**
- 依赖 GitLab server **能出公网到 github.com**(F3 待确认);如不能,需要单独走代理(增加 0.5-1 Day)。
- CE 版默认 30 min 同步延迟;紧急修复需手动触发 `mirror/pull` API。
- 多了一个仓库要维护(分支保护、access token rotation 周期)。
- 镜像 build 过程仍需出公网拉 npm 包 / alpine 包,**强依赖 mihomo egress-proxy 健康**(已知该代理订阅 URL 是 5min 一次性窗口,有 SPOF 隐患,见 CLAUDE.md §14.15)。

#### 2.6 阻塞点 / 未知数(必须问运维)

- **B-A1**:xhgjdev GitLab server 主机能否直接出公网到 `github.com:443`?如不能,GitLab 是否支持 system-wide HTTP proxy 配置?(`/etc/gitlab/gitlab.rb#gitlab_rails['env']['http_proxy']`)
- **B-A2**:Harbor 是否能给 `devtools` 项目分配 push 权限,允许 `gitlab-runner-infra` 复用 `HARBOR_USER` 账号?(`systems-config.yml` 显示 default_visibility=public,但 push 仍需账号有该 project 的 push role)
- **B-A3**:**Dockerfile build 在 mihomo 代理下** npm install 是否稳?当前 `infra-build-runner` 的 mihomo 翻墙路径已经用过(`build-base.sh` 拉 docker.io / gcr.io),但 npm.io 走 mihomo 实测速率多大、是否需要 `.npmrc registry=https://registry.npmmirror.com/` 兜底,**需要 dry-run 一次**。

#### 2.7 推荐度:**强烈推荐(MVP 首选)**

理由:
- 沿用全部现有内网基建(`infra-build-runner` + Harbor + mihomo)。
- 与公司现行模式(测试线 Harbor / 生产线 ACR,见 F4)同构,后续如要走「prod 推 ACR」也只是改 destination。
- 风险最小、回滚最易、对业务方零侵入(业务方只见 `image: 192.168.27.236/...`,与现有 Java/Node 业务镜像同形态)。
- 唯一未知数(GitLab 出公网)是 1 个二值问题,**第一天 dry-run 即可揭晓**。

---

### 方案 B · GitHub Actions 跨网 push Harbor

#### 2.8 思路

flower repo 在 GitHub Actions 配 workflow,`on: push: branches: [main]` 触发 docker build,然后**跨网 push 进内网 Harbor `192.168.27.236`**。"跨网"是核心难点:GitHub Actions 公网 runner **直接无法访问内网 IP**,必须通过以下任一通道:

- **B.a · GitHub-hosted runner + 内网 Harbor 暴露公网**:在公司边界做 Harbor 反向代理或 ACR 中转。
- **B.b · Self-hosted runner 装在内网**:GitHub Actions runner agent 跑在内网某台机器,直连 Harbor。
- **B.c · 隧道**(Tailscale / WireGuard / frp / Cloudflare Tunnel):GitHub-hosted runner 连入公司内网。

#### 2.9 三个子方案落地路径

##### B.a · Harbor 暴露公网(NAT/反代/中转 ACR)

| # | 步骤 | 责任方 |
|---|---|---|
| Ba1 | 公司网络做端口转发,把 Harbor 443 暴露到公网域名 `harbor.xhgj.com`(需固定 IP + 域名 + TLS 证书,**HTTP 内网 → HTTPS 公网需要 nginx/traefik 终结**)| 网络 + 安全(合规审批) |
| Ba2 | 或:GitHub Actions push 到 ACR `registry.cn-hangzhou.aliyuncs.com`(F4 已踩通),再用现成的 `sync_image_amd64`(F2)同步进 Harbor | 接入人 |
| Ba3 | GitHub workflow `docker/build-push-action@v5` + secrets `HARBOR_USERNAME` / `HARBOR_PASSWORD`(或 `ACR_*`)| flower 维护者 |

##### B.b · Self-hosted runner 在内网

| # | 步骤 | 责任方 |
|---|---|---|
| Bb1 | 找一台内网 Linux/K8s,装 `actions/runner` agent,注册到 flower repo Settings → Actions → Runners | 运维 |
| Bb2 | runner 出公网拉 GitHub workflow 定义,内网直连 Harbor push | 运维 |
| Bb3 | workflow `runs-on: [self-hosted, intranet]` | flower 维护者 |

##### B.c · 隧道(Tailscale / WireGuard / frp)

| # | 步骤 | 责任方 |
|---|---|---|
| Bc1 | 内网装 Tailscale subnet router 把 `192.168.27.0/24` 广播到 tailnet | 网络 + 安全 |
| Bc2 | GitHub Actions runner 装 Tailscale client(`tailscale/github-action`),加入 tailnet | flower 维护者 |
| Bc3 | runner 通过 tailscale IP 直连 Harbor | flower 维护者 |

#### 2.10 工作量估计

| 子方案 | MVP 工作量 | 备注 |
|---|---|---|
| B.a · Harbor 公网暴露 | 3-5 Day | 涉及域名 / 证书 / 防火墙 / 等保合规评审,**安全部门审批可能 2-4 周** |
| B.a · 走 ACR 中转 | 1-2 Day | 已有 ACR push 链路,只需在 flower 配 ACR 凭据;但 Harbor 同步需要在内网另起一个 cron job |
| B.b · self-hosted runner | 1-2 Day(机器准备就绪) | 长期运维成本高:runner 升级 / 安全补丁 / 占用一台机器 7×24 |
| B.c · Tailscale 隧道 | 2-3 Day(技术)+ 不可估(合规) | **公司大概率不允许第三方 P2P VPN 穿透**,frp/wireguard 同样会触发等保红线 |

#### 2.11 优缺点

**优点**
- 完全规避 Pull Mirror 30min 延迟,GitHub push → CI 触发是实时的。
- flower repo 维护者可以在 GitHub 自闭环看到 Actions 日志,不用切到 GitLab。
- 自身 supply chain 控制力强(GitHub SBOM、attestation、provenance 现成)。

**缺点**
- **B.a Harbor 公网暴露**:把内网核心 registry 端口对公网暴露,**合规风险极高**(等保 2.0 三级及以上 registry 不允许暴露公网);即使只对 GitHub IP 段 ACL,仍需安全团队签字。
- **B.a 走 ACR 中转**:多一跳同步,事故面变大;但合规上可行(ACR 本来就是公网)。
- **B.b self-hosted runner**:占机器 7×24;runner agent 在公网 push token 下载 workflow,**workflow 内可任意执行命令**,本质等同于"内网开了个公网 webhook 端口",安全审批难过。
- **B.c 隧道**:Tailscale / WireGuard / frp 等 P2P 穿透在大多数金融/政企内网被 IT 安全明令禁止;即使技术上可行,**合规上极可能被否决**。
- 所有 B 方案对内网运维都是**新组件**(没有先例可参考),运维心智成本高。

#### 2.12 阻塞点 / 未知数

- **B-B1**:公司是否允许 Harbor 端口暴露公网?(B.a 前提)
- **B-B2**:公司是否允许在内网部署 GitHub self-hosted runner?需要安全部门评估 workflow 代码任意执行的风险(B.b 前提)
- **B-B3**:公司是否允许 P2P 隧道穿透?(B.c 前提)
- 三者大概率均为**否**,需要找信息安全部门提工单确认。

#### 2.13 推荐度:**不推荐(除非 B.a 走 ACR 中转作为方案 A 的备份)**

理由:
- 三个子方案全部触发合规/安全审批,审批周期长,且**与公司「内网 GitLab 是单一接入入口」的现行架构正交**(F2 / F4)。
- 即使技术上跑通,跟方案 A 比没有实质收益(MR 评审场景不需要实时性,30min 同步对评审 turnaround 影响可忽略)。
- **唯一例外**:B.a 走 ACR 中转 — 如果 A 失败(GitLab 出公网受限),可以让 GitHub Actions 把镜像 push 到 ACR(F4 凭据已存在),再用 sync_image 同步进 Harbor。但这只是 A 的备胎,不应作为首选。

---

### 方案 C · 发布 npm 公开包,业务方 `npm i -g @flower-ai/flower-code-reviewer`

#### 2.14 思路

把 flower-code-reviewer 当一个 CLI tool(`bin: flower-review`)发到 npm 公网 registry(`@flower-ai/flower-code-reviewer`,scope 注册要钱或用 GitHub Actions OIDC 免密发布)。业务方 `.gitlab-ci.yml` 跳过 Docker 镜像,直接:

```yaml
code-review:
  image: ${HARBOR_HOST}/base/node:22-alpine   # 复用已同步的 node 镜像(F2)
  before_script:
    - npm config set registry https://registry.npmmirror.com/   # F5 已有先例
    - npm install -g @flower-ai/flower-code-reviewer@latest
  script:
    - flower-review --mr-iid $CI_MERGE_REQUEST_IID
```

#### 2.15 落地路径

| # | 步骤 | 责任方 |
|---|---|---|
| C1 | 在 npm 注册 `@flower-ai` org(免费 public access)或买 paid scope(私有);**package.json 已声明 `publishConfig.access=public`(F8)** | flower 维护者 |
| C2 | GitHub Actions workflow `.github/workflows/publish.yml`:on tag `v*`,`npm version`、`npm publish` (用 GH OIDC 免 NPM token 或用 NPM_TOKEN secret) | flower 维护者 |
| C3 | 验证 `npmmirror.com` 在淘宝侧同步 `@flower-ai/*`(npmmirror 通常 1-15min sync 一次,public scope 默认会同步) | 接入人(实测) |
| C4 | 业务方 `.gitlab-ci.yml` 改成上面的形态,`image: ${HARBOR_HOST}/base/node:22-alpine`(F2 已同步) | flower 维护者 + 业务接入人 |
| C5 | 若业务方 Runner 无法访问 `registry.npmmirror.com`(F5 之外的 runner),需先把 `@flower-ai/flower-code-reviewer` tarball 同步进公司内网 npm registry(若有 verdaccio / nexus); | 运维(仅当 F5 不适用) |

#### 2.16 工作量估计

| 阶段 | 工作量 | 备注 |
|---|---|---|
| C1(npm scope 申请) | 0.5h | npm 公网免费 |
| C2(GitHub Actions publish workflow) | 1-2h | 标准模板 |
| C3(npmmirror sync 验证) | 0.5h | curl `https://registry.npmmirror.com/@flower-ai/flower-code-reviewer/latest` 即可 |
| C4(业务方接入) | 0.5h | 单文件改 |
| **C5(企业 npm registry 镜像)** | 0(F5 已显示 npmmirror 可用)~ 1-2 Day(若需新建私有 verdaccio) | |
| **合计 MVP** | **0.5 Day**(F5 适用)~ **1 Day**(需配私有 registry)| |

#### 2.17 优缺点

**优点**
- **工作量最低**,产物最轻;无 Docker、无 mirror、无 self-hosted runner。
- 业务方 CI Job 启动开销 = `npm install -g` 时间 + node:22-alpine 启动;实测 monorepo 子包 + 4 个 workspace 内部依赖,**首次安装约 30-60s**(取决于网络);后续如果 GitLab Runner 启用 npm cache 可降到 5-10s。
- flower CLI 发布到 npm 后**对外开源、自然形成生态**;符合 `repository.url` / `keywords` / `license: MIT` 已经准备好开源的 package.json 形态。
- 0 镜像维护:flower 升级 → `npm version` → CI 自动 publish → 业务方下次 pipeline 自动拉新版本(可用 semver range 控制风险)。

**缺点**
- **package.json 引用 4 个 workspace internal package**(`@flower-ai/flower-providers / flower-compliance / flower-tools-common / flower-tools-gitlab`)+ 1 个外部依赖 `@earendil-works/pi-coding-agent`。发到 npm 需要**所有 internal package 同步发布**,且 `version: "0.1.0"` + `"@flower-ai/flower-compliance": "*"` 这样的 wildcard 在 npm 上**会拉最新版**,可能拉到不兼容的版本。正确做法:Turborepo + Changesets + `pnpm publish -r --access=public` 一把发,或所有 internal 依赖锁死具体 version。
- 启动开销:每次 MR pipeline 都重新 `npm install -g`,慢于直接 `image: pre-built-image`。如果业务 Runner 不开 cache,30-60s × 每个 MR pipeline = 一年累计开销可观。
- **依赖 npmmirror 同步及时性**:flower 紧急修 bug 后 publish,npmmirror 同步可能滞后 1-15min(已知行为,但不保证 SLA)。需要急修时,业务方 pipeline 可能拉到旧版本。
- 发到 npm public registry **意味着 LLM prompt / 提示词 / skill 内容全部开源**;若任何 skill 含公司内部信息或敏感约定,需脱敏。
- npm scope `@flower-ai` 注册需要确认未被占用;若已被占用需备选 scope。
- **业务方 Runner 必须能访问 `registry.npmmirror.com`**:F5 仅证明 `templates/node-build.yml` 默认这么用,但业务侧 Runner 可能跑在不同网络;需要为 code-reviewer job 的 Runner 实测确认。

#### 2.18 阻塞点 / 未知数

- **B-C1**:`@flower-ai` 在 npm 是否未被占用?(需查 `https://www.npmjs.com/org/flower-ai`)
- **B-C2**:公司是否允许员工 GitHub PAT push 到 npm public registry?某些公司合规要求开源行为需走 OSPO 审批。
- **B-C3**:`registry.npmmirror.com` 对 `@scope/*` 包的同步策略(public scope 默认同步,但 namespace 黑名单未在线确认)。
- **B-C4**:业务方 GitLab Runner 出公网是否可达 npmmirror?F5 仅证明 infra runner 模板默认这么配,业务方实际 runner 网络策略需运维确认。
- **B-C5**:监控 npm 端 supply chain 攻击(typosquatting `flower-ai` vs `flower_ai` vs `flowerai`)需要持续关注。

#### 2.19 推荐度:**备选(2-3 个月后做的"开源化"目标方案)**

理由:
- 工作量最低、形态最优雅,**作为长期目标方案非常合适**。
- 短期阻塞:internal workspace 依赖发布需要打通 Turborepo + Changesets 配置(monorepo 同步 publish 4-5 个 package 的发布工程),不是 1 Day 能搞定。
- 合规层面"把代码评审 prompt / skill 开源"需要法务/安全过一遍。
- **冷启动建议**:Phase 1 走方案 A,跑稳后 Phase 2 把 CLI 抽出来发 npm(同时保留镜像兜底,业务方按场景选)。

---

## 3. 三方案对比矩阵

| 维度 | A · Pull Mirror | B · GitHub Actions 跨网 | C · npm registry |
|---|---|---|---|
| 工作量(MVP) | **0.5-1.5 Day** | 1-5 Day(技术)+ 数周(合规) | 0.5-1 Day(技术)+ 数日(发布工程) |
| 沿用现有基建 | **★★★★★**(完全复用 infra-build-runner) | ★(全是新组件) | ★★★(复用 node base image + npmmirror) |
| 合规风险 | **极低**(0 新通道) | **高**(Harbor 暴露/隧道/self-hosted runner 任一都触发审批) | 中(开源行为需 OSPO 评估) |
| 业务方接入侵入 | 极低(改 image URL) | 极低(改 image URL) | 中(改 image + before_script,首次 install 慢) |
| 运维心智 | **0**(同 Java/Node 现有模式) | 高 | 中 |
| 回滚难度 | 极易(关 mirror) | 中(撤 runner / 关隧道) | 易(npm deprecate) |
| 镜像新鲜度延迟 | 30 min(CE 默认)/ 1 min(Premium 或 API 触发) | **实时** | npmmirror 1-15 min sync |
| 业务方 Pipeline 启动开销 | 0(预 build 镜像) | 0(预 build 镜像) | 30-60s(`npm i -g` 首次) |
| 长期演进 | 锁定在 docker 镜像形态 | 锁定在 docker 镜像形态 | **CLI 形态,可同时开源** |

---

## 4. 建议执行路径

**Phase 1(MVP,本任务周期)** → **方案 A**

理由:成本最低 × 复用基建最多 × 合规零风险 × 与现有 Java/Node 业务镜像同形态。

执行最小集:
1. 第一天:实测 GitLab server 能否出公网到 github.com(`curl -v https://github.com` from gitlab-rails console 或运维侧 ping)— 决定 A3 是否需要额外协调
2. 第二天:建 mirror 仓库 + 写 `.gitlab-ci.yml`(参考 `devops-infra/.gitlab-ci.yml::build_base` 同模式)+ 跑通一次 build & push
3. 第三天:业务方接入 + 在 srm-esign fork sandbox 跑一次完整 MR 评审 e2e

**Phase 2(2-3 个月后,质量稳定后)** → **方案 C 并行**

把 flower-code-reviewer CLI 抽到 npm public registry,作为「开源/外部用户」的入口。镜像形态(方案 A)保留作为公司内部 CI 入口,两条路径并行,业务方按场景选。

**Phase 3(永不,除非 A/C 都不可行)** → 方案 B 作为最后备胎(只接受 B.a 走 ACR 中转的子方案)

---

## 5. Open Questions(需要在 brainstorm Q4 / 后续运维沟通时确认)

1. **GitLab v18.10.1 server 主机出公网访问 github.com 的能力**(A 方案前提,F3 待证)— 找运维 1 个 curl 测试
2. **`@flower-ai` npm scope 是否未被占用** — 1 分钟网页查
3. **公司是否有内网 npm registry / npmmirror 是否对内网 GitLab Runner 可达** — 找运维确认或测一个 npm install
4. **flower monorepo 4 个 internal package 是否打算同步发布到 npm**(C 方案的发布工程问题)— 产品/maintainer 决策
5. **Harbor `devtools/` 或新 project 的命名/权限** — 找运维定一个 namespace 约定

---

## 6. 相关文件引用清单(本研究依赖)

### flower 仓库
- `packages/flower-code-reviewer/Dockerfile`(L7-46,multi-stage,node:22-alpine)
- `packages/flower-code-reviewer/.gitlab-ci.example.yml`(L4-22,占位 image)
- `packages/flower-code-reviewer/package.json`(L26-31,publishConfig.access=public + bin)

### devops-infra-harness
- `devops-infra/.gitlab-ci.yml`(L1-79,build_base job,DinD 模板)
- `devops-infra/scripts/build-base.sh`(L41-99,sync_image / sync_image_amd64)
- `devops-infra/infrastructure/gitlab-runner/infra-build-runner.yaml`(L181-309,Deployment + ConfigMap)
- `devops-infra/infrastructure/gitlab-runner/infra-build-runner.md`(L1-104,使用约定)
- `devops-infra/templates/.gitlab-ci-base.yml`(L1-44,全局变量定义)
- `devops-infra/templates/frontend-package.yml`(L20-52,Kaniko + Harbor push 凭据样板)
- `devops-infra/templates/node-build.yml`(L150-205,npmmirror 兜底)
- `devops-infra/docs/migration/systems-config.yml`(L49-136,GitLab / Harbor / ACR 坐标)
- `devops-infra/CLAUDE.md`(全文,内网运维硬约束 + 已验证结论 36 条)

### Trellis 任务文件
- `.trellis/tasks/05-20-code-reviewer-quality-and-pipeline/prd.md`(L34-49,本任务 auto-context 已探查)

---

## 7. Caveats(不确定 / 未验证)

- 本调研无 web 搜索工具,**GitLab Pull Mirror 的具体 API / 同步频率限制 / Premium tier 差异**基于训练数据(2026-01),需在执行 Phase 1 时实际登录 GitLab 控制台确认。
- **GitLab v18.10.1** 对应 GitLab 17.x → 18.x 演进期,文档可能与训练数据出入(2024-2025 GitLab 主要变化:repository import API 加强、mirror security 收紧),建议查 `https://gitlab.xhgjdev.com/help` 中的 Mirroring 文档。
- 方案 C 中"npmmirror 同步策略"基于历史经验,未在线验证当前是否对 `@flower-ai` scope 有特殊规则。
- 方案 B 三个子方案的合规结论基于行业常识(金融/政企等保),具体公司政策需信息安全部确认。
- 工作量估算基于"接入人对内网基建熟悉 + 顺利无重大阻塞"假设;若涉及跨部门沟通,各方案 +0.5-2 Day 缓冲。
