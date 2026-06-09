# 仓库上下文检查摘要

## flower-code-reviewer

- `packages/flower-code-reviewer/src/prompts.ts` 是评论结构的核心约束入口。
- 当前整体评论要求使用 walkthrough 结构，包含 `## 概要`、`## 文件变更`、`## 行动建议`。
- 当前 prompt 已要求：
  - 先查历史评论，避免重复。
  - 看 MR 文件与 diff。
  - 评论前读取相关行窗。
  - 发完行内 blocker 后调用 `reviewer_list_my_blockers`，再写 walkthrough 顶部 blocker alert。
  - 涉及业务/需求事实时优先查 harness 仓库。
- `packages/flower-code-reviewer/src/comments/render.ts` 有纯函数 `renderWalkthrough`，但非当前主生产路径；它仍可作为模板和测试参考。
- `packages/flower-code-reviewer/src/__tests__/prompts.test.ts` 已覆盖 prompt 中的上下文读取、跨项目 harness 引导、blocker 自审工具等硬约束。

## flower-tools-gitlab

- `packages/flower-tools-gitlab/src/index.ts` 已提供跨项目上下文工具：
  - `gitlab_list_group_projects`
  - `gitlab_list_project_branches`
  - `gitlab_prepare_project_workspace`
- 工具设计要求准备本地工作区后用 `rg` 搜索 harness 文档，不使用 `gitlab_search_project_blobs`。
- 工具层会对 GitLab 评论 body 做 quick action sanitize。

## devops-infra-harness

- `/root/project/devops-infra-harness/devops-infra/docs/code-review-design.md` 记录了 code-review 接入 V3 主入口的设计。
- `templates/projects/application.yml` 已内置 `code-review` job：
  - 只在 `merge_request_event` 运行。
  - 默认 `allow_failure: true`，blocker 评论仅留痕，不默认挡合并。
  - 默认 `timeout: 20 minutes`。
  - image 使用 `${HARBOR_HOST}/${FLOWER_REGISTRY_NAMESPACE}/flower-code-reviewer:${FLOWER_IMAGE_TAG}`。
- `/root/project/devops-infra-harness/devops-infra/docs/sop-onboard-code-review.md` 说明业务方接入只需 V3 主入口 include 和 4 个 secret。
- `/root/project/devops-infra-harness/.trellis/tasks/archive/2026-05/05-20-code-reviewer-harness-template/prd.md` 是早期 harness 模板任务；实际设计后来合并到 `application.yml`。

## 初步判断

本需求适合先改 `prompts.ts` 的整体评论结构，不需要新增 GitLab 工具或修改 harness 模板。若后续要机器消费测试建议，再考虑把测试说明结构化到 `comments/render.ts` 或新增 `reviewer_*` 自审工具。

## MR !43 关注等级渲染问题

- 访问 `http://gitlab.xhgjdev.com/digital-biz-projects/iqs/xhgj-iqs-ui/-/merge_requests/43` 的 API 后确认，bot 评论里文件变更表出现：
  - `:white_circle: 已阅`
  - `:large_orange_circle: major`
- 这说明生产路径主要受 `prompts.ts` few-shot 和自然语言约束影响；LLM 会在关注等级列自由生成 GitLab shortcode 和英文 severity。
- `:large_orange_circle:` 在 GitLab 中不是稳定可渲染 shortcode，容易原样显示。
- 结论：本任务应同步收紧“文件变更 / 关注等级”列取值，改成稳定中文枚举：`🔴 阻塞`、`🟠 重要`、`🔵 建议`、`⚪ 仅说明`。
