# Backend Development Guidelines

> `@flower-ai/flower-tools-common` 的内部实现层(API 客户端、accessToken 管理)规范。

---

## Overview

本目录(`backend/`)关心**与远端系统的 IO 实现** + **跨包通用 utility**:

| 模块 | 职责 |
|------|------|
| `src/zentao.ts` 内的 stub `execute` | 真实接入禅道 REST API |
| `src/dingtalk-doc.ts` 内的 stub `execute` + token 管理 | 真实接入钉钉文档 OpenAPI |
| `src/sanitize.ts` · `sanitizeQuickActions(body)` | **GitLab quick action 转义**(纯函数);行级扫描,凡 `^/(approve|close|wip|assign|label|milestone|due|spend|estimate|lock|merge|subscribe|confidential|todo|tag|cc|shrug|tableflip|draft|reviewer|award|...)` 50+ 关键字 → 首字符 `/` → `&#47;`(HTML escape);大小写不敏感;`flower-tools-gitlab` 的 post 评论工具 execute 内 wrap,防 LLM 输出误触 GitLab 服务端 quick action 改 MR 状态 |

zentao / dingtalk-doc 当前都是 stub(返回占位文本),真实接入时本目录的约定生效。sanitize 已是生产代码,无 stub 阶段。

---

## Guidelines Index

| Guide | 说明 |
|-------|------|
| [Directory Structure](./directory-structure.md) | 当前布局与未来拆分点 |
| [Database Guidelines](./database-guidelines.md) | 不适用 |
| [Error Handling](./error-handling.md) | API 错误 / 凭证错误处理策略 |
| [Logging Guidelines](./logging-guidelines.md) | 不打 token / 文档原文 / 凭证 |
| [Quality Guidelines](./quality-guidelines.md) | 与 frontend/ 共用 |

---

## 关键设计点

1. **真实接入按系统切**:禅道 / 钉钉是两套独立的 API + 鉴权,实现绝不混用
2. **token 缓存与刷新**:仅钉钉需要,2 小时有效,提前 60s 刷新
3. **凭证 fail-fast**:首次工具调用时 throw,不在 import 时
4. **URL 拼接安全**:`encodeURIComponent` 必用
5. **超时必须设**:网络调用 10s 上限(可调,但要明确)
6. **通用 utility 收敛模式**:跨多个 tools-* package 都可能用到的纯函数(如 sanitize / encoding / time helpers)统一放在 flower-tools-common,**不在每个 tools-* package 各写一份**;下游 package(如 flower-tools-gitlab)通过 `@flower-ai/flower-tools-common` workspace dep 引用,`tsconfig.json` `references` 必须加 `../flower-tools-common`
