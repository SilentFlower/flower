# implement.md

## Implementation Checklist

- [x] 读取相关 spec：`flower-tools-gitlab/backend`、`flower-tools-common/backend`、`flower-code-reviewer/backend`、共享 guides。
- [x] 修 `workspace.ts` 的 git HTTP 鉴权，改用不泄漏 token 的 Basic Auth header，并补测试。
- [x] 按用户决策放行 CI bash 白名单内的 `python3`，允许 reviewer 用镜像内置 Python 库读取 Excel / Word 模板。
- [x] 保持 `write` / `edit`、网络外发、包管理和写文件类命令仍被 CI 只读合规拦截，补或保留合规测试。
- [x] 给行内评论增加 diff 可评论行校验和整体评论 fallback，补 client/tool 单测。
- [x] 更新 README / docs 中 reviewer 工具说明或运行能力说明。

## Validation

- `pnpm --filter @flower-ai/flower-tools-gitlab test`
- `pnpm --filter @flower-ai/flower-tools-common test`
- `pnpm --filter @flower-ai/flower-code-reviewer test`
- 如存在统一校验脚本，追加运行仓库约定的 lint / typecheck。

## Review Gates

- 实现前确认 task 状态切到 `in_progress`。
- 实现后运行 Trellis check。
- 若新增依赖，确认 lockfile 变化必要且最小。

## Rollback Points

- 跨项目 workspace 鉴权改动可独立回滚。
- `python3` 白名单可从 `flower-compliance` 独立回滚。
- 行内评论 fallback 可独立回滚到原 POST `/discussions` 行为。
