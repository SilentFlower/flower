# 部署链路调研:company 分支自动构建 + k3s 自动部署

> 调研时间:2026-06-12;素材:flower 仓 company 分支 `.gitlab-ci.yml` + `/root/project/devops-infra-harness/devops-infra/`

## 一、镜像构建(已被 code-reviewer 验证的路径)

- flower 仓 `.gitlab-ci.yml` **仅存在于 company 分支**(origin/github 不参与 GitLab CI),include `digital-rd-infra/devops-infra` 的:
  - `/templates/.gitlab-ci-base.yml`:全局变量 `HARBOR_HOST=192.168.27.236`、`KANIKO_IMAGE`、`TZ=Asia/Shanghai`、`DEVOPS_INFRA_PROJECT/REF`;stages 声明 [build, package, deploy](被 flower 自己的 `stages:` 覆盖)
  - `/templates/node-cli-image.yml`:`.node-cli-image` 隐藏 job(Kaniko build & push,变量 `IMAGE_NAME` / `SUB_DIR` / `REGISTRY_NAMESPACE` 必填,tag 双写 `${CI_COMMIT_SHORT_SHA}` + latest,`PUSH_LATEST=false` 可关)
- code-reviewer 的实例适配(observer 必须复刻):
  - `tags: []` 覆盖模板默认 `infra-build-proxy`(本 GitLab 实例无该 runner)
  - Kaniko image `pull_policy: if-not-present`(runner admin 白名单不稳)
  - company-test 分支:`IMAGE_TAG=company-test-<sha>` + `PUSH_LATEST=false`(不污染 latest)
- Dockerfile:`packages/flower-observer/Dockerfile` **已存在**(node:22-alpine 两段构建,`tsc --build packages/flower-observer/tsconfig.json` 避 TS5083,tzdata 时区,SQLite 设计为挂 volume)
- Kaniko `--context` 取整仓根目录,`--dockerfile ${SUB_DIR}/Dockerfile` → monorepo 跨包 COPY 可行

## 二、k3s 部署引擎(`/templates/k8s-deploy.yml`)

- 隐藏 job:`.deploy-submit-unified`(stage `deploy-submit`)+ `.deploy-verify-unified`(stage `deploy-verify`)+ 可选钉钉通知 `.deploy-notify-submit-summary` / `.deploy-notify-final-summary`(stage `notify-submit` / `notify-final`,依赖 `.gitlab-ci-notify.yml` 的 `.dingtalk-script-setup-macro`)
- **业务侧 include + extends 直接用**(与 node-cli-image 同模式,不必走 V3 planner);消费方需在自己的 `stages:` 里补上述 stage 名
- 关键变量(submit/verify 共用):
  - `PIPELINE_BIZ_ENV=test` → rules `when: on_success` 自动部署(prod 才有 manual gate)
  - `DEPLOY_APP_NAME` / `DEPLOY_NAMESPACE`(自动 create namespace)/ `DEPLOY_IMAGE_REPO` / `DEPLOY_TARGET_TAG`
  - `DEPLOY_K8S_PROVIDER` 默认 **k3s**;非 prod 且无 `KUBECONFIG_CONTENT` 时用 runner **in-cluster 权限**(gitlab-runner 跑在 k3s 内,见 k3s-cluster-ops.md;SONAR_HOST_URL 也走 svc DNS,佐证集群内可达)
  - `DEPLOY_APP_PORT`(默认 8080)、`DEPLOY_SERVICE_TYPE`(默认 ClusterIP,支持 NodePort + `NODE_PORT`)、`REPLICAS` / CPU/MEM requests/limits
  - 健康检查三态:默认 tcp 保底;`DEPLOY_HEALTH_ENABLED=true` + `DEPLOY_HEALTH_TYPE=http` + `DEPLOY_HEALTH_PATH` → startup/readiness/liveness 三探针全开
- **环境变量注入约定**:
  - `APP_ENV_<NAME>=<value>` → 容器 env `<NAME>`(明文渲染进 manifest)
  - `APP_SECRET_<NAME>=<secretName>:<secretKey>` → `valueFrom.secretKeyRef`
  - ⚠️ 引擎会 `cat ./deploy.yaml` 预览 → **`APP_ENV_*` 的值会泄漏到 job log,secret 必须走 `APP_SECRET_*`**(k8s Secret 需提前手工 `kubectl create secret`)
- manifest 来源:默认拉 `manifests/k8s-standard-deployment.yaml`(sed 渲染 `__占位符__`);**`DEPLOY_CUSTOM_YAML_PATH` 可指向仓内自定义 YAML**(引擎 cp 后同样 sed 渲染,占位符照常可用)

## 三、标准 manifest 的缺口:无 volume

- `k8s-standard-deployment.yaml` = Deployment + Service,**无 PVC / volumeMount 支持**(无对应占位符与变量)
- observer SQLite(`OBSERVER_DB_PATH` 默认 `data/observer.db`,相对 WORKDIR `/app`)需要持久化 → 走 `DEPLOY_CUSTOM_YAML_PATH`:仓内放自定义 manifest(基底复制标准模板保留占位符),追加 PVC + volumeMount
- 集群存储:k3s 用 **Longhorn**(StorageClass;Node/Disk tag 调度,见 k3s-cluster-ops.md §Longhorn)
- ⚠️ SQLite 单写者 + Longhorn RWO:滚动更新默认 maxSurge=1 会出现新旧两 pod 同时要挂同一 PVC(跨节点 RWO 挂不上,且 WAL 不支持双写者)→ 自定义 manifest 里 strategy 改 **Recreate**,replicas 固定 1

## 四、接流配置(消费端)

- reviewer 侧挂 httpSink 的条件(`packages/flower-code-reviewer/src/telemetry-setup.ts:46-48`):
  - `FLOWER_TELEMETRY_URL` 配置即挂载(完整 ingest URL,不额外拼路径 → 应填 `http://<svc>:4810/v1/events`)
  - token 取 `FLOWER_TELEMETRY_TOKEN`(与 observer 的 `OBSERVER_INGEST_TOKEN` 配对)
  - 非 critical,受 `FLOWER_TELEMETRY` 总开关控制
- runner 在集群内 → CI job 用 svc DNS 直达:`http://flower-observer-svc.<ns>.svc.cluster.local:4810/v1/events`
- `SIEM_INGEST_URL`(siemSink)可选切到 observer `/v1/audit`(payload 兼容 sendAudit;切换前可双轨)
- observer 自身环境变量(`packages/flower-observer/src/config.ts`):`OBSERVER_PORT`(默认 4810)/ `OBSERVER_DB_PATH` / `OBSERVER_INGEST_TOKEN`(空=不鉴权)/ `OBSERVER_RETENTION_DAYS`(默认 90)/ `OBSERVER_STALE_RUNNING_MINUTES`(默认 30)/ `OBSERVER_GITLAB_BASE_URL`(外链渲染);`GET /healthz` 现成可做 http 探针

## 五、开放决策点(设计阶段拍板)

1. namespace 名(建议 `flower`)
2. NodePort 端口号(k3s 范围 30000-32767,建议 30481 谐音 4810)
3. token 注入:APP_SECRET_*(需一次性手工建 Secret)vs 测试线先裸跑(内网无鉴权)
4. 是否启用钉钉部署通知(notify 模板 + stages 两个)
5. SIEM_INGEST_URL 是否本期切到 observer(任务描述标可选)
