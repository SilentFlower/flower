# 实施清单:harness 智能发现 + 需求/依据三分语义

## Implementation Checklist

按依赖顺序执行(1→2 是 3→5 的前置;6 独立可并行):

- [x] **S1 · R2 白名单祖先链**(flower-tools-gitlab)
  - `workspace.ts`:新增 `resolveNamespaceAncestors`;`resolveAllowedProjectPrefixes`
    第 2/3 优先级默认值改为祖先链(≥2 段;单段保留自身)
  - `workspace.test.ts`:3 级/2 级/1 级 namespace 推导、PREFIXES 显式配置优先级不变、
    SRM 场景 `assertAllowedProject("…/srm/srm-harness")` 放行 + 顶层/跨业务组仍拒绝
- [x] **S2 · R1+D3 harness 发现模块**(flower-tools-gitlab)
  - 新建 `harness-discovery.ts`:`HarnessDiscoveryResult` + `discoverHarnessProject`
    (祖先链就近探测、排除自身、`<group>-harness` 消歧、分支清单上限 50、全程降级不抛)
  - 包出口导出;新建 `harness-discovery.test.ts`:平铺第一跳命中 / 嵌套第二跳命中 /
    多命中消歧 / 未命中 null / 单跳 API 失败继续 / 全链失败 null(mock gitlabClient)
- [x] **S3 · prompt 注入与三分语义**(flower-code-reviewer)
  - `prompts.ts`:`BuildPromptInput.harnessContext` + `renderHarnessContextHint`
    (发现/未发现两形态、ref 版本对齐提示);跨项目段改写;`需求/依据` 三分语义①②③;
    示例 9 改写为②/③;不传时向后兼容
  - `prompts.test.ts`:注入段两形态渲染、三分语义文案存在、旧"未找到权威需求依据"
    句式不再出现在 few-shot
- [x] **S4 · trace 记录 prepare 调用**(flower-code-reviewer)
  - `review-trace.ts`:`workspacePrepareCount` + `recordWorkspacePrepare`
  - `extension.ts`:`registerReviewTrace` 监听 `gitlab_prepare_project_workspace`
- [x] **S5 · run.ts 接线 + R3 扫描**(flower-code-reviewer)
  - 启动:`discoverHarnessProject()`(try/catch 降级 null)+ 探针日志 → `buildPrompt`
  - finalize:`scanHarnessEvidence` 纯函数(四条机器判定规则,见 design.md §3)+
    对违规项 console.warn + 计入 trace 探针输出;**不改 exitCode**
  - `run.test.ts`(或新建):②无 prepare / ③有 blocker·major / 旧句式 三类违规判定 +
    合规零违规 case
- [x] **S6 · R4 工具描述去 IQS 硬编码**(flower-tools-gitlab)
  - `index.ts:303,341,376` 示例路径改中性占位;`cross-project-tools.test.ts` 相应断言更新
- [x] **S7 · spec 同步**
  - `trellis-update-spec`:flower-tools-gitlab backend index(祖先链白名单契约、发现模块)、
    flower-code-reviewer(harnessContext 注入、三分语义、R3 扫描)

## Validation

```bash
npm run check          # biome lint(根目录,--write)
npm run typecheck      # tsc --build --noEmit
npm test               # 全 workspace vitest
```

定向跑单包:

```bash
npm test -w @flower-ai/flower-tools-gitlab
npm test -w @flower-ai/flower-code-reviewer
```

## Review Gates

- [x] S1+S2 完成后:用本地 PAT 对企业 GitLab 实测一次
      `discoverHarnessProject`(SRM front 场景,确认 `search=harness` group 级命中行为)
      —— design.md 风险项,实测不符则回到 design 调整算法再继续
- [ ] 全部完成后:trellis-check-all(提交前全面检查)
- [ ] 合并后真实验证(DoD):IQS + SRM 各跑一次真实 MR 评审 job,
      核对探针日志发现结果 + MR 评论依据段形态(①或②/③,不再出现旧句式)
