# flower-code-reviewer 详细 HTML 文档 · 实施计划

## 1. 前置校验

- [ ] 读取 `prd.md`、`design.md` 和本计划,确认 S1-S12、AC1-AC4、Out of Scope 没有冲突。
- [ ] 读取 `intro.html` 的设计令牌和布局样式,提取可复用的 CSS 语言。
- [ ] 读取 `packages/flower-code-reviewer/src/` 相关源码,确认入口、参数、主流程、prompt、extension、observability、review trace、comments 的实际定义。
- [ ] 读取跨包事实来源: `flower-providers`、`flower-tools-gitlab`、`flower-tools-common`、`flower-compliance` 中与 PRD 表格和依赖图相关的源码。

## 2. 文件迁移

- [ ] 确认 `docs/intro.html` 是当前实现载体,根目录不再保留 `intro.html`。
- [ ] 不创建 `docs/code-reviewer-detailed.html`。
- [ ] 用 `git diff -M -- docs/intro.html intro.html` 或 `git diff -M --stat` 确认迁移关系。

## 3. 文档正文实现

- [ ] 校对 `docs/intro.html` 的 B2.1 入口、Quick Facts 和 S1-S12 锚点。
- [ ] 校对 S1-S3:定位、触发链路图、包依赖图和 sibling package 表。
- [ ] 校对 S4:逐一覆盖当前源码内部模块,每个模块写清「做什么 / 关键设计点 / 何时被调」。
- [ ] 校对 S5-S7:prompt 工作流、已 ship features、错误处理与 exit code 语义。
- [ ] 校对 S8-S10:env 表、GitLab CI 接入示例、容器与部署说明。
- [ ] 校对 S11-S12:已知局限和 prompt few-shot 附录。

## 4. 事实校对

- [ ] 对照 `flower-providers/src/env.ts` 和 `flower-code-reviewer/src/run.ts` 校对 S8 env 表。
- [ ] 对照 GitLab tools 源码校对 S3/S4/S6 的工具名称、severity marker、safe read、评论发送行为。
- [ ] 对照 `prompts.ts` 确认 S5 工作流和 S12 few-shot 文本,PRD 要求字符级一致的片段必须从源码复制。
- [ ] 对照 `Dockerfile` 和已有 spec 沉淀校对 S10 镜像、wrapper、部署链路。
- [ ] 对照当前仓库 grep 结果确认没有遗漏对 `intro.html` 的引用迁移。

## 5. 验证命令

- [ ] `git diff -M --stat`
- [ ] `git diff -M -- docs/intro.html intro.html`
- [ ] `rg -n "<script\\s+src|<link\\s+[^>]*stylesheet|@import|mermaid|cdn" docs/intro.html`
- [ ] `rg -n "id=\"b2-1-s(1|2|3|4|5|6|7|8|9|10|11|12)\"" docs/intro.html`
- [ ] `rg -n "gitlab_get_previous_review|gitlab_get_mr_files|gitlab_get_mr_diff|gitlab_get_file_content|gitlab_post_line_comment|gitlab_post_comment" docs/intro.html`
- [ ] 如环境允许,用浏览器或 Playwright 打开 `docs/intro.html`,确认无控制台错误、布局无明显重叠。

## 6. Review Gate

启动实现前必须确认:

- [ ] `prd.md`、`design.md`、`implement.md` 已齐全。
- [ ] `implement.jsonl` 和 `check.jsonl` 已替换为真实 spec 上下文。
- [ ] 任务状态已通过 `python3 ./.trellis/scripts/task.py start .trellis/tasks/05-21-code-reviewer-detailed-html` 切换到 `in_progress`。
- [ ] 进入 Phase 2 时先走 `trellis-route(target=implement)`,不要直接跳过路由。
