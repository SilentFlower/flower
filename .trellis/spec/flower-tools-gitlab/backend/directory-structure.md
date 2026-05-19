# Directory Structure

> 见 `frontend/directory-structure.md`。

---

## 当前布局

```
src/
├── index.ts     # 工具层(frontend)
└── client.ts    # 后端层:GitlabClient 接口 + cachedClient + createStubClient
```

---

## `client.ts` 当前职责

- 定义 `GitlabClient` 接口(5 方法)+ 入参 / 出参类型
- 提供 `gitlabClient()` 惰性单例 getter
- 提供 `createStubClient(host, token)` 当前 stub 实现

真实接入后,**接口 `GitlabClient` 不变**,只把 `createStubClient` 换成 `createRealClient`(或两者并存,通过 env 切换便于本地开发)。

---

## 未来拆分

```
src/
├── index.ts
├── client.ts                # 接口 + gitlabClient() 单例 + 选择策略
└── clients/
    ├── stub.ts              # createStubClient(开发本地用)
    └── rest.ts              # createRestClient(生产用)
```

或者更轻量:在 `client.ts` 内根据 `process.env.GITLAB_STUB === "1"` 决定用哪个实现。

---

## Module Organization

- `GitlabClient` 接口是契约,**实现可换**
- 真实实现里**每个 endpoint 一个私有 helper**(`async function getMrChanges(projectId, mrIid)`)
- 公开方法只做"调 endpoint helper + 字段映射"

---

## Naming Conventions

- 接口实现工厂:`create<Variant>Client`(`createStubClient` / `createRestClient`)
- 私有 endpoint helper:动词 + REST 资源(`getMrChanges` / `postNote` / `postDiscussion`)
- HTTP 头常量:GitLab 命名(`PRIVATE-TOKEN`、`Sudo`)
