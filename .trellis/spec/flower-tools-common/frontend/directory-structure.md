# Directory Structure

> `@flower-ai/flower-tools-common` 的目录布局。

---

## Directory Layout

```
packages/flower-tools-common/
├── src/
│   ├── index.ts          # re-export + registerCommonTools 集中入口
│   ├── zentao.ts         # zentaoSearchTool + 禅道相关常量
│   └── dingtalk-doc.ts   # dingtalkDocSearchTool + 钉钉文档相关
├── dist/
├── package.json
└── tsconfig.json
```

---

## Module Organization

### 按外部系统切分

不同于 `flower-tools-arms`(一个文件),本包按**外部系统**切文件:

| 文件 | 对应系统 |
|------|----------|
| `zentao.ts` | 禅道(国内项目管理工具,类 Jira) |
| `dingtalk-doc.ts` | 钉钉知识库 / 文档 |

理由:

- 两个系统的 API / 鉴权 / token 管理完全不同
- 拆开后单文件 ~50 行,易读、易测
- 未来新增系统(GitHub Issues / Notion / Confluence)只需加新文件

### `index.ts` 职责

- re-export 每个工具(便于 import 单独工具)
- `registerCommonTools(pi)` 集中注册函数

不要在 `index.ts` 里写工具实现 — 实现归各自的 `<system>.ts`。

---

## Naming Conventions

- 工具变量:`<system><Action>Tool`(`zentaoSearchTool`、`dingtalkDocSearchTool`)
- 工具 `name`:`<system>_<action>` snake(`zentao_search`、`dingtalk_doc_search`)
- 文件名:小写 kebab-case,与系统名一致(`zentao.ts`、`dingtalk-doc.ts`)
- 注册函数:`registerCommonTools`(全部一起)
- 环境变量:
  - 禅道:`ZENTAO_BASE_URL` / `ZENTAO_TOKEN`
  - 钉钉:`DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET`

---

## Examples

- 集中导出 + 注册:`src/index.ts:11-24`
- 禅道工具定义:`src/zentao.ts:36-67`
- 钉钉文档工具定义:`src/dingtalk-doc.ts:26-52`

---

## 反模式

- ❌ 把所有工具堆在 `index.ts`(系统多了文件会过长)
- ❌ 创建 `utils.ts` 兜底文件(钉钉 token 缓存应该归 `dingtalk-doc.ts`,禅道版本判断归 `zentao.ts`)
- ❌ 把 `accessToken` 缓存放 module-level 单例(应该归各自的子模块)
