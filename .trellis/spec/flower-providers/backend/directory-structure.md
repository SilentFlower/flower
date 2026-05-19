# Directory Structure

> 见 `frontend/directory-structure.md`。本节聚焦未来拆分边界。

---

## 当前布局

```
src/
├── index.ts        # 纯 re-export(≤ 10 行)
├── env.ts          # 环境变量校验与解析(唯一直接读 process.env 的文件)
├── catalog.ts      # BUILTIN_MODELS + ProviderName + PROVIDER_TO_API 等常量
├── register.ts     # registerHavefunProviders 实现
└── runtime.ts      # getDefaultModel + buildHavefunModel 实现
```

5 个源文件 + `__tests__/` 单元测试目录。

---

## 未来拆分的触发条件

| 当出现 | 拆出 |
|--------|------|
| `BUILTIN_MODELS` > 50 条 | `src/catalog/{claude,gemini,openai}.ts` 按家族分文件 |
| 多套独立 LLM 网关(不只是 havefun) | `src/registries/<name>.ts` |
| 模型选择策略复杂(基于 token / 时段 / 用户) | `src/selector.ts` |
| 引入凭证管理(从 Vault 拉而非 env) | `src/credentials.ts` |
| 增加 OAuth / 非标鉴权头 | `src/oauth.ts` |

---

## Module Organization 原则

- **每个文件单一职责**(env / catalog / register / runtime 各一个文件)
- **`index.ts` 退化为 re-export 入口**,绝不写实现
- **不创建 "utils" / "helpers" 兜底文件**,该归属哪里就归属哪里
- **`env.ts` 是唯一直接读 `process.env` 的文件**,其他模块通过 `env.ts` 间接读

---

## Naming Conventions

见 `frontend/directory-structure.md`。
