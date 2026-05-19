# Database Guidelines

> **不适用** — `flower-tools-common` 无自己的数据库。

---

## Overview

本包是禅道 / 钉钉文档的**远端只读客户端**:

- 不连数据库
- 不缓存查询结果
- 不写本地文件
- **唯一**进程内可变状态:钉钉 accessToken 缓存

---

## "数据"约定

虽然不是数据库,远端访问应像数据库一样严格:

| 数据库约定 | 本包对应 |
|--------------|----------|
| ORM | 无(直接 `fetch`,因 endpoint 少) |
| 连接池 | 无显式池(HTTP/1.1 KeepAlive 默认) |
| 凭证 | `process.env.{ZENTAO,DINGTALK}_*` |
| 限流 | 远端 API 自带,本包不重复 |
| token 管理 | 钉钉:进程内缓存;禅道:`Bearer ${token}` 静态 |

---

## Query Patterns

### URL 拼接

```typescript
const url = `${baseUrl}/api.php/v1/search?keywords=${encodeURIComponent(params.query)}`;
```

**必须** `encodeURIComponent`,防注入 / 特殊字符。

### Limit 必带

工具 schema 有 `limit`(默认 10),query 时透传给远端。
不允许"无 limit 全量拉"。

### Pagination

LLM 调一次工具就一页。需要更多结果让 LLM 再调一次(传 `offset` 参数或 `next_cursor`,看远端 API)。

---

## Migrations

不适用。

---

## Naming Conventions

不适用(无 schema)。
