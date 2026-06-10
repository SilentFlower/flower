# review-bot 智能发现 harness 仓库并强化"需求/依据"可信度

## Goal

flower-code-reviewer 发出的「面向测试的变更说明」中,`需求/依据` 段大量出现"未找到权威需求依据"。
经 job 17580(xhgj-iqs-ui MR 55)实测诊断,存在两层问题:

1. **行为层(IQS 等平铺分组)**:模型能访问 harness 但从不尝试 —— 整个 run 0 次跨项目工具调用,
   `需求/依据` 一字不差照抄 prompt few-shot 示例 9。根因:模型不知道 harness 在哪(运行时没有注入
   namespace / harness 位置)、"未找到"是零成本出口(无校验)、按需触发裁量空间过大。
2. **机制层(SRM 等嵌套分组)**:harness 在父分组(`digital-biz-projects/srm/srm-harness`),业务项目在
   子分组(`digital-biz-projects/srm/fronts/*`)。白名单默认值 = `CI_PROJECT_NAMESPACE`
   (`…/srm/fronts`),`assertAllowedProject` / `assertAllowedGroup` 把 harness 和父分组全部硬拦截,
   模型想查也查不到。

目标:让 reviewer **不依赖人工配置、不依赖分组结构形态**(平铺如 IQS / 嵌套如 SRM)就能就近找到
harness 仓库,并保证"未找到权威需求依据"只在真正尝试过之后才会出现。

## Background / Known Context

- 实测分组结构(GitLab API):
  - IQS 平铺:`digital-biz-projects/iqs/iqs-harness` 与 `digital-biz-projects/iqs/xhgj-iqs-ui` 同级
  - SRM 嵌套:`digital-biz-projects/srm/srm-harness` 在父级;业务项目在
    `digital-biz-projects/srm/fronts/*`、`digital-biz-projects/srm/servers/*` 子分组
  - 全实例 harness 命名约定:`<biz>-harness`(`srm-harness` / `iqs-harness` / `devops-infra-harness`)
- 白名单逻辑:`packages/flower-tools-gitlab/src/workspace.ts:60-114`
  (`resolveAllowedProjectPrefixes` / `assertAllowedProject` / `assertAllowedGroup`)
  优先级:`FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES` env > `CI_PROJECT_NAMESPACE` > `CI_PROJECT_PATH` 去尾
- CI 模板(devops-infra `templates/projects/application.yml` `.flower-code-review-base`)
  **未配置** `FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES`
- prompt 跨项目段:`packages/flower-code-reviewer/src/prompts.ts:152-161`;
  few-shot 示例 9(被照抄的"未找到"模板):`prompts.ts:419-424`
- 工具参数描述硬编码 IQS 示例路径,对其他业务组有误导:
  `packages/flower-tools-gitlab/src/index.ts:303,341,376`
- 现有强制校验先例:`scanForBlockers` 拦截"未读文件就发行内评论"(自我阻塞模式可参考)

## Requirements

按用户确认的方向(2026-06-10 会话):

### R1 · 运行时就近自动发现 harness 并注入 prompt(方向 3,治本)

- run 启动阶段沿 `CI_PROJECT_NAMESPACE` 祖先链**从最近到最远**逐级
  `listGroupProjects(group, search="harness")`:
  - IQS 平铺:第一跳(自身 namespace `digital-biz-projects/iqs`)即命中 `iqs-harness`
  - SRM 嵌套:第一跳 `…/srm/fronts` 未命中 → 上钻 `…/srm` 命中 `srm-harness`
  - 就近优先,天然兼容任意分组形态,不需要预知 harness 在哪一层
- 把发现结果(harness 项目路径 + default branch)与当前项目 namespace / 项目路径注入评审 prompt,
  把"模型自己猜在哪"变成"直接告诉它在哪"
  - 注入方式沿用 truncation hint 模式:run.ts 发现 → `BuildPromptInput` 新增字段 → prompt 渲染段
  - 同级命中多个 harness 时:优先 `<group名>-harness` 精确命名;仍有多个则全部注入由模型按需选择
- 未发现 harness 时也要注入"已自动探测、未发现"事实,让模型如实引用
- 发现失败不阻塞评审主流程(降级为现状)

### R2 · 白名单默认值放宽为祖先链(方向 2)

- `resolveAllowedProjectPrefixes` 默认值从单一 `CI_PROJECT_NAMESPACE` 改为其**祖先链**
  (按 D1 业务组级即止:如 `digital-biz-projects/srm/fronts` → 同时允许 `…/srm/fronts`、`…/srm`,
  顶层 `digital-biz-projects` **不**放行)
- `FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES` 显式配置仍为最高优先级(保留收紧手段)
- 安全边界:只读 + REVIEWER_BOT_TOKEN 自身权限仍是硬边界;放宽范围需在 design.md 论证

### R3 · "未找到权威需求依据"前置校验(方向 4)

- 模型写"未找到权威需求依据"前,本次 run 必须存在至少一次跨项目工具调用记录
  (`gitlab_list_group_projects` / `gitlab_list_project_branches` / `gitlab_prepare_project_workspace`)
- 不满足时的处理强度(warn 日志 / 评论附注 / scanForBlockers 式拦截)在 brainstorm 中确定
- 同步收紧 prompt 措辞:明确"未找到"只能在尝试之后写

### R4 · 清理工具描述中的 IQS 硬编码示例

- `index.ts` 三处工具参数描述的示例路径改为中性表述或运行时注入真实值,消除对非 IQS 组的误导

## Open Questions

(均已收敛,见 Decision 段)

## Decision (ADR-lite)

### D1 · 祖先链边界:业务组级即止(2026-06-10 确认)

**Context**:发现算法与白名单需共享同一上钻边界;钻到顶层 group 会让任意业务项目的 reviewer
可读全部业务组仓库,且顶层 search=harness 会同时命中多个业务组的 harness 需要消歧。
**Decision**:祖先链保留**段数 ≥ 2 的前缀**(业务组级即止,不放行顶层 group):

- SRM front(namespace `digital-biz-projects/srm/fronts`)→ 放行 `…/srm/fronts` + `…/srm`
- IQS UI(namespace `digital-biz-projects/iqs`)→ 放行 `…/iqs`(与现状一致)
- namespace 本身只有 1 段时保持现状放行(否则连同组项目都读不了)
- `FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES` 显式配置仍为最高优先级,可覆盖此默认

**Consequences**:业务组之间互相隔离;harness 放顶层 group 的极端结构不被自动发现
(需显式配置 PREFIXES 兜底);发现算法就近优先、最多上钻到业务组级即停。

### D2 · R3 校验强度:语义分化 + warn 观测(2026-06-10 确认)

**Context**:硬拦截(scanForBlockers / 工具层拒发)在 harness 文档本就缺失的业务组会产生
标黄噪音或重试成本;R1 治本后应先观测效果再决定是否升级。
**Decision**:

- prompt 把 `需求/依据` 的写法收敛为**三选一**(取代旧的模糊"未找到权威需求依据"):
  - ① 引用 harness 文件路径 + ref/commit(查到了)
  - ② `已查询 harness(<路径>@<ref>)未找到相关材料`(查了没有 → 必须有 prepare 调用记录)
  - ③ `低风险变更,未查询 harness`(诚实声明没查)
- run 结束扫描(纯观测,不影响 job 结果):
  - 写②但本 run 0 次 `gitlab_prepare_project_workspace` → 日志 warn + trace/SIEM 上报
  - 写③但本 run 发过 blocker/major 行内评论(与"低风险"自相矛盾,机器可判) → warn
  - 上报违规类型计数,积累数据后再评估是否升级为 scanForBlockers
- few-shot 示例 9 同步改写为新三分语义,消除旧"未找到"模板被照抄的通道

**Consequences**:MVP 不挡 job、零误伤;约束力弱于硬拦截,靠 R1 注入 + 语义收紧 + 数据观测
渐进推进;"低风险豁免"问题被写法③天然吸收,无需独立豁免逻辑。

### D3 · ref 版本对齐:发现时顺带注入分支清单(2026-06-10 确认)

**Context**:MR 分支常带版本语义(如 job 17580 的 `hotfix-v1.4-p1-test`),harness 有 `v1.4` 等
版本分支;只注入 default branch 会让模型拿 master 上的"未来需求"当依据。
**Decision**:发现 harness 后宿主顺带调一次 `listProjectBranches`,把分支名清单(含 default 标记)
一起注入 prompt,并提示模型「选 ref 时优先匹配 MR 分支同版本,无匹配再用 default branch」。
**不做**宿主侧版本号自动解析匹配(分支命名约定不统一,规则难穷举,过度工程)。
**Consequences**:多一次 API 调用;版本选择仍由模型决策但有了完整事实输入。

## Acceptance Criteria

- [ ] IQS 场景(平铺):评审 run 自动发现 `digital-biz-projects/iqs/iqs-harness` 并注入 prompt
- [ ] SRM 场景(嵌套):子分组项目 MR 能发现并 prepare `digital-biz-projects/srm/srm-harness`,
      白名单不再拦截父分组访问
- [ ] 业务语义 MR 的测试说明 `需求/依据` 能给出 harness 文件路径 + ref/commit
- [ ] `需求/依据` 按三分语义机器校验(D2,纯观测 warn):旧句式"未找到权威需求依据"出现即标记;
      ②"已查询未找到"但无 prepare 记录、③"低风险"与本轮 blocker/major 矛盾、
      "宿主未发现"与实际发现相悖,均被 `scanHarnessEvidence` 标记
- [ ] 单测覆盖:祖先链白名单解析、harness 发现算法(平铺/嵌套/未命中)、R3 校验
- [ ] 现有测试不回归(workspace.test.ts / cross-project-tools.test.ts / prompts.test.ts)

## Definition of Done (team quality bar)

- Tests added/updated (unit/integration where appropriate)
- Lint / typecheck / CI green
- Docs/notes updated if behavior changes(spec: flower-tools-gitlab / flower-code-reviewer)
- 真实 GitLab 验证:IQS 与 SRM 各跑一次真实 MR 评审 job 确认效果

## Out of Scope (explicit)

- 方向 1(纯运维配置:给各业务组手工配 `FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES`)——
  被 R1/R2 的自动方案取代;仅作为上线前的临时缓解手段,不在本任务交付
- devops-infra CI 模板的变量改动(若 R1/R2 落地后不需要)
- harness 仓库内容结构 / 文档质量治理
- 评审质量其他维度(行内评论、blocker 判定等)

## Research References

- 诊断证据(2026-06-10 会话实测):job 17580 trace、MR 55 评论原文、SRM/IQS 分组结构 API 输出
