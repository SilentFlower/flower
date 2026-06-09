# codereview 添加面向测试的变更说明评论块 · 设计草案

## Technical Design

### 当前结构

- `prompts.ts` 是实际控制 LLM 评论结构的主入口。
- `comments/render.ts` 提供纯函数模板，但当前生产路径没有直接调用 `renderWalkthrough` 生成最终整体评论。
- GitLab 整体评论通过 `gitlab_post_comment` 工具发表，工具层会执行 quick action sanitize，并根据 severity 注入必要 marker。
- harness 跨项目上下文已经通过 prompt 和 `flower-tools-gitlab` 工具链存在，不需要新增工具。

### 候选方案

#### 方案 A：在现有 walkthrough 内新增测试说明章节

在 `prompts.ts` 的整体评论结构中新增章节，例如：

- `## 面向测试的变更说明`
  - `变更摘要`
  - `影响范围`
  - `测试关注点`
  - `需求/依据`

优点：
- 评论仍然只有一条整体 walkthrough，GitLab MR 页面不刷屏。
- 与现有 `<details>` 折叠结构一致，测试人员打开一条评论即可看到评审结论和测试建议。
- 主要改 prompt 和测试，风险低。

代价：
- 仍依赖 LLM 按 prompt 生成结构，无法做到完全确定性。
- 若未来需要机器消费测试建议，章节文本不如结构化 trace 稳定。

#### 方案 B：新增独立“测试说明”整体评论（已选择）

评审完成后单独调用一次 `gitlab_post_comment`，输出只面向测试的说明。

优点：
- 测试说明在 MR 页面更醒目。
- 与代码问题评论解耦，后续可单独开关。

代价：
- MR 评论数量增加，可能造成噪声。
- 需要更强的 prompt 工作流约束，避免 LLM 忘记发第二条评论。
- 与现有“整体 walkthrough 一条主评论”的 UX 不一致。

#### 方案 C：新增 reviewer 自审工具，要求 LLM 先记录结构化测试说明再渲染

新增类似 `reviewer_list_my_blockers` 的 `reviewer_*` 工具，用于记录或校对测试关注点。

优点：
- 结构化程度更高，未来可做质量统计或后处理。
- 可降低 LLM 长上下文遗漏“测试关注点”的概率。

代价：
- 实现复杂度更高，当前需求尚未证明需要。
- 会扩大 trace 状态和工具注册面。

### 已确认决策

已选择方案 B。测试说明作为第二条整体评论单独发送，不塞进现有代码评审 walkthrough。这样测试说明更醒目，也避免单条 walkthrough 内容过长。若后续发现 LLM 经常漏写测试说明，再考虑方案 C 的自审工具。

## Rollout / Rollback

- Rollout：只改 prompt 与单测，随 flower-code-reviewer 镜像版本发布；业务方可通过 `FLOWER_IMAGE_TAG` 锁定版本。
- Rollback：回退第二条测试说明评论要求即可，不影响 GitLab 工具、blocker 扫描或 harness 模板。

## Compatibility Notes

- 不改变 `gitlab_post_comment` / `gitlab_post_line_comment` schema。
- 不改变 `scanForBlockers` 行为。
- 不改变 `application.yml` 中 `code-review` job 的触发和失败策略。
- 需要继续遵守 prompt 中 quick action 禁令和工具优先级规则。
- 现有“无问题轻量评论”主路径需要调整：即使代码评审本身无问题，也要额外发送测试说明评论。
- 低风险变更仍走完整 4 项测试说明；prompt 应提供低风险写法，避免 LLM 为文档/格式化变更编造复杂测试点。
- harness 仍按需查询，不把 `gitlab_prepare_project_workspace` 变成每个 MR 的固定步骤；触发条件应是开放式业务依据判断，不能写死为少数关键词或封闭场景列表。
- 测试说明评论不硬性限制句数；应通过“只写对测试执行有帮助的信息、不要重复 walkthrough、不要复述完整 diff”来控制噪声。
- 测试说明评论面向测试人员，语气和结构必须降低开发实现细节密度：先说明用户/业务/接口/数据层面的变化，再给测试关注点；文件名、函数名、代码结构只作为依据补充，不作为主体。
- 代码评审 walkthrough 的文件变更表需要同步修正：关注等级列不再允许 LLM 自由生成 shortcode 或英文等级，统一使用 `🔴 阻塞`、`🟠 重要`、`🔵 建议`、`⚪ 仅说明`。
