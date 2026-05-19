# Directory Structure

> 见 `frontend/directory-structure.md`。本节聚焦后端实现模块。

---

## 当前布局

```
src/
├── index.ts   # 工具定义(frontend 层)
└── mask.ts    # 后端层:RULES + maskSensitive
```

---

## `mask.ts` 模块职责

- 维护 `RULES: ReadonlyArray<{ pattern, replace }>`(脱敏规则)
- 提供 `maskSensitive(text: string): string`
- **不**做正则编译性能优化(`RegExp` 已是 module-level const,JS 引擎会自动缓存)
- **不**做 streaming 脱敏(全文一次性 replace,简单可控)

---

## 未来拆分

真实接入 SDK 后,新增:

```
src/
├── index.ts            # 工具定义(变薄,主要拼装 params 与调 client)
├── mask.ts             # 脱敏
├── client.ts           # SDK 客户端单例,环境变量校验
└── tools/              # (可选)单工具一个文件
    ├── query-logs.ts
    └── ...
```

---

## Module Organization 原则

- 每模块单一职责
- 脱敏 / 客户端 / 工具定义清晰分层
- 不要为了"扩展性"提前创建 `utils/` `helpers/` `common/` 兜底目录

---

## Naming Conventions

- 单例 getter:`get<Resource>Client`(`getSlsClient`)
- 私有变量:下划线前缀(`let _slsClient: ... | undefined`)
- 模块常量:全大写下划线(`RULES`)
- 函数:camelCase(`maskSensitive`、`getSlsClient`)
