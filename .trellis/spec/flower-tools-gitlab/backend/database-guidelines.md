# Database Guidelines

> **不适用** — `flower-tools-gitlab` 无自己的数据库。

---

## Overview

GitLab 是远端 REST API,本包是其客户端。

- 不连数据库
- 不缓存远端结果(MR diff / 评论历史 在评审进程内每次都新拉)
- 不写本地文件

---

## "数据"对应

| 数据库约定 | 本包对应 |
|--------------|----------|
| ORM | 无,直接 `fetch` |
| 凭证 | `process.env.GITLAB_TOKEN` |
| Schema 版本 | GitLab REST API v4 |
| 限流 | GitLab 限流 600 req/min,本包不重复限流(评审单 MR 远低于此) |

---

## Query Patterns

### 写 endpoint

- `POST .../notes`(整体评论)
- `POST .../discussions`(行内评论)

写操作**不重试**:失败由 LLM 通过工具调用结果感知,决定要不要再发一次。

### 读 endpoint

- `GET .../changes`(MR diff + files)
- `GET .../notes?per_page=100`(评论列表;真实实现可能要分页)

读操作**可重试**(idempotent),但当前 stub 不做;真实接入时按需加重试。

### Pagination

- GitLab 默认 `per_page=20`,**必须显式传** `per_page=100`(我们最大批量)
- 如果一次拉不完,迭代 `?page=N` 拼接
- 行数 > 1000 的 MR 用单次 100 也够(99% 的 MR 不超过 30 个文件 / 100 条评论)

---

## Migrations / Naming Conventions

不适用。
