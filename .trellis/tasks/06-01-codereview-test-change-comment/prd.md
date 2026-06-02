# codereview 添加面向测试的变更说明评论块

## Goal

在 `flower-code-reviewer` 的 MR 整体评论中增加一个面向测试人员的变更说明块，帮助测试快速理解本次提交改了什么、影响哪些业务/页面/API、建议重点测什么，以及相关依据来自代码 diff 还是 harness/需求文档。这个能力用于弥补开发提交 commit/MR 描述经常缺少变更说明的问题。

## Background / Known Context

- 用户反馈：开发提交的 commit 很多时候没有描述、没有说明变动内容，测试侧很难判断“改了啥”和“该测啥”。
- 用户希望增加一个评论块来阐释变动，主要面向测试人员。
- 用户提到 harness 仓库可能已有相关需求文档或变更需求；本次需要结合已有 harness 能力判断。
- `packages/flower-code-reviewer/src/prompts.ts` 当前要求 LLM 输出整体 walkthrough，结构包含 `## 概要`、`## 文件变更`、`## 行动建议`。
- `packages/flower-code-reviewer/src/comments/render.ts` 已有 `renderWalkthrough` 纯函数和单测，但当前 `renderWalkthrough` 在生产主流程中未被直接调用；实际整体评论主要由 prompt 约束 LLM 调用 `gitlab_post_comment` 生成。
- 当前 prompt 已有“跨项目上下文”规则：涉及字段含义、权限规则、导入导出模板、业务状态机、跨端约定、版本需求时，应优先查配置的 harness 仓库；来自 harness 的依据需要在评论中简短说明文件路径和 ref/commit。
- `flower-tools-gitlab` 已提供 `gitlab_list_group_projects`、`gitlab_list_project_branches`、`gitlab_prepare_project_workspace`，可用于准备 harness 工作区后用 `rg` 搜索权威业务文档。
- `/root/project/devops-infra-harness` 中已有 code-review 接入设计：`templates/projects/application.yml` 内置 `code-review` job，仅 MR pipeline 运行，默认 `allow_failure: true`，`timeout: 20 minutes`。
- harness 文档 `devops-infra/docs/code-review-design.md` 明确当前 code-review 是辅助评审，默认不挡合并，业务方可锁 `FLOWER_IMAGE_TAG` 或调整 `FLOWER_MAX_FILES` / `FLOWER_MAX_FILE_SIZE`。
- 用户指出 MR !43 的代码评审报告中“文件变更 / 关注等级”渲染异常；实查该 MR 评论中出现 `:large_orange_circle: major` 和 `:white_circle: 已阅`。原因是 prompt 未约束文件变更表的关注等级取值，LLM 自行生成了 GitLab 不稳定 shortcode 和中英混搭文本。

## Requirements

- R1：MR 评论需要新增“面向测试”的变更说明内容，不能只面向开发 review。
- R2：说明内容至少覆盖“本次改了什么”和“建议测试关注什么”。
- R3：说明需要基于 MR diff 和必要的真实代码上下文生成，不能编造业务事实。
- R4：当变更涉及字段含义、权限规则、导入导出模板、业务状态机、跨端约定、版本需求时，应使用现有 harness 跨项目工具查找权威需求/变更文档。
- R5：如果依据来自 harness，评论中需要标明依据文件路径和 ref/commit；如果未找到 harness 依据，需要明确说明“未找到权威需求依据”，不能用当前项目旧文档替代结论。
- R6：新增内容需要保持 GitLab 评论可读，不应显著刷屏；测试说明应独立成第二条整体评论，避免把现有代码评审 walkthrough 撑得过长。
- R7：该能力应兼容无问题评审场景；即使没有 blocker，也应能输出面向测试的变更说明。
- R8：不得改变现有 blocker 判定、severity 词表、quick action sanitize、无依据评论拦截和 GitLab 版本 alert 降级行为。
- R9：测试说明始终作为第二条整体评论单独发送，不塞进现有代码评审 walkthrough。
- R10：测试说明块采用 4 项 MVP 字段：变更摘要、影响范围、测试关注点、需求/依据。
- R11：无问题评审场景也应额外发送测试说明评论；只要 MR 有可说明的功能/业务/代码变更，就不能只发 ≤3 行轻量评论。
- R12：文档、注释、格式化、测试 fixture 等低风险变更也应输出完整 4 项测试说明；低风险时可以在“测试关注点”中明确写“无需专项测试”或“建议基础回归”。
- R13：harness 查询策略为按需查询，但不能写死成封闭白名单；当 diff 体现出需要外部业务/需求依据时才准备 harness 工作区。字段含义、权限规则、导入导出模板、业务状态机、跨端约定、版本需求等只是典型触发例子。
- R14：测试说明评论不硬性限制句数或条目数；应以信息密度和测试可执行性为准，避免重复代码评审 walkthrough、复述完整 diff、堆砌不必要细节。
- R15：测试说明评论的受众是测试人员，不是开发人员；表达必须优先说明“这次 MR 做了什么、用户/业务/接口/数据表现会有什么变化、测试该怎么理解和验证”，避免只写文件名、函数名、实现细节或开发术语。
- R16：代码评审 walkthrough 的“文件变更 / 关注等级”列必须使用稳定中文枚举，避免 GitLab shortcode 渲染不稳定和中英混搭。允许值为 `🔴 阻塞`、`🟠 重要`、`🔵 建议`、`⚪ 仅说明`。
- R17：测试说明作为第二条整体评论单独发送时，评论 body 也必须使用 `<details>` 默认折叠，避免 MR 页面刷屏；不得添加 `open` 属性。

## Acceptance Criteria

- [ ] AC1：`buildPrompt` 中明确要求评审结束后额外发送一条面向测试的变更说明整体评论。
- [ ] AC2：变更说明块至少包含“变更摘要”和“测试关注点”两类信息。
- [ ] AC3：涉及需求/业务规则的变更，prompt 要求 LLM 优先查询 harness 权威文档，并在评论中标注依据路径和 ref/commit。
- [ ] AC4：未找到 harness 依据时，评论明确标注“未找到权威需求依据”，不把当前项目旧 `doc/`、`*.md`、`*.csv` 当权威依据。
- [ ] AC5：`prompts.test.ts` 覆盖新增测试说明块、harness 依据标注、无依据降级说明。
- [ ] AC6：若实现触及 `comments/render.ts`，`render.test.ts` 覆盖新增字段/章节输出。
- [ ] AC7：现有 `npm test --workspace @flower-ai/flower-code-reviewer` 通过。
- [ ] AC8：测试说明评论与代码评审 walkthrough 分离，不能把测试说明塞进原 walkthrough 导致单条评论过长。
- [ ] AC9：prompt few-shot 示例中的测试说明评论包含“变更摘要 / 影响范围 / 测试关注点 / 需求/依据”四项。
- [ ] AC10：prompt 中调整“无问题”规则，无 blocker/无行内问题时也要额外发送面向测试的变更说明评论。
- [ ] AC11：低风险变更仍输出完整 4 项测试说明，并允许在“测试关注点”中写明无需专项测试或仅需基础回归。
- [ ] AC12：prompt 明确 harness 按需查询，不要求每个 MR 都 clone/prepare harness；触发条件采用开放式业务依据判断，不能固定为少数关键词或封闭类型列表；非业务语义变更可将依据写为 MR diff / 代码上下文。
- [ ] AC13：prompt 不写死句数上限；只要求内容聚焦、避免重复 walkthrough、避免复述完整 diff。
- [ ] AC14：prompt 明确测试说明评论要使用测试人员易懂的业务/行为语言，不能只输出技术实现摘要。
- [ ] AC15：prompt 明确“文件变更 / 关注等级”列只能使用 `🔴 阻塞`、`🟠 重要`、`🔵 建议`、`⚪ 仅说明`，不得使用 `:large_orange_circle:`、`:white_circle:` 等 shortcode 或 `major/minor/blocker` 英文等级。
- [ ] AC16：`prompts.test.ts` 覆盖关注等级枚举约束，防止 LLM prompt 回退到 GitLab shortcode 或英文等级。
- [ ] AC17：prompt 明确第二条“面向测试的变更说明”整体评论必须用 `<details>` 默认折叠，few-shot 示例和 `prompts.test.ts` 均覆盖该结构。

## Open Questions

- 无。

## Decision (ADR-lite)

### D1：测试说明作为第二条整体评论

- Context：用户希望增加一个评论块说明“改了什么”，主要面向测试人员；现有 code-review 已有代码评审 walkthrough。若继续塞进同一条 walkthrough，单条评论可能过长，测试也不一定第一眼看到。
- Decision：始终单独发送第二条“面向测试的变更说明”整体评论。
- Consequences：测试说明更醒目，代码评审 walkthrough 不会被测试内容撑长；代价是 MR 会新增一条整体评论，需要用固定 4 项和信息聚焦规则控制噪声。

### D2：测试说明块字段 = 4 项 MVP

- Context：测试人员需要快速判断“改了什么、影响哪里、该测什么、依据是什么”，但 MR 评论不应过长。
- Decision：测试说明块固定包含 4 项：
  - 变更摘要：用测试人员能理解的业务/行为语言说明这次 MR 做了什么。
  - 影响范围：说明可能受影响的页面、入口、接口、权限、数据、配置、定时任务或用户路径。
  - 测试关注点：给出测试应验证的行为、边界、回归点或无需专项测试的理由。
  - 需求/依据：说明依据来自 MR diff、代码上下文，或 harness 文档路径 + ref/commit；未找到权威依据时明确标注。
- Consequences：信息足够测试执行，评论长度可控；暂不加入“回归风险”或“无需测试/低风险说明”，避免让 LLM 过度判断。

### D3：无问题场景也发 walkthrough

- Context：现有“无问题”轻量评论不包含测试说明；用户希望补齐开发未写变更说明的问题，这类 MR 即使没有代码问题也需要服务测试。
- Decision：无 blocker/无行内问题时也额外发送测试说明评论，不再只使用 ≤3 行轻量评论作为主路径。
- Consequences：测试侧始终能拿到说明；MR 会多一条测试说明评论，但代码评审 walkthrough 可以继续保持简洁。

### D4：低风险变更也输出完整 4 项

- Context：如果低风险 MR 跳过测试说明，仍会出现“没有说明”的体验；但这类 MR 的测试建议应更轻。
- Decision：低风险变更也输出完整 4 项测试说明。
- Consequences：结构稳定；低风险时“测试关注点”可以写“无需专项测试，建议确认构建/页面无异常”等轻量结论。

### D5：harness 按需查询，但触发条件不写死

- Context：现有 prompt 已有跨项目上下文工具链，但每个 MR 都查 harness 会增加耗时、token 和无效 clone；同时业务依据触发场景无法穷举。
- Decision：采用按需查询 + 开放式业务依据判断。字段含义、权限规则、导入导出模板、业务状态机、跨端约定、版本需求等只作为典型例子；只要 diff 暗示需要外部业务/需求事实支撑，就可以准备 harness 工作区并搜索权威文档。
- Consequences：保留需求依据能力，同时避免普通代码风格、文档、注释、格式化变更无谓拉跨项目仓库；实现时不能把触发条件写成固定关键词表或封闭枚举。

### D6：测试说明用测试人员可读的业务/行为语言

- Context：测试人员不一定理解文件路径、函数名、内部实现和开发术语；本功能的价值是补齐“这次 MR 做了啥”的可测试说明。
- Decision：测试说明评论必须优先用业务/用户行为/接口表现/数据变化/配置影响来表达，必要时再补充关键技术依据。
- Consequences：测试侧更容易直接执行验证；LLM 不能把第二条评论写成开发视角的 diff 摘要或文件清单。

### D7：文件变更表关注等级使用稳定中文枚举

- Context：MR !43 真实评论中出现 `:large_orange_circle: major` 和 `:white_circle: 已阅`，GitLab 对其中部分 shortcode 渲染不稳定，且中英混搭影响可读性。
- Decision：文件变更表关注等级列固定为 `🔴 阻塞`、`🟠 重要`、`🔵 建议`、`⚪ 仅说明` 四种中文枚举，禁止 GitLab shortcode 和英文 severity。
- Consequences：评论渲染更稳定，测试和开发都能直接理解关注级别；需要同步 prompt few-shot 和 prompt 单测。

## Assumptions (Temporary)

- 默认采用现有 `gitlab_post_comment` 发表代码评审 walkthrough 和测试说明两条整体评论，不新增 GitLab API。
- 默认不在本任务里修改 harness 仓库模板；harness 仅作为需求/设计依据来源。
- 默认不新增独立持久化数据或 SIEM 指标。

## Out of Scope

- 不要求开发者补写 commit message 或 MR description。
- 不做 auto-fix bot 或自动生成测试用例代码。
- 不改变 `code-review` job 的 GitLab CI 触发规则、`allow_failure` 默认值或镜像发布策略。
- 不引入新的跨项目搜索 API；沿用现有 `gitlab_prepare_project_workspace` + `rg` 路径。

## Research References

- [`research/repo-context.md`](research/repo-context.md) — 本次仓库与 harness 资料检查摘要。
