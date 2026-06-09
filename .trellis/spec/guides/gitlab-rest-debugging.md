# GitLab REST Debugging Guide

> 用环境变量里的 GitLab token 快速确认 MR、评论、diff、pipeline 状态时使用。

---

## 什么时候用

- 用户给了 GitLab MR / pipeline / job 链接,并说明可以用环境变量里的 token 访问 GitLab。
- 需要确认 reviewer 是否发过评论、行内评论挂在哪一行、为什么降级成整体评论。
- 需要确认 MR diff refs、变更文件列表、pipeline 是否重跑、镜像 tag 是否生效。
- 需要删除 bot 旧评论或触发重跑前,先做只读核查和备份。

详细 API、curl 示例、错误矩阵见:
`.trellis/spec/flower-code-reviewer/frontend/index.md` 的 `10.5 GitLab REST 查询速查 SOP`。

---

## 排查清单

- [ ] 从 URL 提取 `PROJECT_PATH` 和 `MR_IID`;`/-/merge_requests/47` 中的 `47` 是 MR IID。
- [ ] token 优先用 `GLAB_NEW_TOKEN`,其次 `GITLAB_TOKEN`;缺 token 时停止。
- [ ] host 优先用 `GITLAB_HOST`,未设置时默认 `http://gitlab.xhgjdev.com`。
- [ ] `PROJECT_PATH` 必须整体 URL encode,例如 `a/b/c` → `a%2Fb%2Fc`。
- [ ] token 只放 `PRIVATE-TOKEN` header,不要放 URL、remote、日志或 shell 输出。
- [ ] 查 MR 基本信息先调 `/projects/:project/merge_requests/:iid`。
- [ ] 查 diff / 行内 position 先调 `/changes`;`diff_refs` 是 position 的 sha 来源。
- [ ] 查整体评论和行内评论统一调 `/notes`;行内位置看 `position.new_path` / `position.new_line`。
- [ ] 查 reviewer 是否重跑优先看 `/merge_requests/:iid/pipelines`,必要时再看项目 `/pipelines`。
- [ ] 写操作前先备份:删评论先 dump notes,重跑 pipeline 前确认旧 pipeline 状态。

---

## 常见误判

- 404 不一定是 MR 不存在,常见原因是 project path 没有整体 encode。
- MR URL 中的数字是 IID,不要拿全局 MR id 替代。
- `GET /notes` 同时返回整体评论和行内评论,不需要先查 discussion id。
- pipeline retry 只重跑 failed / canceled job;reviewer 已 success 时要新建 MR pipeline 或推空 commit。
- `latest` 镜像在 `pull_policy=IfNotPresent` 下可能不更新,业务方需要临时锁 sha tag。

---

## 最小命令骨架

```bash
TOKEN="${GLAB_NEW_TOKEN:-${GITLAB_TOKEN:-}}"
HOST="${GITLAB_HOST:-http://gitlab.xhgjdev.com}"
PROJECT_PATH="digital-biz-projects/iqs/xhgj-iqs-ui"
PROJECT="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PROJECT_PATH")"
MR_IID="47"
test -n "$TOKEN" || { echo "缺少 GLAB_NEW_TOKEN / GITLAB_TOKEN" >&2; exit 1; }
curl -s -H "PRIVATE-TOKEN: $TOKEN" "$HOST/api/v4/projects/$PROJECT/merge_requests/$MR_IID"
```

---

## 先问自己

- 我是在确认事实,还是准备做写操作?
- 这个接口是否会泄漏 token、评论全文或内部信息到日志?
- 404 前是否已经确认 project path 整体 encode?
- 需要证明行内评论位置时,有没有同时看 `/changes` 和 `/notes`?
