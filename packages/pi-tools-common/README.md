# @flower-ai/pi-tools-common

跨产品通用工具集。

## 当前包含

| 工具 | 描述 | 状态 |
|------|------|:----:|
| `jira_search` | Jira issue 检索 | Stub |
| `wiki_search` | 内部文档 / Wiki 检索 | Stub |

## 用法

```typescript
import { registerCommonTools } from "@flower-ai/pi-tools-common";

export default function (pi: ExtensionAPI) {
  registerCommonTools(pi);
}
```

## TODO

- 接入 Jira REST API
- 接入 Wiki / 飞书文档 / Confluence API
- 视需要增加:钉钉用户查询、企业人员搜索等
