# @flower-ai/flower-tools-gitlab

供 Flower 代码评审应用使用的 GitLab REST 工具。

## 工具

| 工具 | 用途 |
| --- | --- |
| `gitlab_get_mr_diff` | 读取带行号的 MR diff |
| `gitlab_get_mr_files` | 列出 MR 变更文件 |
| `gitlab_get_file_content` | 读取指定 ref 的文件内容，支持行窗 |
| `gitlab_get_previous_review` | 读取机器人已发的评审评论 |
| `gitlab_post_comment` | 提交 MR 整体评论 |
| `gitlab_post_line_comment` | 提交 MR 行内评论 |
| `gitlab_list_group_projects` | 列出允许访问的组内项目 |
| `gitlab_list_project_branches` | 列出允许访问的项目分支 |
| `gitlab_prepare_project_workspace` | 准备评审需要的本地项目上下文 |

整体和行内评论工具在发送前共用包内的 `src/sanitize.ts`，将已知 GitLab 快捷指令的行首斜杠转义为 `&#47;`。普通文本、路径和已经转义的行保留原样。转义函数由工具在包内调用。

代码评审扩展通过包根导出的 `registerGitlabTools(pi)` 注册工具。评审 CLI、权限配置及试跑方法见[评审应用文档](../../apps/code-reviewer/README.md)。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `GITLAB_TOKEN` | GitLab API 访问凭据 |
| `GITLAB_HOST` | GitLab 实例地址，默认 `https://gitlab.com` |
| `CI_PROJECT_ID` | GitLab CI 注入的项目标识 |
| `CI_MERGE_REQUEST_IID` | GitLab CI 注入的 MR 编号 |
