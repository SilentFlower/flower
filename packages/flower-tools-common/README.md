# @flower-ai/flower-tools-common

跨产品复用的通用工具集。当前面向**使用禅道 + 钉钉**的团队配置。

## 工具清单

| 工具 | 描述 | 状态 |
|------|------|:----:|
| `zentao_search` | 在禅道中搜索 bug / 任务 / 需求 / 用例 | Stub |
| `dingtalk_doc_search` | 在钉钉知识库 / 文档中检索 | Stub |

> 如果你的团队用 Jira / Confluence / 飞书文档等其他工具,可以 fork 本包替换实现。

## 用法

```typescript
import { registerCommonTools } from "@flower-ai/flower-tools-common";

export default function (pi: ExtensionAPI) {
  registerCommonTools(pi);
}
```

或者按需单独引用:

```typescript
import { zentaoSearchTool, dingtalkDocSearchTool } from "@flower-ai/flower-tools-common";

pi.registerTool(zentaoSearchTool);
// dingtalkDocSearchTool 不注册即可,LLM 看不到
```

## 环境变量

| 变量 | 必填 | 含义 |
|------|:----:|------|
| `ZENTAO_BASE_URL` | ✓ | 禅道实例地址,例如 `https://zentao.corp.internal` |
| `ZENTAO_TOKEN` | ✓ | 禅道 PAT 或 API token |
| `DINGTALK_APP_KEY` | ✓ | 钉钉企业内部应用 AppKey(用于换 accessToken) |
| `DINGTALK_APP_SECRET` | ✓ | 钉钉企业内部应用 AppSecret |

## TODO

- 接入禅道 REST API(`/api.php/v1/`)
- 接入钉钉文档 OpenAPI(注意 accessToken 缓存,2 小时有效)
- 视需要增加:钉钉群消息搜索、人员搜索、企业组织架构查询
