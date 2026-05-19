# State Management

> 客户端单例 + CI 环境变量。

---

## Overview

| 类型 | 载体 | 生命周期 |
|------|------|----------|
| 客户端 | `module-level let cachedClient` | 进程级,惰性 |
| CI 注入 env | `process.env.CI_*` | 进程级,只读 |
| 凭证 env | `process.env.GITLAB_TOKEN` / `GITLAB_HOST` | 进程级,只读 |
| 工具定义 | module-level `const` | 进程级,immutable |
| Severity schema | module-level `const severitySchema` | 进程级,immutable |

---

## State Categories

### 客户端单例(允许的 mutable)

```typescript
let cachedClient: GitlabClient | undefined;
```

理由:HTTP 客户端可以复用,避免每次工具调用都重建。

### CI 注入变量

- `CI_PROJECT_ID` — GitLab 项目 ID
- `CI_MERGE_REQUEST_IID` — MR IID(注意是 IID 不是 ID)
- `CI_PIPELINE_URL` — 当前 pipeline URL(未来可能用)
- `CI_JOB_TOKEN` — Job token(权限受限,不能 post comment)

约定:

1. 仓库 / MR 标识统一通过 `readEnv()` 读
2. 评审用 token **不能**用 `CI_JOB_TOKEN`(权限不够),要用专门配置的 `GITLAB_TOKEN`(对应一个有 MR 评论权限的机器人账号)

---

## When to Use Global State

允许:

- `cachedClient`(网络客户端单例)
- 工具定义 `const`
- `severitySchema` `const`

不允许:

- 缓存 MR diff / 评论历史(评审进程短,缓存无价值)
- 在 module-level 维护"本次评审进度"(应该走 prompt + LLM 行为)
- 全局 retry 计数器

---

## Server State

### MR 评论历史

通过 `gitlab_get_previous_review` 工具读,**不本地缓存**。

`prompts.ts` 中约定"评审开始前先调一次 `gitlab_get_previous_review`",
让 LLM 把历史评论作为上下文,避免重复发同样意见。

### MR diff / files

每次工具调用都拉一次远端,**不缓存**:

- 一次评审过程中,MR 不会改变(同一 commit hash)
- 但缓存收益低,且增加复杂度

---

## Common Mistakes

- ❌ 用 module-level `Map<projectId, mrDiff>` 缓存 diff(评审进程短,缓存无价值且占内存)
- ❌ 把 `cachedClient` 类型设为 `GitlabClient | null`(undefined 更清晰;null 暗示"显式空")
- ❌ 在 `gitlabClient()` 内除 `host` / `token` 外还读其他 env(违反"集中读环境"原则)
- ❌ 把 `readEnv()` 改成参数化的 helper(让每个工具自己传 env)— 当前的 module-level helper 已经够清晰
