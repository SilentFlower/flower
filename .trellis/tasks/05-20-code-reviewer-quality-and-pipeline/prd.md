# flower-code-reviewer:评审质量优化 + 真实 Pipeline 生产化

## ⚠️ Session Recovery Note(下次进入时优先读)

**当前状态**(2026-05-20 sessionB 更新):Brainstorm 进行中,Q1 已答,**正在问 Q2(评论模板 preset)**。

**两个 research 已完成**(均已落地 `research/`):
- ✓ `research/comment-style.md`(414 行)— GitLab 兼容性 OK(`suggestion` / `<details>` / `[!alert]` 都支持,但 `[!alert]` 需 GitLab 17.10+);4 段式行内评论范式 + 5 个完整中文样例 + prompts.ts 硬约束建议
- ✓ `research/cli-image-cross-registry.md`(333 行)— **强烈推荐方案 A**:GitLab Pull Mirror + 内网 build → push Harbor(复用现有 `gitlab-runner-infra` + Harbor)

**下次 session 进入时**:
1. session-context 会自动把本任务挂为 current,无需手动 bind(三件套未齐前不可 `task.py start`)
2. 直接读 `research/comment-style.md` + `research/cli-image-cross-registry.md`,无需重 dispatch
3. 续从下面 Open Questions 中**第一个未答的**继续问;若 research/ 缺失则按文件末尾「Research Dispatch Prompts(备份)」重 dispatch

**配套任务**:`code-reviewer-auto-fix-bot`(05-20-code-reviewer-auto-fix-bot,N5 单独)已创建为 sibling 任务,等本任务接近完成再启动。

---

## Goal

承接 `05-19-code-reviewer-e2e-real-mr`(已 archive)把 code-reviewer 从 stub → 真实 MR e2e 跑通的成果,把它推到「生产级可用」状态:合并 4 个 sub-feature,让业务方在自己 MR push 时能自动触发评审 + 评论视觉舒服 + LLM 能拉真实代码上下文判断 + 通过公司 CI 标准化部署。

## Background / Known Context

### 上一任务遗产(已上线)
- flower-tools-gitlab 5 endpoint REST 客户端实装(client.test.ts 14 case)
- flower-providers `buildPiCliArgs` 公开 API(必须 --provider X --model Y 分开传)
- flower-code-reviewer/run.ts blocker 扫描 + `scanForBlockers` 纯函数
- flower-compliance 单测基线(零 → 19 case)
- 真实 fork sandbox `xhgj003027/srm-esign`(GitLab project_id=125)+ 两个测试 MR(IID 1/2)还在,可继续用
- 3 个 spec 已更新:flower-providers/backend/index.md #7 / flower-tools-gitlab/backend/index.md 9 条约定 / guides/debugging-llm-integration.md 决策树案例

### 本任务 auto-context 已探查
- **Dockerfile**(`packages/flower-code-reviewer/Dockerfile`)已存在:multi-stage build(builder + runtime),基于 `node:22-alpine`,ENTRYPOINT `node /app/.../cli.js`,WORKDIR `/workspace`(业务仓库 mount 进来),已 `apk add git`
- **.gitlab-ci.example.yml** 已存在:`image: yourcompany/flower-code-reviewer:latest` 占位,`script: flower-review --mr-iid $CI_MERGE_REQUEST_IID`,`allow_failure: false`
- **prompts.ts**(L33-59):当前评论硬约束 = "通过工具发表 + severity 三档 + 不重复评论",**没有 markdown 视觉规范**
- **flower-tools-gitlab/src/index.ts**:已 export gitlab_get_{mr_diff,mr_files,previous_review} + gitlab_post_{comment,line_comment} = 5 工具,**没有 `gitlab_get_file_content`**
- **devops-infra-harness**(`/root/project/devops-infra-harness/devops-infra/`):
  - 主 `.gitlab-ci.yml` + plan/build/package/deploy 4 阶段
  - 模板:`java-package.yml` / `node-build.yml`(前端 SPA)/ `frontend-package.yml` / `k8s-deploy.yml`
  - **没有 "Node.js CLI Job 镜像" 类型模板** → N4 决策点
  - Harbor host = `192.168.27.236`
- **flower 仓库 remote**:`https://github.com/SilentFlower/flower.git`(GitHub 公网)→ N3 跨网难点

### 已知约束
- 业务方 GitLab(`http://gitlab.xhgjdev.com`)与 Harbor(`192.168.27.236`)均为公司内网
- 当前 compliance `ci-readonly` 模式不允许 write/edit 工具(N1 加 read 工具不受影响,因 read 不在拦截名单)
- pi-coding-agent 0.75.x print 模式不输出 reasoning summary

## Assumptions(待用户确认或调研验证)

- A1 · N2 评论风格:GitLab 兼容 markdown(支持 `<details>` 折叠,但 GitHub 的 `suggestion` 块在 GitLab 上需用 GitLab 自己的 quick action)— 待 research 验证
- A2 · N1 工具:`gitlab_get_file_content` 通过 `GET /api/v4/projects/{id}/repository/files/{path}/raw?ref={ref}` 拿任意 ref 的文件全文(GitLab 标准 API,假设支持)
- A3 · N3 镜像 registry:默认目标 `192.168.27.236` Harbor,推 namespace 可能是 `devtools/` 或 `flower/`(待确认)
- A4 · N5 不在本任务:auto-fix bot 在 sibling 任务 `05-20-code-reviewer-auto-fix-bot` 单独做

## Open Questions(brainstorm 续问起点)

**优先级排序,一次一问**:

- ~~Q1 已答 → 见 Decision D1 + Requirements R1~~
- ~~Q2 已答 → 见 Decision D2 + Requirements R2(Preset A · 完整 CodeRabbit-like)~~
- ~~Q3 已答 → 见 Decision D3 + Requirements R3(B · `gitlab_get_file_content` + 强约束)~~
- ~~Q4 已答 → 见 Decision D4 + Requirements R4(方案 A · Pull Mirror,B.a 备胎,C 入 Out of Scope)~~
- ~~Q5 已答 → 见 Decision D5 + Requirements R5(完整模板化 · L1.b + L2.a)~~
- ~~Q6 已答 → 见 Decision D6 + Requirements R6(仅 fork sandbox · 不背扩散)~~

**Q1-Q6 已全部答完,brainstorm 进入 Expansion Sweep + Final Confirmation 阶段。**
- Q4:N3 镜像跨网方案 — research 强烈推荐方案 A(Pull Mirror + 内网 build → push Harbor),需用户拍板「采纳 A / 用 B 备胎 / Phase 2 走 C」+ 5 个 open question 找运维确认
- Q5:N4 harness 接入 → node-build.yml 凑合 / 新加 node-cli.yml 模板 / 完全独立
- Q6:e2e 覆盖范围 → 只在 fork sandbox 验?还是要在某个真实业务项目跑(谁是种子用户)?

## Requirements(随 brainstorm 答题持续填充)

- **R1 · sub-feature 范围 + 执行顺序**:本任务包含 4 个 sub-feature,按 **N2 → N1 → (N3+N4 合并)** 顺序内部执行
  - **N2 评论质量优化**(优先):改 `flower-code-reviewer/src/prompts.ts` + 评论 body 模板,改完即在 fork sandbox MR(xhgj003027/srm-esign,IID 1/2)看效果
  - **N1 LLM 拉真实代码上下文**(在 N2 后):加 `gitlab_get_file_content` 工具(flower-tools-gitlab)+ prompt 强约束 LLM 每文件必读相关上下文;让 N2 评论质量再升一级(能引真实代码片段)
  - **N3 镜像跨网部署 + N4 harness 接入**(合并,N1 后):部署工程强耦合,合并避免反复改 CI;必须等 N1/N2 内核稳了再上线
  - N5(auto-fix bot)不在本任务,见 Out of Scope
- **R2 · N2 评论模板 = Preset A(完整 CodeRabbit-like)**
  - **行内评论**:4 段式 = `_🔴 Blocker_` / `_🟠 Major_` / `_🔵 Minor_` 斜体英文 severity 标签行(emoji 对齐 `research/comment-style.md` §5/§6 完整模板)+ 加粗中文标题 + 解释段(讲 why)+ `<details><summary>` 折叠 reasoning(可选)
  - **`suggestion` 块**:LLM 出精确 diff;生成失败时 fallback 到普通 ```code``` 块
  - **整体评论 walkthrough**:整 body 包 `<details>` 默认折叠,内含「概要 / 文件变更表(文件×总结)/ 行动建议」
  - **`> [!caution]` alert 块**:用于全 blocker 拦截整体评论;**实施第一步检查 xhgjdev GitLab 版本**,若 ≥17.10 用 alert 块,若 <17.10 自动降级成 `> blockquote`
  - **「无问题」轻量模板**:MR 干净时只发 2 行(避免刷屏)
  - **`[severity:<level>]` 前缀保留**:run.ts `scanForBlockers` 依赖字面量匹配,emoji 可自由替换但前缀字符串不能动(level ∈ blocker/major/minor)
  - **prompt 硬约束**(参考 `research/comment-style.md` §5):4 段式 / walkthrough 结构 / 无问题轻量 / 禁 `/` 开头 quick action(防误执行 `/approve` `/close` 等)/ emoji shortcode 规范 / severity 前缀保留 共 6 条
  - **模板样例**:5 个完整中文样例(`research/comment-style.md` §6.1-§6.6)可直接落地
- **R3 · N1 = 加 `gitlab_get_file_content` 工具 + prompt 强约束(LLM 每文件必读)**
  - **新工具**:`gitlab_get_file_content({project_id, path, ref})` → `GET /api/v4/projects/{id}/repository/files/{path}/raw?ref={ref}`(flower-tools-gitlab 第 6 个 endpoint;复用 5 endpoint 现有 REST 客户端基础设施 + `client.test.ts` 14 case 模式扩单测)
  - **ref 策略**:默认 MR source HEAD;LLM 可主动指定 `target` / 历史 commit 拉对比版本(diff 不够时用)
  - **本地 `read`**:保留作为 fallback(远程 API 抖动时);但 prompt 引导默认走 `gitlab_get_file_content`(ref 明确,可控)
  - **prompt 强约束**:每变更文件**必拉**完整内容 + 相关上下文(被改函数实现 / 被改类定义 / 调用方),不拉直接评论 → `scanForBlockers` 视为「无依据评论」拒绝
  - **工作量预估**:≈ 1.0 Day(新工具 + 单测 + prompts.ts 强约束 + e2e 在 fork sandbox 跑)
- **R4 · N3 = 方案 A1 · 手动 push mirror**(简化版,2026-05-20 修订)
  - **主链路**:开发者本机 `git remote add xhgjdev <xhgjdev-gitlab>` + 每次 release 手动 `git push xhgjdev main`(走本机出公网,**GitLab server 不需要出公网**);xhgjdev GitLab 收到 push 触发 build pipeline → push 192.168.27.236 Harbor
  - **替代了原方案 A**:原方案 A 需要 xhgjdev GitLab server 出公网到 github.com 跑 Pull Mirror,2026-05-20 决策改成更简单的 A1(开发者本机 push)。决策原因:开发者本机已能出公网,GitLab server 出公网是合规红线;**A1 工作量 ≈ 0.25 Day**,不需要 spike,不需要找运维
  - **Open question 简化**:原 5 个 spike question 在 A1 下大部分不适用,本任务只保留 2 条:
    1. xhgjdev GitLab 上 flower 镜像仓的 namespace / project name 怎么定?
    2. Harbor namespace / 镜像名 / tag 策略怎么定?(同步给 sibling task `code-reviewer-harness-template`)
  - **B.a fallback 保留**(若 A1 不可用,如内网 GitLab 不允许外部开发者 push):GitHub Actions push 阿里云 ACR → 内网 cron 同步到 Harbor(工作量 1-2 Day)
  - **工作量预估**:A1 主链路 ≈ 0.25 Day(配 remote + 第一次 push + verify)
- ~~**R5 · N4 harness 接入**~~ **→ 已拆出为独立任务 `code-reviewer-harness-template`**(in devops-infra-harness 仓)
  - **拆出理由**:harness 模板的 host 仓是 devops-infra-harness,生命周期 / 提交流 / maintainer review 都与本任务解耦;独立 task 更清晰
  - **sibling task 路径**:`devops-infra-harness/.trellis/tasks/05-20-code-reviewer-harness-template`
  - **本任务里 N4 范围操作**:**全部移到 sibling task**;本任务的 `.gitlab-ci.example.yml`(在 flower 仓 packages/flower-code-reviewer/)可作为业务方接入示例先 commit,待 sibling task 出 harness 模板后再升级到 include 形式
  - **跨任务接口**:sibling task 完成后,业务方接入路径从「直引 image」改为「include 模板」;接口契约见 sibling task design.md
- **R6 · e2e 覆盖范围 = 仅 fork sandbox**
  - **验证场景**:`xhgj003027/srm-esign`(GitLab project_id=125)+ 现有 MR IID 1/2 + 必要时新造 MR
  - **不引入种子用户**:本任务不背扩散包袱,「业务方真实环境 e2e」拆给后续推广任务
  - **DoD「业务 MR 真实 push」语义**:fork sandbox 也是真实 GitLab Pipeline 触发(MR push → CI Runner → image pull → flower-review --mr-iid X),与种子用户业务项目链路完全同构,差异只在「评审对象代码是不是业务方真实代码」+「业务方 Runner 网络环境是否有差异」
  - **风险**:fork sandbox 验过 ≠ 任意业务方 GitLab Runner 可跑;但 N3+N4 模板化已最大化通用性,该风险接受并留给后续推广任务发现
- **R7 · Edge case 防御 = E1/E2/E3/E5**(E4 延后)
  - **E1 · LLM 网关 fail open**:LLM 调用失败(网络 / 限流 / 5xx)→ 评审整体退化成 1 条 warning 评论(说明评审失败 + 业务方手动 review),pipeline 不阻塞;**但** `scanForBlockers` 触发的 blocker(已成功评出的)仍 fail close
  - **E2 · MR diff size cap**:文件数 cap 默认 50(env `FLOWER_MAX_FILES` override),按 churn 量(additions+deletions)排序取 top N;超出时整体评论模板加段「⚠️ 本次仅评 N/M 个最大变更文件,其余请手工 review」
  - **E3 · quick action sanitize**:post 前对评论 body 做行级扫描,凡 `^/(approve|close|wip|assign|label|milestone|due|spend|estimate|...)` → 第一个 `/` 改成 `&#47;`(HTML escape);R2 第 6 条 prompt 硬约束的防御纵深,**双层兜底**
  - **E5 · 单文件 size cap + 二进制跳过**:`gitlab_get_file_content` 拉文件时,size > 50KB(env `FLOWER_MAX_FILE_SIZE` override)→ 截断 + 标注「⚠️ 文件过大,本次只读前 50KB」;按后缀跳过二进制(`.png/.jpg/.jpeg/.gif/.pdf/.zip/.tar/.gz/.7z/.ico/.woff/.ttf/.so/.dll/.exe/.bin/.lock`)
  - **E4 · 延后**:markdown 校验需引 remark 依赖较重,留给真踩到再补;mitigation 暂留 prompt 5 个完整模板样例引导 LLM 复制粘贴

## Acceptance Criteria

- [ ] **AC1 · N2 评论质量**:Preset A 全部元素落地(行内 4 段式 / walkthrough `<details>` 折叠 / `suggestion` 块 / `[!caution]` alert 带 GitLab 版本降级 / 「无问题」轻量 / 6 条 prompt 硬约束 / `[severity:<level>]` 前缀保留)
- [ ] **AC2 · N1 LLM 拉代码**:`gitlab_get_file_content` 工具新增(含单测 ≥ 3 case,参考 `client.test.ts` 14 case 模式);prompts.ts 强约束「每文件必读」生效;`scanForBlockers` 「无依据评论」拦截 case 加单测
- [ ] **AC3 · N3 镜像跨网**(简化版):开发者本机配 xhgjdev GitLab remote + 手动 push mirror + verify xhgjdev GitLab 收到代码;镜像 build pipeline 与 harness 模板 host 由 **sibling task `code-reviewer-harness-template`** 落地,本任务只验「push 通」
- ~~AC4 · N4 harness 接入~~ → **拆给 sibling task `code-reviewer-harness-template`**(本任务不再背 AC4)
- [ ] **AC5 · Edge cases**:E1 LLM fail open(单测 mock LLM 失败 → 仍 post 1 条 warning 评论 + pipeline 不阻塞)+ E2 diff cap(单测 mock 51 文件 → 取 top 50 + 整体评论加截断说明)+ E3 quick action sanitize(单测 `/approve` `/close` 等 12+ quick action 全转 escape)+ E5 file size + 二进制跳过(单测)
- [ ] **AC6 · e2e**(简化版):**单测层** flower 仓 4 个 package 全绿(≥ 320 cases);**真实 MR e2e** 拆到 sibling task `code-reviewer-harness-template` 完成后再做(本任务不背真实 fork sandbox MR push 验证 — 需依赖 N3 image push + N4 harness 模板就绪)
- [ ] **AC7 · spec 沉淀**:新发现写入 `.trellis/spec/`(至少更新 flower-code-reviewer + flower-tools-gitlab + 1 条新 guide)

## Definition of Done

- 单测 + lint + typecheck 全绿(所有 4 个 package)
- AC1 / AC2 / AC5 / AC7 全部 ✓(N2 / N1 / Edge cases / spec)
- AC3 = N3 简化版(本机 push mirror)完成
- ~~AC4(N4 harness)~~ → 拆 sibling task `code-reviewer-harness-template`
- AC6 真实 MR e2e → 拆给 sibling task 完成后再做
- spec 更新沉淀新发现(至少 3 处)
- commit + push:flower 仓主分支(本任务)+ devops-infra-harness 仓主分支(sibling task)

## Out of Scope(显式)

- N5 auto-fix bot(回复评论 → 自动改 + 自动提 MR)— **已创建独立任务 `05-20-code-reviewer-auto-fix-bot`**,后续启动
- **N4 harness 模板**(`node-cli-image.yml` + `review-flower-code-reviewer.yml`)— **2026-05-20 拆出独立任务 `code-reviewer-harness-template`**(in devops-infra-harness 仓)
- flower 仓库发布到 npm public registry — 跨网方案可能涉及,但本任务尽量回避(影响范围太大)
- 多 LLM 模型矩阵 — 沿用上任务 gpt-5.5 + xhigh,本任务不验其他模型
- code-reviewer 形态从 K1(CI Job)改成 K2(常驻 service)— 上任务 D2 决策保持,本任务不动
- **GitLab Pull Mirror / Spike**(2026-05-20):原 R4 方案 A 改成 A1 手动 push mirror 后,GitLab server 出公网需求消除,5 个 spike question 大部分不再需要(Phase 0 spike 已 OoS)
- **真实 fork sandbox MR e2e 验证**:依赖 sibling task `code-reviewer-harness-template` 完成 harness 模板 + image push 通路;本任务只保证单测层全绿

## Research References

- ✓ [`research/comment-style.md`](research/comment-style.md)(414 行)— GitLab 兼容性确认(`suggestion` / `<details>` / `[!alert]` 均支持,`[!alert]` 需 GitLab 17.10+);CodeRabbit 4 段式行内评论范式;5 个完整中文模板样例(srm-esign sign_verify.go 硬编码 secret 场景);prompt 硬约束建议(禁 `/` 开头 quick action / 保留 `[severity:<level>]` 前缀)
- ✓ [`research/cli-image-cross-registry.md`](research/cli-image-cross-registry.md)(333 行)— **强烈推荐方案 A · GitLab Pull Mirror + 内网 build → push Harbor**:复用现有 `gitlab-runner-infra`(tag `infra-build-proxy`)+ mihomo egress-proxy + Harbor,与公司测试线 Harbor / 生产线 ACR 模式同构,工作量 0.5-1.5 Day;唯一未知数:xhgjdev GitLab server 主机出公网到 github.com 是否通,Phase 1 第一天揭晓
- 文件均已落地,如下次 session 缺失则按文件末尾「Research Dispatch Prompts(备份)」段重 dispatch

## Decision (ADR-lite · brainstorm 填充)

### D1 · sub-feature 执行顺序 = N2 → N1 → (N3+N4)

- **Context**:4 个 sub-feature(N1 LLM 拉代码 / N2 评论质量 / N3 镜像跨网 / N4 harness 接入)耦合度和验证成本不同,顺序影响反馈速度和返工成本
- **Decision**:采纳 **N2 → N1 → (N3+N4 合并)**
- **Consequences**:
  - ✓ N2 验证成本最低(改完即看 fork sandbox MR 评论效果)→ 早验早调,UX 风险早收敛
  - ✓ N1 在 N2 之后 → 让 LLM 拿到真实代码上下文反过来给 N2 评论质量再升一级
  - ✓ N3+N4 合并最后做 → 部署工程强耦合(Harbor namespace / Pipeline 镜像名 / harness 模板互相依赖),避免反复改 CI
  - ⚠️ 风险:N3+N4 是本任务最大阻塞(运维 / 网络 / 跨仓库),若卡住可能让 N1/N2 成果暂时无法上线;mitigation:N1/N2 完成后可在 fork sandbox 持续 e2e,等 N3+N4 解锁再切真实业务 MR
- **Rejected alternatives**:
  - B(N1 优先):N1 需 e2e 真实 MR 才能验,反馈环长;且 N2 模板若不稳,N1 拉的代码引到评论里效果差
  - C(N3+N4 先):质量未稳就上线被业务方看见 → 第一印象差,后续推广阻力大
  - 砍某 N:无,4 个都是定义中的「生产级可用」必备项

### D2 · N2 评论模板 = Preset A(完整 CodeRabbit-like)

- **Context**:`research/comment-style.md` 给出 CodeRabbit 4 段式行内评论范式 + GitLab 兼容性确认 + 5 个可直接落地的中文模板样例,需拍板采纳到什么程度
- **Decision**:**Preset A** = 完整采纳 CodeRabbit-like UX(4 段式 + walkthrough 折叠 + `suggestion` 块 + `[!caution]` alert 块 + 「无问题」轻量模板 + 6 条 prompt 硬约束)
- **Consequences**:
  - ✓ UX 与社区主流 PR bot 对齐,业务方易接受
  - ✓ research 已给完整中文样例可直接抄,落地成本低
  - ✓ `[severity:<level>]` 前缀保留 → 与现有 `scanForBlockers` 完全兼容,无破坏改动
  - ⚠️ alert 块依赖 GitLab 17.10+ → 实施第一步必须实测 xhgjdev GitLab 版本号,带降级 fallback(否则评论里出现裸 `> [!caution]` 字面文本)
  - ⚠️ `suggestion` 块要求 LLM 生成精确 diff,失败率非 0 → fallback 到普通 ```code``` 块
- **Rejected alternatives**:
  - Preset B(中等):砍 `<details>` 折叠 + `suggestion` 块 → 视觉差距与 stub 不够大,「生产级可用」感不足
  - Preset C(最小):仅 emoji + 加粗 → 看不出和 stub 评审的差异

### D3 · N1 工具方式 = B(加 `gitlab_get_file_content` REST 工具 + 强约束)

- **Context**:Q3 决策 LLM 拿真实代码的工具实现 — A(仅本地 read)/ B(加远程 REST 工具)/ C(都做)
- **Decision**:**B** = 加 `gitlab_get_file_content` 工具到 flower-tools-gitlab + prompt 强约束(每文件必读),本地 read 保留作 fallback
- **Consequences**:
  - ✓ 能拉**任意 ref**(target / 历史 / cross-MR / cross-project),未来 sibling 任务 `code-reviewer-auto-fix-bot` 可直接复用
  - ✓ 不依赖容器 mount 行为(`$CI_PROJECT_DIR` env 假设)→ 减少跨 GitLab Runner / docker executor 配置差异风险
  - ✓ flower-tools-gitlab 已有 5 endpoint + `client.test.ts` 14 case 模式 → 加第 6 个边际成本低,扩展性好
  - ⚠️ 工作量 ≈ 1.0 Day(比 A 的 0.5 Day 多 0.5)+ LLM 多 1 个工具决策开销
  - ⚠️ 远程 API 网络抖动 → 本地 `read` 作为 fallback 兜底
- **Rejected**:
  - A(仅本地 read):简洁但只能拿 source HEAD,受限于容器 mount 假设;不为 sibling 任务铺路
  - C(都做):本地 read 仅在远程失败时有用,GitLab REST 历史稳定,fallback 价值有限 → 把 read 降级为 fallback 即可,无需 prompt 同时引导两个工具(LLM 决策开销)

### D4 · N3 镜像跨网 = 方案 A · GitLab Pull Mirror(B.a 留 fallback,C 入 Out of Scope)

- **Context**:flower 仓在 GitHub 公网,业务方 GitLab + Harbor 在内网。research 已对比 3 方案
- **Decision**:**A · GitLab Pull Mirror + 内网 build → push Harbor**;预留 **B.a · GitHub Actions → ACR → Harbor** 作 A 失败时的 fallback;**C · npm registry** 入 Out of Scope(列 Phase 2 目标)
- **Consequences**:
  - ✓ 复用 `gitlab-runner-infra` ns + tag `infra-build-proxy` + mihomo egress-proxy + Harbor 全套现成基建,运维心智 0
  - ✓ 与公司测试线 Harbor / 生产线 ACR push 模式同构(F4 已踩通公网 push 镜像 registry 流程)
  - ✓ 已有 `scripts/build-base.sh::sync_image_amd64` 外部镜像同步机制(F2)作事实模板
  - ⚠️ **单点风险**:依赖「xhgjdev GitLab 出公网到 github.com」未知数 → mitigation:Phase 1 第一天 spike 30min 揭晓 + B.a 路径预留
  - ⚠️ Pull Mirror 同步频率不可控(GitLab Free tier 每 30min,Premium 每 5min);本任务可接受 30min 延迟(评审工具不是 hot path)
- **Rejected**:
  - B(GitHub Actions push 内网 Harbor):3 子方案全部触发等保红线合规审批,落地周期不确定(>1 week)
  - C(npm registry):长期价值高但发布工程复杂(monorepo 4 internal workspace 同步发布需 Turborepo + Changesets),本任务范围内做不完;列 Phase 2 目标

### D5 · N4 harness 接入 = 完整模板化(L1.b + L2.a)

- **Context**:Q5 决策 harness 接入形态 — flower 自身 build 模板 + 业务方接入模板,各自有内联 / 抽模板 / 不做 的取舍
- **Decision**:**Preset 完整模板化** = **L1.b**(devops-infra-harness 加 `node-cli-image.yml`,flower 仓 include)+ **L2.a**(harness 加 `review-flower-code-reviewer.yml`,业务方 3 行 include 即可启用)
- **Consequences**:
  - ✓ L1.b 抽出的 `node-cli-image.yml` 模板可被 sibling 任务 `code-reviewer-auto-fix-bot`(也是 Node.js CLI 镜像)直接复用
  - ✓ L2.a 业务方接入只需 3 行 include,扩散成本最低,「生产级可用」最后一公里
  - ✓ harness maintainer review 是一次性工程,后续 0 维护
  - ⚠️ 工作量 ≈ 1.5 Day(+ harness maintainer review buffer 0.5 Day,可能延迟交付 1 天)
  - ⚠️ 改动跨仓库(flower + devops-infra-harness),提交 2 个 PR
- **Rejected**:
  - 折中(L1.b + L2.b):L2.b 把业务方接入模板拆给 sibling,本任务收尾「生产级可用」诚意不足;且 sibling 任务核心是 auto-fix bot 不是接入模板
  - 最快上线(L1.a + L2.b):L1.a 内联浪费模板化机会,sibling 任务还要重做

### D6 · e2e 覆盖范围 = 仅 fork sandbox(不背扩散)

- **Context**:Q6 决策「真实业务 MR」的范围 — 仅 fork sandbox / + 1 个种子用户 / + 多个种子用户
- **Decision**:**A · 仅 fork sandbox 验**(`xhgj003027/srm-esign` + IID 1/2 + 必要时新造 MR)
- **Consequences**:
  - ✓ 不需要协调种子用户,本任务收尾时间可控
  - ✓ fork sandbox 也走真实 GitLab Pipeline(MR push → Runner pull image → flower-review --mr-iid)→ 链路与种子用户业务项目完全同构
  - ⚠️ 验过 ≠ 任意业务方 Runner 可跑(可能存在业务方 Runner 网络限制 / token 权限差异);该风险接受,留给后续推广任务发现
  - ⚠️ 没有真实业务方 UX 反馈,无法早期发现「中文评论是否够地道」「评论密度是否过高」等主观问题 → 留给推广任务收集
- **Rejected**:
  - B(+ 1 个种子用户):扩散协调成本不确定,可能让本任务收尾时间不可控
  - C(+ 3-5 个种子用户):明显是推广任务范畴,不该塞本任务

### D7 · Edge case 防御范围 = C(E1/E2/E3/E5,E4 延后)

- **Context**:Expansion sweep 5 个 edge case 取舍(LLM 网关 / diff 大小 / quick action / markdown 损坏 / 单文件大小)
- **Decision**:**C** = MVP + E1 + E2 + E3 + E5(E4 markdown 校验延后)
- **Consequences**:
  - ✓ 涵盖最高概率失败场景:LLM 网关抖动 / 真业务大 MR / 单文件巨大 / 二进制
  - ✓ E3 双层兜底(prompt 硬约束 + post 前 sanitize),quick action 误执行风险降至 0
  - ✓ 总投入 < 0.5 Day,边际收益高
  - ⚠️ E4 markdown 损坏极少数情况 → 业务方看到原始 `<details>` 字面文本;届时手动补 remark
- **Rejected**:
  - A(严格 MVP):e2e 阶段必踩 E1 / E2 / E5
  - B(只 E1+E2):E3 漏防御纵深,E5 漏拉大文件 token 爆
  - D(全做):E4 引 remark 依赖较重,且 prompt 5 个完整样例已大幅降低 LLM 输出损坏概率

---

## Research Dispatch Prompts(备份 · session 中断后重新 dispatch 用)

### research/comment-style.md prompt

> 调研 PR 评论 bot 的视觉风格规范,产出可直接落地的 markdown 模板。落地到 `.trellis/tasks/05-20-code-reviewer-quality-and-pipeline/research/comment-style.md`。
>
> 调研对象:
> 1. **coderabbitai**(https://github.com/coderabbitai):整体 PR 评论 walkthrough / 行内 actionable suggestion(GitHub `suggestion` 代码块)/ `<details>` 折叠区 / emoji severity / Resolve thread 交互 hint
> 2. **Roo-Code PR 6326**(https://github.com/RooCodeInc/Roo-Code/pull/6326):评论格式参考
> 3. **GitLab 行内评论 vs GitHub PR review**:格式差异(GitLab `suggestion` 块是否支持?quick action?)
>
> 产出 markdown 模板(中文,代码块/链接/标签英文):
> - **MR 整体评论模板**(标题 / 概要 / 文件变更表 / 行动建议)
> - **行内评论模板**(问题描述 / 修复建议代码块 / 折叠 reasoning / severity 标签)
> - **「无问题」轻量模板**
> - 每个模板给完整中文样例(假装是给 srm-esign 仓库 internal/auth/sign_verify.go 硬编码 secret 评论)
>
> 约束:GitLab 兼容 markdown;保留 `[severity:<level>]` 前缀(用于 blocker 扫描);中文为主。

### research/cli-image-cross-registry.md prompt

> 调研「flower 仓库在 GitHub,但镜像需要被 xhgjdev GitLab Runner 用到」的跨网方案。落地到 `.trellis/tasks/05-20-code-reviewer-quality-and-pipeline/research/cli-image-cross-registry.md`。
>
> 背景:flower remote = `https://github.com/SilentFlower/flower.git`(GitHub 公网);业务方 GitLab = `http://gitlab.xhgjdev.com`(内网);Harbor = `192.168.27.236`(内网)。
>
> 3 方案:
> - **方案 A · push mirror**(GitHub → xhgjdev GitLab 单向 mirror,GitLab Runner build)
> - **方案 B · GitHub Actions 跨网 push Harbor**(self-hosted runner 在内网,或 Tailscale/WireGuard 等穿透)
> - **方案 C · npm registry**(业务方 `npm i -g @flower-ai/flower-code-reviewer`,跳过镜像)
>
> 每个方案产出:落地路径(step-by-step)+ 工作量估计(小时)+ 优缺点 + 推荐 + 理由。

## Notes

- 三件套(prd + design + implement)必须全部完成才能 `task.py start`
- brainstorm 中断恢复:见文件顶部 ⚠️ Session Recovery Note
- 当前任务还是 `planning` 状态,**未** `task.py start`(避免上下文清空后任务状态混乱)
