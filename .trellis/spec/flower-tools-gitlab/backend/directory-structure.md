# Directory Structure

> 见 `frontend/directory-structure.md`。

---

## 当前布局

```
src/
├── index.ts             # 工具定义和注册
├── client.ts            # GitlabClient 接口、单例入口和 REST 实现
├── sanitize.ts          # GitLab 评论快捷指令转义
├── safe-read.ts         # 文件读取行窗和大小上限
├── workspace.ts         # 本地评审上下文
└── harness-discovery.ts # 本地上下文来源发现
```

---

## `client.ts` 当前职责

- 定义 `GitlabClient` 接口和入参、出参类型
- 提供 `gitlabClient()` 惰性单例 getter
- 使用 `createRealClient(host, token)` 调用 GitLab REST API

---

## `sanitize.ts` 当前职责

按 GitLab 快捷指令规则处理评论正文。整体和行内评论工具通过本地模块导入。纯函数行为与工具出站请求分别在 `sanitize.test.ts` 和 `tool-sanitize.test.ts` 验证。

---

## Module Organization

- `GitlabClient` 接口是契约,**实现可换**
- 真实实现里**每个 endpoint 一个私有 helper**(`async function getMrChanges(projectId, mrIid)`)
- 公开方法只做"调 endpoint helper + 字段映射"

---

## Naming Conventions

- 客户端工厂使用 `createRealClient`
- 私有 endpoint helper:动词 + REST 资源(`getMrChanges` / `postNote` / `postDiscussion`)
- HTTP 头常量:GitLab 命名(`PRIVATE-TOKEN`、`Sudo`)
