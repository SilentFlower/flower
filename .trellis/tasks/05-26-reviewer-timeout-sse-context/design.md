# reviewer 稳定性设计

## Technical Design

### 1. 总评审软超时

在 `runReview` 调用 `piMain` 时增加外层 watchdog:

- 默认总软超时:`FLOWER_REVIEW_TIMEOUT_MS` 未配置时取 `1080000`(18 分钟),早于 infra-harness 默认 `20 minutes` hard timeout,预留约 2 分钟发表 warning 评论并退出。
- `piMain` 若在软超时前完成,主流程不变。
- `piMain` 若超时,抛出本包自定义的 `ReviewSoftTimeoutError`,进入现有 LLM fail open 分支。
- fail open 时复用 `postMrComment(projectId, mrIid, body, "minor")`,返回 `exitCode=0`。

说明:`piMain` 的公开 `main(args, options)` 没有暴露 AbortSignal,所以 v1 采用 `Promise.race` 做业务层软超时。该方案不能强杀底层 provider 请求,但能让 `runReview` 在 CI 窗口内进入 fail open 收尾;若后续发现 Node 进程仍被未完成请求挂住,再升级为子进程隔离。

### 1.1 infra-harness GitLab job hard timeout

`devops-infra-harness/devops-infra/templates/projects/application.yml` 的 `.flower-code-review` 当前写死:

```yaml
timeout: 10 minutes
```

这会让 GitLab Runner 把 Pod `activeDeadlineSeconds` 设置为 `10m0s`,优先于 reviewer 业务逻辑硬杀进程。内网 GitLab `18.10.1` 项目级 `ci/lint` 已验证 `timeout: $FLOWER_REVIEW_JOB_TIMEOUT` 非法,因此不能通过 CI/CD 变量动态展开 timeout。

可行设计:

- 模板默认值改为固定更长时长:`20 minutes`。
- reviewer 自身软超时默认小于该 hard timeout:`18 minutes`。
- 文档说明特殊项目可在业务仓同名 `code-review` job override `timeout`,但默认入口仍给出稳定值。

### 2. Provider 单次请求超时与重试

`pi-coding-agent` 从 settings 读取:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 120000,
      "maxRetries": 1,
      "maxRetryDelayMs": 15000
    }
  }
}
```

设计采用隔离的临时 pi agent 目录:

- 在 reviewer 启动期创建 `.flower-pi-agent/settings.json` 或系统临时目录下的 `flower-pi-agent-*`。
- 通过 `PI_CODING_AGENT_DIR` 指向该目录,避免污染 `~/.pi/agent/settings.json`。
- 若用户已显式设置 `PI_CODING_AGENT_DIR`,尊重用户目录,但仍只在该目录写 reviewer 需要的 settings。
- 默认 provider 单次超时:`FLOWER_LLM_REQUEST_TIMEOUT_MS=120000`。
- 默认 provider SDK 内部重试:`FLOWER_LLM_PROVIDER_MAX_RETRIES=1`。
- 默认 pi agent 级自动重试仍为 3 次,通过 `FLOWER_LLM_AGENT_MAX_RETRIES` 可覆盖。

### 3. SSE 空响应 / 接口失败

不单独解析 SSE 流;利用 `pi-ai` / `pi-coding-agent` 现有错误通路:

- provider 超时会形成 `timeout` / `timed out` / `AbortError` 等错误。
- 空 SSE / 无 finish 通常表现为 `Stream ended without finish_reason` / `ended without`。
- `agent-session` 已将这些错误归入 retryable。
- 本包 `isLlmFailure` 补全同类关键字,确保重试耗尽后的错误被 fail open。

### 4. 上下文读取收敛

`gitlab_get_file_content` 从“整文件读取”扩展为“行窗读取”:

- 新增可选参数:`startLine` / `endLine`,均为 1-based 闭区间。
- 传入区间时,工具只返回该行段,并在内容前后标注文件路径、ref、展示行号范围、总行数。
- 未传区间时,默认返回 `1..FLOWER_CONTEXT_READ_DEFAULT_LINES` 的有限行窗,不再整文件返回;默认值按用户决策取 `500` 行。
- 单次最大行数由 `FLOWER_CONTEXT_READ_MAX_LINES` 控制;超过时截断到最大行数并提示如何续读。
- 文件仍保留二进制跳过与 `FLOWER_MAX_FILE_SIZE` 兜底 size cap。

Prompt 改为两级策略:

1. 先读历史评论、文件列表、diff。
2. 基于 diff 做初筛,只有以下情况调用 `gitlab_get_file_content`:
   - 准备对该文件发表行内评论。
   - diff 片段不足以判断上下文。
   - 文件属于高风险入口/API/权限/金额/数据迁移/安全相关。
   - 需要验证相关定义、调用方或实体字段。

调用时优先传入变更行附近窗口(例如目标行前后 40-80 行);如果没读到定义、调用方或完整分支,再读取相邻窗口续读。

同时保留强约束:对某文件发 line comment 前必须读过该文件,否则 review-trace 仍会触发「无依据评论」blocker。v1 的 trace 仍按 path 记录“读过该文件”;后续若发现模型只读文件头却评论文件尾,再升级为 path+range 覆盖校验。

### 5. 读取预算

增加 prompt 层预算提示:

- 默认未指定行号时读取 `FLOWER_CONTEXT_READ_DEFAULT_LINES=500` 行。
- 默认单次最多返回 `FLOWER_CONTEXT_READ_MAX_LINES=1000` 行。
- 默认每轮最多批量读取 `FLOWER_CONTEXT_READ_BATCH_SIZE=5` 个窗口。
- 每轮批量读取预算是 prompt 行为约束;单次行数是工具层硬约束。

## Rollout / Rollback

- Rollout:先以默认 env + infra-harness 默认 timeout 生效,业务方无需改 yaml。
- Rollback:将 infra-harness `.flower-code-review timeout` 改回旧值可恢复旧 hard timeout;将 `FLOWER_REVIEW_TIMEOUT_MS=0` 可关闭总软超时;将 provider timeout env 设大可回退到接近旧行为。
- 风险:软超时使用 `Promise.race` 不能取消底层 `piMain`;若实际进程仍挂住,需要二期改子进程执行。
