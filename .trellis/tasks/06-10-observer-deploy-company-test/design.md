# Design · observer company 测试线自动构建 + k3s 自动部署

> 前置:`prd.md`(R1~R6 + 已拍板决策)、`research/deploy-pipeline.md`(引擎调研)。
> 本文档给出可直接落地的 CI 片段与 manifest 全文,实现阶段照抄 + 校对。

## 一、链路总览

```
push company 分支(flower 仓,内网 GitLab)
  └─ GitLab CI(stages: build → review → deploy-submit → notify-submit → deploy-verify → notify-final)
       ├─ build-flower-observer        Kaniko 构建 → Harbor 192.168.27.236/base/flower-observer:{<sha>,latest}
       ├─ deploy-submit-flower-observer  渲染自定义 manifest → kubectl apply(k3s in-cluster,ns=flower)
       ├─ notify-deploy-submit-summary   钉钉「发版已提交」
       ├─ deploy-verify-flower-observer  rollout status + wait Available(http /healthz 三探针)
       ├─ notify-deploy-final-summary    钉钉「发版已完成/失败」
       └─ notify-deploy-early-failure    .post 兜底通知
k3s ns=flower:
  Deployment flower-observer(Recreate,1 副本,PVC longhorn 1Gi 挂 /app/data)
  Service flower-observer-svc(NodePort 30481 → 4810)
接流:
  reviewer CI job ──FLOWER_TELEMETRY_URL──▶ http://flower-observer-svc.flower.svc.cluster.local:4810/v1/events
  siemSink ──SIEM_INGEST_URL──▶ 同 host /v1/audit
```

## 二、关键设计决策(ADR)

1. **部署门控用 workflow 变量,不覆盖模板 rules**:`.deploy-*-unified` 的 rules 依赖
   `PIPELINE_BIZ_ENV` 且在 rules 里注入 `K8S_TOOL_VERSION`(脚本 `set -u` 引用,覆盖 rules 会炸)。
   → 在 `workflow:rules` 仅对 `company` 分支注入 `PIPELINE_BIZ_ENV: "test"`,其余 pipeline(MR / tag /
   company-test)该变量为空 → 模板 rules 全不匹配 → deploy job 不进 pipeline。模板零侵入。
2. **SQLite 持久化走自定义 manifest**(`DEPLOY_CUSTOM_YAML_PATH`):标准模板无 volume;
   自定义文件保留全部 `__占位符__` 供引擎 sed 渲染,仅追加 PVC / volumeMount / `strategy: Recreate` / 写死 `replicas: 1`。
   Recreate 原因:SQLite 单写者 + Longhorn RWO,滚动更新双 pod 抢同一 PVC 必卡死。
3. **token 走 `APP_SECRET_*`**:引擎 `cat deploy.yaml` 预览会把 `APP_ENV_*` 值打进 job log;
   `APP_SECRET_OBSERVER_INGEST_TOKEN=flower-observer-secrets:ingest-token` 渲染为 secretKeyRef,值不落日志。
4. **notify job 命名对齐兜底契约**:`.deploy-notify-early-failure` 的 L3 去重按 job 名
   `notify-deploy-final-summary` 精确匹配 → 两个 summary job 必须用这个命名。
5. **deploy 变量收敛单处**:submit / verify 必须看到同一套 DEPLOY_* (verify 重跑 setup-macro),
   抽 `.observer-deploy-vars` hidden job,两个 job `extends` 数组尾部引入(GitLab extends 后者优先)。

## 三、`.gitlab-ci.yml` 变更(company 分支)

```yaml
include:
  - project: 'digital-rd-infra/devops-infra'
    ref: main
    file:
      - '/templates/.gitlab-ci-base.yml'
      - '/templates/node-cli-image.yml'
      - '/templates/k8s-deploy.yml'          # 新增:统一部署引擎
      - '/templates/.gitlab-ci-notify.yml'   # 新增:钉钉 setup macro

workflow:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_TAG'
    - if: '$CI_COMMIT_BRANCH == "company"'
      variables:
        PIPELINE_BIZ_ENV: "test"             # 仅 company push 进入部署链(见 ADR-1)
    - if: '$CI_COMMIT_BRANCH == "company-test"'
    - when: never

stages:
  - build
  - review
  - deploy-submit
  - notify-submit
  - deploy-verify
  - notify-final

# ── 新增 Job 1:observer 镜像构建(rules / 适配完全复刻 build-flower-code-reviewer)──
build-flower-observer:
  extends: .node-cli-image
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
      when: never
    - if: '$CI_COMMIT_TAG'
    - if: '$CI_COMMIT_BRANCH == "company"'
    - if: '$CI_COMMIT_BRANCH == "company-test"'
      variables:
        IMAGE_TAG: "company-test-${CI_COMMIT_SHORT_SHA}"
        PUSH_LATEST: "false"
    - when: never
  tags: []
  image:
    name: ${KANIKO_IMAGE}
    entrypoint: [""]
    pull_policy: if-not-present
  variables:
    IMAGE_NAME: 'flower-observer'
    SUB_DIR: 'packages/flower-observer'
    REGISTRY_NAMESPACE: 'base'

# ── 部署共用变量(submit / verify 共享,见 ADR-5)──
.observer-deploy-vars:
  tags: []
  variables:
    DEPLOY_APP_NAME: 'flower-observer'
    DEPLOY_NAMESPACE: 'flower'
    DEPLOY_IMAGE_REPO: '${HARBOR_HOST}/base/flower-observer'
    DEPLOY_TARGET_TAG: '${CI_COMMIT_SHORT_SHA}'
    DEPLOY_APP_PORT: '4810'
    DEPLOY_SERVICE_TYPE: 'NodePort'
    NODE_PORT: '30481'
    DEPLOY_HEALTH_ENABLED: 'true'
    DEPLOY_HEALTH_TYPE: 'http'
    DEPLOY_HEALTH_PATH: '/healthz'
    DEPLOY_CUSTOM_YAML_PATH: 'packages/flower-observer/deploy/k3s-observer.yaml'
    APP_ENV_OBSERVER_DB_PATH: '/app/data/observer.db'
    APP_ENV_OBSERVER_GITLAB_BASE_URL: 'http://gitlab.xhgjdev.com'
    APP_SECRET_OBSERVER_INGEST_TOKEN: 'flower-observer-secrets:ingest-token'

# ── 新增 Job 2/3:部署提交与可用性校验 ──
deploy-submit-flower-observer:
  extends: [.deploy-submit-unified, .observer-deploy-vars]

deploy-verify-flower-observer:
  extends: [.deploy-verify-unified, .observer-deploy-vars]

# ── 新增 Job 4/5/6:钉钉通知(命名契约见 ADR-4)──
notify-deploy-submit-summary:
  extends: .deploy-notify-submit-summary
  rules:
    - if: '$CI_COMMIT_BRANCH == "company"'
      when: always
    - when: never

notify-deploy-final-summary:
  extends: .deploy-notify-final-summary
  rules:
    - if: '$CI_COMMIT_BRANCH == "company"'
      when: always
    - when: never

notify-deploy-early-failure:
  extends: .deploy-notify-early-failure
  rules:
    - if: '$CI_COMMIT_BRANCH == "company"'
      when: always
    - when: never
```

> 既有 `build-flower-code-reviewer` / `code-review` job 不动。

## 四、自定义 manifest:`packages/flower-observer/deploy/k3s-observer.yaml`

以 harness `manifests/k8s-standard-deployment.yaml` 为基底:**保留全部 `__占位符__`**,
变更点 = ①追加 PVC ②strategy 改 Recreate ③replicas 写死 1 ④追加 volume 挂载 ⑤删 Java 专属 env(SPRING_OPTS/JVM_OPTS)。

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: flower-observer-data
  labels:
    app: __APP_NAME__
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: longhorn
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: __APP_NAME__
  labels:
    app: __APP_NAME__
spec:
  replicas: 1                      # SQLite 单写者,固定单副本(不用 __REPLICAS__)
  strategy:
    type: Recreate                 # RWO PVC,禁止新旧 pod 并存(ADR-2)
  minReadySeconds: __MIN_READY_SECONDS__
  progressDeadlineSeconds: __PROGRESS_DEADLINE_SECONDS__
  selector:
    matchLabels:
      app: __APP_NAME__
  template:
    metadata:
      labels:
        app: __APP_NAME__
    spec:
__POD_SCHEDULING__
      containers:
      - name: __APP_NAME__
        image: __IMAGE_PATH__
        imagePullPolicy: Always
        env:
        - name: NODE_HOST_IP
          valueFrom:
            fieldRef:
              fieldPath: status.hostIP
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        - name: K8s_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: TZ
          value: "Asia/Shanghai"
        - name: APP_NAME
          value: "__APP_NAME__"
  __EXTRA_ENV_VARS__
        ports:
        - containerPort: __APP_PORT__
          name: main-port
__EXTRA_CONTAINER_PORTS__
__STARTUP_PROBE__
__READINESS_PROBE__
__LIVENESS_PROBE__
        resources:
          requests:
            cpu: "__CPU_REQUEST__"
            memory: "__MEM_REQUEST__"
          limits:
            cpu: "__CPU_LIMIT__"
            memory: "__MEM_LIMIT__"
        volumeMounts:
        - name: data
          mountPath: /app/data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: flower-observer-data
---
apiVersion: v1
kind: Service
metadata:
  name: __APP_NAME__-svc
spec:
  type: __SERVICE_TYPE__
  sessionAffinity: __SESSION_AFFINITY__
  selector:
    app: __APP_NAME__
  ports:
    - name: main-port
      protocol: TCP
      port: __APP_PORT__
      targetPort: __APP_PORT__
      __NODE_PORT_CONFIG__
__EXTRA_SERVICE_PORTS__
```

> 引擎对缺失占位符的 sed 是 no-op(如 `__REPLICAS__` / `__SPRING_OPTS__` 已删),安全。
> PVC 每次 deploy 重复 `kubectl apply` 幂等(spec 不变)。

## 五、配置面变更清单(GitLab / k8s,一次性手工)

| 位置 | 项 | 值 |
|------|----|----|
| k3s | namespace | `flower`(手工先建,或首跑由引擎建——但 Secret 必须先于首次部署存在) |
| k3s Secret | `flower-observer-secrets`(ns=flower) | key `ingest-token` = 随机 48 hex |
| flower 项目 CI Variables | `FLOWER_TELEMETRY_URL` | `http://flower-observer-svc.flower.svc.cluster.local:4810/v1/events` |
| 同上(masked) | `FLOWER_TELEMETRY_TOKEN` | 与 Secret 的 ingest-token 同值 |
| 同上(改值) | `SIEM_INGEST_URL` | `http://flower-observer-svc.flower.svc.cluster.local:4810/v1/audit` |
| 全局 CI Variables(校验已存在) | `HARBOR_USER` / `HARBOR_PASS` / `DING_TOKEN_TEST` / `DING_SECRET_TEST` | 既有,不新增 |

## 六、回滚设计

- CI 链路:revert `.gitlab-ci.yml` 提交(company 分支)即停自动部署;镜像构建 job 可单独保留
- 运行实例:`kubectl -n flower delete deployment/flower-observer service/flower-observer-svc`;
  **PVC 不删**,数据保留,重部署自动续用
- 接流:清空 `FLOWER_TELEMETRY_URL`(httpSink 不挂载)、`SIEM_INGEST_URL` 改回旧值;客户端 fail-open,全程不影响评审
