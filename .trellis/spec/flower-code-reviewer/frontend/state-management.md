# State Management

> CLI 参数、环境变量、运行期上下文的流转方式。

---

## Overview

`code-reviewer` 是**短生命周期 CLI**(几分钟内跑完退出),没有持久化状态、没有跨请求会话。
"state" 在本包内只有 4 类:

| 类型 | 载体 | 生命周期 |
|------|------|----------|
| CLI 参数 | `CliArgs` 对象 | 进程级,只读 |
| 环境变量 | `process.env.*` | 进程级,只读 |
| 运行期上下文 | `piMain` 内部 | 单次评审,框架管理 |
| GitLab 评论历史 | 远端 GitLab,通过 `gitlab_get_previous_review` 工具读 | 远端持久,本进程只读 |

---

## State Categories

### 1. CLI 参数(本地)

- 类型:`CliArgs`(`src/args.ts`)
- 流向:`parseArgs(argv)` 产生 → `runReview(args)` 消费
- 不可变:解析后只读

### 2. 环境变量(进程级)

按用途分组:

| 变量 | 用途 | 谁读 |
|------|------|------|
| `CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID` | GitLab CI 注入,标识 MR | `gitlab-tools` 内的 `readEnv()` |
| `GITLAB_TOKEN` / `GITLAB_HOST` | GitLab API 凭证 | `gitlab-tools/client.ts` |
| `LLM_BASE_URL` / `LLM_API_KEY` | LLM 网关 | `flower-providers` |
| `SIEM_INGEST_URL` / `DEBUG_AUDIT` | 审计 | `flower-compliance/audit.ts` |

**读取约定**:就近读,**不要**在 `cli.ts` 一股脑读完再传递。

### 3. 运行期上下文(框架内)

- pi 框架内部维护:LLM 调用栈、tool 调用历史、token 用量、stream 状态
- 我们**不直接访问**这些内部状态
- 唯一暴露给我们的接口是 `pi.on(event, handler)` 事件回调

### 4. 远端状态

- GitLab MR 评论:通过 `gitlab_get_previous_review` 工具读
- 增量评审的"上次评审到哪了":通过历史评论中的元信息推断(目前 PRD 未实现)

---

## When to Use Global State

**本包内,不允许使用**:

- 全局 `let xxx = undefined` 变量(单元测试无法重置)
- module-level mutable 缓存(评审进程短,缓存几乎没收益)

**唯一例外**:`@flower-ai/flower-tools-gitlab/src/client.ts` 的 `cachedClient`,因为它是惰性初始化的 HTTP 客户端,且进程内幂等。

---

## Server State

不适用(本包无 server)。

如果要对应:**远端状态**就是 GitLab 上的 MR 评论。约定:

1. **每次评审之前** 调用 `gitlab_get_previous_review` 拉一次,避免重复发同样的评论(在 `prompts.ts` 中已写进 prompt)
2. **写操作**(`gitlab_post_comment` / `gitlab_post_line_comment`)**不做本地缓存**,直接打远端
3. **失败重试**:`gitlab_post_*` 不在本层做重试,失败抛错由 pi 框架捕获,记录后继续下一项(避免一条评论失败阻塞整个评审)

---

## Common Mistakes

- ❌ 把 `process.env.CI_MERGE_REQUEST_IID` 解析后存进 module-level `let mrIid` 当全局缓存(测试时改不掉,且让数据流变隐式);改成函数局部 `const`
- ❌ 用 module-level `Map` 累积评审意见,最后一次性发(违反"边评审边发评论"原则,pi 流式输出会中断时丢失);**每发现一项问题立即调 `gitlab_post_*` 工具**
- ❌ 在 `extension.ts` 工厂里把 `options.appSource` 存进 module-level `const`(同一进程多次评审会串味);**永远通过参数传递**
- ❌ 用全局 `pickedSkill` 变量(`skill-selector` 应该是纯函数,每次调用都重新算)
