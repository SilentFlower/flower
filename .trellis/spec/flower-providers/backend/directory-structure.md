# Directory Structure

> 见 `frontend/directory-structure.md`。本节聚焦未来拆分边界。

---

## 当前布局

```
src/
└── index.ts   # 单文件:CUSTOM_MODELS + registerCompanyProviders + getDefaultModelId
```

---

## 未来拆分的触发条件

| 当出现 | 拆出 |
|--------|------|
| 模型清单 > 50 行 / 包含多 provider | `src/models.ts` |
| 多个独立 provider(不只是 company) | `src/providers/<name>.ts` |
| 模型选择策略复杂(基于 token / 时段 / 用户) | `src/selector.ts` |
| 引入凭证管理(从 Vault 拉而非 env) | `src/credentials.ts` |

---

## Module Organization 原则

如果拆分:

- **每个文件单一职责**(模型清单 / provider 注册 / 选择策略 / 凭证 各一个文件)
- **`index.ts` 退化为 re-export 入口**
- **不创建 "utils" / "helpers" 兜底文件**,该归属哪里就归属哪里

---

## Naming Conventions

见 `frontend/directory-structure.md`。
