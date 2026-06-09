# codereview 添加面向测试的变更说明评论块 · 实施草案

## Implementation Checklist

- [x] 确认产品范围：测试说明始终作为第二条整体评论单独发送。
- [x] 更新 `packages/flower-code-reviewer/src/prompts.ts`：
  - [x] 工作流程明确代码评审 walkthrough 完成后，必须额外调用 `gitlab_post_comment` 发送测试说明评论。
  - [x] 评论 markdown 样式中补充测试说明评论结构。
  - [x] few-shot 示例增加面向测试的独立评论，包含变更摘要 / 影响范围 / 测试关注点 / 需求/依据。
  - [x] harness 依据说明强化为测试说明可用的来源标注规则。
  - [x] 调整“无问题轻量评论”规则，使无问题但有可说明变更的 MR 也额外发送测试说明评论。
  - [x] 增加低风险变更写法：完整 4 项，但测试关注点可写无需专项测试或基础回归。
  - [x] 明确 harness 按需查询，不要求每个 MR 固定 prepare workspace；典型业务语义场景只作为例子，不能写成封闭白名单。
  - [x] 明确不硬性限制句数，改用信息聚焦规则控制噪声。
  - [x] 明确测试说明评论面向测试人员，优先使用业务/行为/接口/数据变化表达，避免只写技术实现摘要。
  - [x] 修正 walkthrough 文件变更表的关注等级规范：只允许 `🔴 阻塞`、`🟠 重要`、`🔵 建议`、`⚪ 仅说明`，禁止 shortcode 和英文等级。
  - [x] 明确第二条测试说明整体评论也必须使用 `<details>` 默认折叠，避免 MR 页面刷屏。
- [x] 更新 `packages/flower-code-reviewer/src/__tests__/prompts.test.ts`：
  - [x] 断言 prompt 要求发送第二条测试说明整体评论。
  - [x] 断言 prompt 包含测试说明评论标题。
  - [x] 断言 prompt 要求输出测试关注点。
  - [x] 断言 prompt 要求输出影响范围。
  - [x] 断言 prompt 要求 harness 依据路径和 ref/commit。
  - [x] 断言 prompt 要求未找到权威依据时明确标注。
  - [x] 断言 prompt 不再把“无问题”默认约束为 ≤3 行轻量评论。
  - [x] 断言 prompt 对低风险变更仍要求完整 4 项测试说明。
  - [x] 断言 prompt 保留 harness 按需查询策略，并明确触发条件不是封闭列表。
  - [x] 断言 prompt 不包含硬性句数上限，并要求避免重复 walkthrough / 复述完整 diff。
  - [x] 断言 prompt 要求测试说明面向测试人员可读，不能只输出文件/函数/实现细节。
  - [x] 断言 prompt 约束关注等级中文枚举，并禁止 `:large_orange_circle:` / `:white_circle:` / 英文等级出现在文件变更表示例中。
  - [x] 断言测试说明评论使用 `<details>` 默认折叠，且不得使用 `open` 属性。
- [x] 如果实现选择同步更新纯函数模板：
  - [x] 未修改 `comments/render.ts`；当前生产主路径由 prompt 驱动 `gitlab_post_comment`，无需新增 render 单测。
- [x] 运行验证命令。

## Validation

- `npm test --workspace @flower-ai/flower-code-reviewer`
- `npm test --workspace @flower-ai/flower-code-reviewer -- prompts.test.ts`
- `npm run build --workspace @flower-ai/flower-code-reviewer`
- `npm run typecheck`
- `npx biome check packages/flower-code-reviewer/src/prompts.ts packages/flower-code-reviewer/src/__tests__/prompts.test.ts`
- 如改动跨包类型或共享工具，再运行根目录 `npm test --workspaces --if-present`

## Review Gates

- Gate 1：用户确认评论块位置和 MVP 范围。
- Gate 2：规划评审通过后再 `task.py start`。
- Gate 3：实现完成后走 Trellis check 路由。
