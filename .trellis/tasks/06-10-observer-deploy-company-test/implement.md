# Implement · observer company 测试线自动构建 + k3s 自动部署

> 按序执行;Step 3 是一次性手工环境准备(需要 kubectl / GitLab 管理权限,由用户或在有权限的终端执行)。
> CI 片段与 manifest 全文以 `design.md` 为准,本文件只列步骤与验证命令。

## Step 1 · 新增自定义 manifest

- 新建 `packages/flower-observer/deploy/k3s-observer.yaml`,内容 = design.md §四全文
- 自检:`grep -c "__" packages/flower-observer/deploy/k3s-observer.yaml` 占位符齐全(APP_NAME/IMAGE_PATH/APP_PORT/probes/资源等);
  确认无 `__REPLICAS__` / `__SPRING_OPTS__` / `__JVM_OPTS__` / `__ROLLING_UPDATE_*__`(已被写死值取代)

## Step 2 · 修改 company 分支 `.gitlab-ci.yml`

- 按 design.md §三:include 增 2 个模板文件、workflow 增 company 分支 `PIPELINE_BIZ_ENV=test` 注入、
  stages 扩为 6 个、新增 6 个 job(build / submit / verify / notify×3)+ `.observer-deploy-vars`
- 既有 `build-flower-code-reviewer` / `code-review` 原样不动
- 自检:本地 `python3 -c "import yaml,sys; yaml.safe_load(open('.gitlab-ci.yml'))"` 语法过;
  GitLab CI Lint(项目 → CI/CD → Editor → Lint)校验 include 解析

## Step 3 · 一次性环境准备(手工)

```bash
# 3.1 namespace + Secret(Secret 必须先于首次部署)
kubectl create namespace flower
TOKEN=$(openssl rand -hex 24)
kubectl -n flower create secret generic flower-observer-secrets \
  --from-literal=ingest-token="${TOKEN}"
echo "${TOKEN}"   # 留存,下一步配 GitLab 变量用

# 3.2 校验全局凭据已存在(GitLab 管理区 → CI/CD Variables)
#     HARBOR_USER / HARBOR_PASS / DING_TOKEN_TEST / DING_SECRET_TEST
```

- 3.3 flower 项目(gitlab.xhgjdev.com/xhgj003027/flower)Settings → CI/CD → Variables:
  - 新增 `FLOWER_TELEMETRY_URL` = `http://flower-observer-svc.flower.svc.cluster.local:4810/v1/events`
  - 新增 `FLOWER_TELEMETRY_TOKEN`(masked)= 3.1 的 `${TOKEN}`
  - 修改 `SIEM_INGEST_URL` = `http://flower-observer-svc.flower.svc.cluster.local:4810/v1/audit`

## Step 4 · 提交推送触发流水线(走 trellis-push)

- commit 范围:`packages/flower-observer/deploy/k3s-observer.yaml` + `.gitlab-ci.yml`(+ 任务三件套)
- push company → 观察 pipeline:`build-flower-observer` → `deploy-submit` → `notify-submit`(钉钉①)→
  `deploy-verify` → `notify-final`(钉钉②)

## Step 5 · AC 验证清单

```bash
# 5.1 镜像(Harbor)
curl -s -u "$HARBOR_USER:$HARBOR_PASS" "http://192.168.27.236/v2/base/flower-observer/tags/list"

# 5.2 部署可用
kubectl -n flower rollout status deployment/flower-observer
kubectl -n flower get pods,svc,pvc -l app=flower-observer

# 5.3 健康与 UI(任一集群节点 IP)
curl -s "http://<node-ip>:30481/healthz"          # {"ok":true}
# 浏览器打开 http://<node-ip>:30481/traces 三页 UI

# 5.4 audit 通道(SIEM 切流;带 token)
curl -s -X POST "http://<node-ip>:30481/v1/audit" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"kind":"session_start","product":"smoke-test"}'   # {"stored":true,...}

# 5.5 接流端到端:提一个测试 MR 触发 code-review(dogfooding)
#     → observer /traces 列表出现对应 trace,详情页可回放

# 5.6 持久化:删 pod 重建后数据仍在
kubectl -n flower delete pod -l app=flower-observer
kubectl -n flower rollout status deployment/flower-observer
# 重新打开 UI,历史 trace 不丢

# 5.7 company-test 分支隔离:push company-test
#     → 仅 build(tag=company-test-<sha>,不推 latest),无 deploy/notify job
```

## Step 6 · spec 沉淀

- `.trellis/spec/flower-observer/backend/`:新增 `deploy-guidelines.md`(部署拓扑、变量清单、
  Recreate+PVC 约束、APP_SECRET 防日志泄漏),index.md 的 Guidelines Index 表追加一行
- 验证:`python3 ./.trellis/scripts/get_context.py --mode packages` 正常列出

## 风险与中断恢复

- deploy-submit 失败:看 job log 的「部署变量探针」与 `print_rollout_diagnostics` 输出;
  常见因:Secret 未建(CreateContainerConfigError)、镜像 tag 不存在(company-test sha 误部署)、PVC Pending(longhorn StorageClass 名)
- verify 超时:`kubectl -n flower describe pod` 看探针;`/healthz` 为 GET 200,探针端口 4810
- 全链回滚:design.md §六
