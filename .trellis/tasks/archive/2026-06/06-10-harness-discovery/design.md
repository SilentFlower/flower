# 技术设计:harness 智能发现 + 需求/依据三分语义

## 总体数据流

```
run.ts 启动
  ├─ resolveAllowedProjectPrefixes()          # R2: 默认值 = namespace 祖先链(≥2 段)
  ├─ discoverHarnessProject()                 # R1: 就近上钻发现 + 分支清单(D3)
  │    digital-biz-projects/srm/fronts        #   第 1 跳: search=harness 未命中
  │    digital-biz-projects/srm               #   第 2 跳: 命中 srm-harness → listProjectBranches
  │    (业务组级即止, D1)
  ├─ buildPrompt({ harnessContext })          # 注入: 当前项目 + harness 路径/default/分支清单
  ├─ agent loop                               # 模型按注入事实 prepare + rg, 写三分语义依据
  └─ finalize: scanHarnessEvidence()          # R3: ②无 prepare / ③有 blocker·major → warn + trace
```

## 模块边界与契约

### 1. flower-tools-gitlab / workspace.ts(R2)

新增纯函数 + 改默认值推导,`assertAllowedProject` / `assertAllowedGroup` 判定逻辑不动:

```ts
/** namespace 祖先链(业务组级即止): "a/b/c" → ["a/b/c","a/b"];"a/b" → ["a/b"];"a" → ["a"] */
export function resolveNamespaceAncestors(namespace: string): string[]
```

- `resolveAllowedProjectPrefixes` 第 2/3 优先级(`CI_PROJECT_NAMESPACE` / `CI_PROJECT_PATH` 去尾)
  的返回值从 `[namespace]` 改为 `resolveNamespaceAncestors(namespace)`
- 规则:保留段数 ≥ 2 的所有前缀;namespace 本身只有 1 段时保留自身(保持现状)
- `FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES` 显式配置分支不变(最高优先级,可收紧)

### 2. flower-tools-gitlab / harness-discovery.ts(R1+D3,新文件)

```ts
export interface HarnessDiscoveryResult {
	/** 命中的 harness 项目路径(主选);`null` = 已探测但未发现 */
	project: string | null;
	defaultBranch: string | null;
	/** 分支名清单(default 在首位;上限 50 条防爆) */
	branches: string[];
	/** 分支清单是否因超上限被截断 */
	branchesTruncated: boolean;
	/** 同级多命中时的其余候选(全部注入由模型选择) */
	candidates: string[];
	/** 实际探测过的 group 链(近→远),注入 prompt 供"未发现"时模型如实引用 */
	searchedGroups: string[];
}

/**
 * 沿 CI_PROJECT_NAMESPACE 祖先链就近发现 harness;全程降级不抛。三态:
 * - null:完全无法探测(无 CI env / 白名单为空)
 * - { project: null, searchedGroups }:已探测未发现(searchedGroups 供 prompt 如实引用)
 * - { project, branches, ... }:命中
 */
export async function discoverHarnessProject(): Promise<HarnessDiscoveryResult | null>
```

算法:

1. `resolveNamespaceAncestors(CI_PROJECT_NAMESPACE)` 得到链(近→远)
2. 逐级 `gitlabClient().listGroupProjects(group, { search: "harness", includeSubgroups: true })`
   - includeSubgroups=true:每一跳覆盖该子树,就近子树优先,兼容 harness 放兄弟子分组的结构
   - **排除当前 MR 项目自身**(防止项目名本身含 harness 时自指)
3. 命中后消歧:优先 `basename(group)`-harness 精确命名(如 `srm` 组下选 `srm-harness`);
   仍多个 → 第一个为主选,其余进 `candidates`
4. 对主选项目 `listProjectBranches(project)` 取分支清单(D3;失败则 branches=[],不影响主结果)
5. 任意一跳 API 失败(403/404/网络)→ console.warn 后继续下一跳;全链失败/未命中 → null
6. 白名单一致性:探测链与 R2 放行链同源,`assertAllowedGroup` 构造性通过,无需特判

### 3. flower-code-reviewer / run.ts(接线 + R3 扫描)

- buildPrompt 前:`const harness = await discoverHarnessProject()`(try/catch,失败→null,
  不阻塞评审主流程;探测结果打一行探针日志)
- 传入 `buildPrompt({ ..., harnessContext: { projectPath, namespace, discovery: harness } })`
  (projectPath/namespace 取自 `CI_PROJECT_PATH` / `CI_PROJECT_NAMESPACE`)
- finalize 阶段新增 `scanHarnessEvidence`(纯函数,与 scanForBlockers 并列,**不影响 exitCode**):

```ts
export interface HarnessEvidenceScanInput {
	/** 第二条整体评论(面向测试)body;run.ts 从 after-comments 里按 summary 标记定位 */
	testCommentBody: string | null;
	/** 本 run 跨项目 prepare 调用次数(来自 review-trace) */
	prepareCallCount: number;
	/** 宿主是否发现了 harness */
	harnessDiscovered: boolean;
	/** 本 run 发出的 blocker/major 行内评论数(来自 review-trace) */
	severeCommentCount: number;
}
/** 返回违规类型列表(空数组 = 合规),run.ts 对每项 console.warn + 计入 trace */
export function scanHarnessEvidence(input: HarnessEvidenceScanInput): string[]
```

判定规则(机器可判,零主观):

| 评论中的依据写法 | 违规条件 | 违规类型 |
|---|---|---|
| ②`已查询 harness…未找到相关材料` | `prepareCallCount === 0` | `claimed-search-without-prepare` |
| ③`低风险变更,未查询 harness` | `severeCommentCount > 0` | `low-risk-claim-with-severe-findings` |
| `宿主自动探测未发现 harness` | `harnessDiscovered === true`(与注入事实相悖) | `claimed-not-discovered-but-discovered` |
| 旧句式`未找到权威需求依据` | 出现即违规(prompt 已废弃该句式) | `legacy-no-evidence-phrase` |

### 4. flower-code-reviewer / review-trace.ts + extension.ts(R3 数据源)

- `ReviewTrace` 新增 `workspacePrepareCount: number`;新增 `recordWorkspacePrepare(): void`
- `registerReviewTrace` 的 `tool_call` 监听器增加分支:
  `event.toolName === "gitlab_prepare_project_workspace"` → `recordWorkspacePrepare()`
- blocker/major 计数复用现有 `lineComments`(severity 已记录),不新增结构

### 5. flower-code-reviewer / prompts.ts(注入 + 语义改写)

- `BuildPromptInput` 新增:

```ts
harnessContext?: {
	/** 当前 MR 项目路径,如 digital-biz-projects/srm/fronts/srm-admin-front */
	projectPath: string;
	/** 当前项目 namespace */
	namespace: string;
	/** 宿主探测结果;null = 已探测未发现 */
	discovery: HarnessDiscoveryResult | null;
};
```

- 新渲染段 `renderHarnessContextHint`(模式同 `renderTruncationHint`),两种形态:
  - 发现:项目路径 / default branch / 分支清单 / candidates /
    「选 ref 优先匹配 MR 分支 `${sourceBranch}` 同版本,无匹配用 default branch」
  - 未发现:「宿主已沿 `searchedGroups` 自动探测,未发现 harness 仓库」→ 模型依据段如实引用
- 「工具优先级 · 跨项目上下文」段改写:删除"配置的 harness 仓库"模糊表述,改为引用注入段;
  `gitlab_list_group_projects` 降级为"注入未发现时才需要"的兜底工具
- `需求/依据` 规范(原 130/160-161/196 行)收敛为三分语义①②③(D2);
  few-shot 示例 8 保持(①形态),示例 9 改写为②/③两个子示例,消除旧"未找到"模板照抄通道
- 不传 `harnessContext` → 不渲染注入段,跨项目段保持可用(向后兼容本地调试)

### 6. flower-tools-gitlab / index.ts(R4)

三处工具参数描述的 `digital-biz-projects/iqs…` 硬编码示例改中性占位
(如 `<group>/<biz>` / `<group>/<biz>/<biz>-harness`);真实路径已由 prompt 注入段承载。

## 安全论证(R2 放宽)

- 放宽仅作用于**默认值推导**,显式 `FLOWER_GITLAB_CONTEXT_PROJECT_PREFIXES` 仍可收紧到任意范围
- 边界 = 业务组级(D1):SRM 的 reviewer 最多读 `digital-biz-projects/srm/**`,不可达 IQS;
  顶层 group 永不自动放行
- 硬边界不变:全部只读工具 + REVIEWER_BOT_TOKEN 自身的项目可见性;clone 仍限制在
  `FLOWER_GITLAB_CONTEXT_ROOT` 固定目录、token 不出现在返回值/日志(沿用现有 workspace 机制)

## Rollout / Rollback

- 镜像浮动 `:latest` + `pull_policy: always`:合 main 后所有业务仓下一次 MR 评审即生效
- 发布前真实验证(DoD):IQS(平铺)+ SRM(嵌套)各跑一次真实 MR job,核对探针日志中的
  发现结果与评论中的依据段形态
- 回滚:revert 提交重建镜像;或业务仓临时 `FLOWER_IMAGE_TAG` 锁旧 sha
- R3 为纯观测(不改 exitCode),无行为风险;观测数据(违规类型计数)进 review trace 探针日志,
  后续以此评估是否升级为 scanForBlockers

## 风险与开放点

- GitLab search 行为:`listGroupProjects(search)` 是模糊匹配,需在真实实例验证
  `search=harness` 对 `srm-harness` 的命中(已知 API 全实例 search 可命中,group 级待实测)
- 分支清单上限 50:超大 harness 仓分支数溢出时截断并注明(防 prompt 爆量)
- 探测耗时:每跳 1 次 API(SRM 2 跳 + 1 次分支 = 3 次),相对 18 分钟评审预算可忽略
