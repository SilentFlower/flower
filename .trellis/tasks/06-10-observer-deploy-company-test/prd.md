# observer company 测试线打包部署(集成 devop-infra-harness)

## Goal

把 flower-observer 部署到 company 测试线并集成 devops-infra harness:**push company 分支 → 自动 Kaniko 构建镜像推 Harbor(192.168.27.236)→ 自动部署到 k3s(滚动可用性校验)**,全程零手动;评审 CI 通过 `FLOWER_TELEMETRY_URL`/`FLOWER_TELEMETRY_TOKEN` 接流到 observer,SQLite 数据经 Longhorn PVC 持久化。

> 调研结论见 `research/deploy-pipeline.md`(构建/部署引擎细节、manifest 缺口、接流变量、开放决策点)。

## Requirements

### R1 · 镜像自动构建(复刻 code-reviewer 已验证路径)

- company 分支 `.gitlab-ci.yml` 新增 `build-flower-observer`,`extends: .node-cli-image`,变量:
  `IMAGE_NAME=flower-observer` / `SUB_DIR=packages/flower-observer` / `REGISTRY_NAMESPACE=base`
- 复刻实例适配:`tags: []` 覆盖(本实例无 infra-build-proxy runner)、Kaniko image `pull_policy: if-not-present`
- rules 对齐 `build-flower-code-reviewer`:company push/tag 构建推 `<short-sha>` + `latest`;
  company-test 分支独立 tag(`company-test-<sha>`)且 `PUSH_LATEST=false`;MR pipeline 不构建
- Dockerfile 用现有 `packages/flower-observer/Dockerfile`,不改

### R2 · k3s 自动部署(harness 统一部署引擎)

- include 增加 `/templates/k8s-deploy.yml`;`stages` 扩充 `deploy-submit` / `deploy-verify`
- 新增 `deploy-submit-flower-observer`(extends `.deploy-submit-unified`)与
  `deploy-verify-flower-observer`(extends `.deploy-verify-unified`),共用变量:
  - `PIPELINE_BIZ_ENV=test`(test 线 on_success 自动)、`DEPLOY_K8S_PROVIDER` 走默认 k3s(runner in-cluster)
  - `DEPLOY_APP_NAME=flower-observer`、`DEPLOY_NAMESPACE=flower`(已拍板)
  - `DEPLOY_IMAGE_REPO=${HARBOR_HOST}/base/flower-observer`、`DEPLOY_TARGET_TAG=${CI_COMMIT_SHORT_SHA}`
  - `DEPLOY_APP_PORT=4810`;健康检查 `DEPLOY_HEALTH_ENABLED=true` + `DEPLOY_HEALTH_TYPE=http` + `DEPLOY_HEALTH_PATH=/healthz`
- 部署 rules **仅 company 分支 push**(company-test 只构建不部署;MR/tag 不部署)
- job 依赖链:build 成功 → submit → verify(`needs` 串联,部署失败 pipeline 红)

### R3 · SQLite 持久化(自定义 manifest)

- 标准模板无 volume → 仓内新增自定义 manifest(如 `packages/flower-observer/deploy/k3s-observer.yaml`),
  以 `manifests/k8s-standard-deployment.yaml` 为基底**保留全部 `__占位符__`**(引擎 sed 照常渲染),追加:
  - PVC:Longhorn StorageClass,1Gi 起步
  - Deployment `volumeMount` 挂 `/app/data`
  - strategy 改 **Recreate**、replicas 固定 1(SQLite 单写者 + Longhorn RWO,滚动更新双 pod 抢挂同一 PVC 必卡)
- 部署 job 设 `DEPLOY_CUSTOM_YAML_PATH=packages/flower-observer/deploy/k3s-observer.yaml`
- 环境变量注入(harness `APP_ENV_*` 约定):
  - `APP_ENV_OBSERVER_DB_PATH=/app/data/observer.db`(显式绝对路径)
  - `APP_ENV_OBSERVER_GITLAB_BASE_URL=http://gitlab.xhgjdev.com`
  - `OBSERVER_INGEST_TOKEN` **必须走 `APP_SECRET_OBSERVER_INGEST_TOKEN=<secret>:<key>`**
    (引擎 `cat deploy.yaml` 预览会把 `APP_ENV_*` 值打进 job log;Secret 一次性手工创建,步骤写入 implement)

### R4 · UI 访问入口

- `DEPLOY_SERVICE_TYPE=NodePort` + `NODE_PORT=30481`(已拍板),浏览器直开三页 UI;MVP 不引入 ingress

### R5 · 评审 CI 接流(消费端配置)

- flower 项目 CI/CD Variables 新增:
  - `FLOWER_TELEMETRY_URL=http://flower-observer-svc.<ns>.svc.cluster.local:4810/v1/events`(runner in-cluster,svc DNS 直达)
  - `FLOWER_TELEMETRY_TOKEN` 与 `OBSERVER_INGEST_TOKEN` 同值(masked)
- dogfooding `code-review` job 即自动挂 httpSink 推流(`telemetry-setup.ts` 检测 URL 即挂载,代码零改动)
- `SIEM_INGEST_URL` **本期切到** `http://flower-observer-svc.flower.svc.cluster.local:4810/v1/audit`
  (改 flower 项目 CI 变量值即可,payload 兼容 sendAudit;业务方项目的同名变量在推广期再切)

### R6 · 边界

- 仅改 company 分支 `.gitlab-ci.yml` + 新增 `packages/flower-observer/deploy/` manifest + GitLab 配置(CI Variables / k8s Secret);
  **不改 observer / telemetry 任何 src 代码**
- 钉钉部署通知**本期启用**:include `/templates/.gitlab-ci-notify.yml`,stages 加 `notify-submit` / `notify-final`,
  jobs 命名 `notify-deploy-submit-summary` / `notify-deploy-final-summary`(对齐兜底 job 的 L3 去重契约)+ `.post` 早失败兜底

## Acceptance Criteria

- [ ] push company 分支:`build-flower-observer` → `deploy-submit` → `deploy-verify` 全自动执行,pipeline 全绿,无手动步骤
- [ ] Harbor 出现 `base/flower-observer:<short-sha>` 与 `latest`
- [ ] k3s 目标 namespace 的 Deployment `flower-observer` 达到 Available,http `/healthz` 三探针通过
- [ ] 浏览器经 NodePort 可打开 trace 列表 / 详情回放 / 指标三页 UI
- [ ] 跑一次真实 MR 评审(dogfooding),observer 列表出现对应 trace,详情可回放(接流打通)
- [ ] `kubectl delete pod` 重建后历史 trace 仍在(PVC 持久化生效)
- [ ] push company-test 分支:仅构建 `company-test-<sha>` 镜像,不推 latest、不触发部署
- [ ] 部署提交与终态两条钉钉通知到达测试群
- [ ] `curl -X POST <svc>/v1/audit` 模拟一条审计返回 200 且入库 security_events(SIEM 切流生效)
- [ ] 部署拓扑与变量清单沉淀到 spec(`.trellis/spec/flower-observer/backend/` 增补部署指南或 README 链接)

## Notes

- 决策点已全部拍板(2026-06-12):① namespace=`flower` ② NodePort=30481 ③ token 走 k8s Secret(APP_SECRET_*)
  ④ 钉钉通知启用 ⑤ SIEM_INGEST_URL 本期切到 observer
- complex 任务:启动实现前补 `design.md`(自定义 manifest 全文 + CI 片段)与 `implement.md`(含一次性 `kubectl create secret` 与验证命令)
- 风险:Longhorn RWO + Recreate 意味着部署期间服务短暂不可用(测试线可接受);客户端 httpSink fail-open,断流不影响评审主流程
