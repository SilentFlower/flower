# @flower-ai/pi-tools-gitlab

GitLab 工具集。**仅供 code-reviewer 使用**。

## 工具清单

| 工具 | 描述 | 状态 |
|------|------|:----:|
| `gitlab_get_mr_diff` | 获取本次 MR 完整 diff | Stub |
| `gitlab_get_mr_files` | 列出修改的文件 | Stub |
| `gitlab_post_comment` | 发整体评论(支持 severity) | Stub |
| `gitlab_post_line_comment` | 发行内评论(文件 + 行号) | Stub |
| `gitlab_get_previous_review` | 查 bot 历史评论(避免重复) | Stub |

## 用法

```typescript
import { registerGitlabTools } from "@flower-ai/pi-tools-gitlab";

export default function (pi: ExtensionAPI) {
  registerGitlabTools(pi);
}
```

## 环境变量

| 变量 | 必填 | 含义 |
|------|:----:|------|
| `GITLAB_TOKEN` | ✓ | 个人 / 项目 / bot token |
| `GITLAB_HOST` | | 默认 `https://gitlab.com` |
| `CI_PROJECT_ID` | ✓ | 由 GitLab CI 自动注入 |
| `CI_MERGE_REQUEST_IID` | ✓ | 由 GitLab CI 自动注入 |

## TODO

- 把 `client.ts` 里的 stub 换成真实的 fetch 调用
- 处理 GitLab 限流(`Retry-After` header)
- 增加 `position` 计算(行内评论必须)
- 增加对 `commits` 接口的支持,以便单 commit 评审而非整个 MR
