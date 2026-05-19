# Database Guidelines

> **不适用** — `flower-providers` 无存储层。

---

## Overview

本包不连数据库、不写文件、不维护进程内可变状态。
所有"配置"通过环境变量 + module-level 常量(`CUSTOM_MODELS`)定义。

---

## 为什么没有存储

1. **职责单一**:本包就是"把 LLM 网关注册到 pi",注册完即不再活动
2. **凭证从 env 读**:不在本包做 vault / KMS 集成(那是更上层的事)
3. **模型清单作为代码**:模型变更需要 code review + 部署,不能"动态从远端拉"(防止被攻击篡改模型字段)

---

## 如果未来要加凭证管理

新增 `src/credentials.ts`,优先级:

1. 环境变量(当前)
2. AWS Secrets Manager / 阿里云 KMS / Hashicorp Vault(可选)
3. 本地配置文件(只允许开发环境)

凭证管理必须:

- **不缓存到 module-level 变量**(短生命周期)
- **支持轮换**(periodic refresh)
- **失败 fail-fast**

但当前的设计**故意不做这些**(YAGNI)。

---

## Query Patterns / Migrations / Naming Conventions

不适用。
