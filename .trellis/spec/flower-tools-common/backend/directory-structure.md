# Directory Structure

> 见 `frontend/directory-structure.md`。

---

## 当前布局

```
src/
├── index.ts          # 装配点(frontend 层)
├── zentao.ts         # 禅道工具 + 真实 API 实现
└── dingtalk-doc.ts   # 钉钉文档工具 + accessToken 管理 + 真实 API
```

---

## 未来拆分

工具数量 / 内部逻辑超过 ~80 行时,拆为:

```
src/
├── index.ts
├── zentao/
│   ├── tool.ts         # zentaoSearchTool 定义
│   ├── client.ts       # ZenTao REST 客户端
│   └── types.ts        # API 响应类型
└── dingtalk-doc/
    ├── tool.ts
    ├── client.ts
    └── token.ts        # accessToken 缓存与刷新
```

当前 < 80 行,**不要提前拆分**。

---

## Module Organization 原则

- **每个外部系统独立子目录**
- **token 管理在系统内部**(`dingtalk-doc/token.ts`)
- **不创建 `utils/` `helpers/` `shared/` 兜底目录**

---

## Naming Conventions

- token 获取函数:`get<System>AccessToken`
- 客户端工厂:`get<System>Client`
- 私有缓存:`_cached<X>`
- 错误前缀:`[zentao]` / `[dingtalk-doc]`
