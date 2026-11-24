# 企业接入 Brief · GitLab Reviewer

## 目标

让正常的 `flower-review` CLI 通过共享运行时执行一次 GitLab 评审，并用同一合成 MR 对照旧入口。

## 范围

本地 `v2` 迁移 reviewer 的宿主接线，复用 provider、合规、GitLab 工具、评审收尾和 Observer 协议。模型、GitLab 和 Observer 使用回环服务或替身。公司 CI、钉钉、Desktop、真实 MR 写入与正式分发属于后续批次。

## 实现取舍

建议给共享运行时增加可选执行适配，由它实际启动、取消、等待并记录 reviewer 装配的 pi 1.6.0 `AgentSession`。用公开 SDK 的预加载回调保留用户级 `project_trust` 优先级，明确拒绝覆盖默认和记忆允许。内置 llama.cpp 仍是独立兼容评估项。建议统一 CLI 与工具读取的有效 MR，补强 `--dry-run` 和总超时的评论写入边界。Reviewer 每次 CLI 开新会话，pi JSONL 留作诊断。

## 验收

先冻结基线，再用同一夹具核对工具权限、两种评论的完整载荷、退出码 `0/1/2`、网关 warning、取消和 Observer 事件。Observer 既有 `incomplete` 单列对照。验证仓内、仓外和最终镜像的正常 CLI，回归共享运行时双宿主及全仓测试。

## 下一步

审阅通过后先固化基线夹具，再接共享执行适配。
