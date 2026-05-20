# flower-code-reviewer:auto-fix bot(回复评论触发自动改 + 提交 MR)

## ⚠️ Session Recovery Note

**当前状态**:任务**仅创建,brainstorm 完全未开始**(2026-05-20)。

**前置依赖**:sibling 任务 `05-20-code-reviewer-quality-and-pipeline`(N1-N4)必须接近完成,因为本任务依赖:
- N1 LLM 拉代码上下文 → auto-fix 必须能看代码全文
- N2 评论样式优化 → 用户回复的命令需要解析(如 `@flower fix`,可能借 N2 评论结构)
- N3 镜像 + Pipeline → 部署形态需先稳定

**下次启动前**:确认 sibling 任务三件套已就绪。

## Goal

把 code-reviewer 从「只评审 + 发评论」推进为「能根据用户在评论里的命令(如 `@flower fix`)自动改代码 + 自动 push 修复 commit 或开 sub-MR」。这是 code-reviewer 的**产品架构演进**,会破坏当前的 K1(CI Pipeline 一次性 Job)形态决策。

## Background / Known Context

### 来自上一任务(05-19)的固定决策(需重新评估)
- **D2 · K1 部署形态**:CI Job 一次性触发,跑完即退;**本任务可能需要改成 K2(常驻 service)** 因为评论 webhook 是事件驱动
- **compliance ci-readonly 模式**:禁 write/edit + bash 白名单;**本任务必须新增 `auto-fix` 模式**,放开 write/edit 但严格限制范围(只改评论指向的具体文件 + 具体行)

### 技术参考
- coderabbitai 的 `@coderabbitai resolve` / `@coderabbitai generate-fix` 类命令机制
- GitHub Apps webhook → bot 自动回复 / 自动 commit 的模式
- GitLab webhook(`note` event → MR comment 触发)

## Open Questions(brainstorm 起点)

待 sibling 任务接近完成后逐个深入:

### Q-触发机制(关键架构决策)
- 选项 X · webhook 常驻 service:用户评论里写 `@flower fix` → GitLab webhook 推到 flower 监听服务 → spawn agent 改代码 push
  - 需要常驻 HTTP 服务(类似 ops-bot 形态)+ k8s 部署 + 公网入口 / 反代
- 选项 Y · Quick Action / scheduled poll:用 GitLab 自带 `/spend` 类 quick action,或定时轮询 MR 评论
  - 不需要 webhook,但延迟高(轮询 N 分钟一次)
- 选项 Z · 手动 CLI 触发:维护开发者人工跑 `flower-apply-fix --mr-iid X --comment-id Y`
  - 最简单 / 不破 K1;但失去"自动"的产品价值

### Q-修复落地形式
- 直接 push 修复 commit 到 MR 源分支(简单,但用户失去 review 修复的机会)
- 开一个 sub-MR / 修复 branch(用户需要再合一次,但安全)
- 用 GitLab `suggestion` 评论让用户一键 apply(GitLab 是否支持 quick action `apply`?待调研)

### Q-范围控制(防止 bot 失控改坏代码)
- 只允许修复"评论指向的具体文件 + 具体行"?还是允许扩展(改导入 / 改 caller 也算合理范围)?
- 修复前是否要再跑一次评审?
- 改完是否要重新跑 review(避免修复引入新问题)
- 失败后怎么 rollback?

### Q-权限模型
- 谁能触发 fix?(MR 作者 / Maintainer / 任何 commenter?)
- 防止 abuse(同一 MR 短时间多次触发)

### Q-合规拦截模式新增
- 新增 `auto-fix` compliance 模式
- 允许 write/edit 但限制文件范围 + 操作类型
- 必须保留审计(谁在哪个 MR 上让 bot 改了什么)

## Requirements

(待 brainstorm 后填)

## Acceptance Criteria

(待 brainstorm 后填)

## Out of Scope(预设)

- **修复任意大型 refactor**:本期只做"评论级别的微改"(几行 / 几十行内)
- **多人协作 fix**(多个 commenter 同时让 bot 改)
- **跨 MR / 跨仓库 fix**

## Notes

- 本任务**强烈依赖** sibling `05-20-code-reviewer-quality-and-pipeline` 完成
- 启动顺序:先做 quality-and-pipeline → 再 brainstorm 本任务(届时 quality-and-pipeline 的部署形态、评论结构都已稳定,本任务可在那之上建增量)
- 任务复杂度高,brainstorm 阶段可能需要派 trellis-research 调研 coderabbitai 命令机制 + GitLab webhook 实践
