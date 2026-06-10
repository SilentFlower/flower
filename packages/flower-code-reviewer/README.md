# @flower-ai/flower-code-reviewer

GitLab Pipeline 代码评审 Agent。

## 工作流程

```
GitLab CI 触发
   │
   ▼
flower-review --mr-iid $CI_MERGE_REQUEST_IID
   │
   ├─ 选 skill(根据文件类型自动选 general / backend / frontend / security)
   ├─ 构造 prompt(注入 skill 内容 + 严格工具使用约束)
   └─ 启动 pi-coding-agent (print 模式)
        │
        ├─ extension 注册:
        │    - LLM provider(自部署 / 内部 / 第三方代理)
        │    - 合规拦截(只读模式)
        │    - GitLab 工具集
        │
        └─ LLM 自主评审:
             1. gitlab_get_previous_review
             2. gitlab_get_mr_files
             3. gitlab_get_mr_diff
             4. read / grep 看上下文
             5. gitlab_post_line_comment(行内评论)
             6. gitlab_post_comment(整体评论)
   │
   ▼
退出码:
  0 - 评审完成,无 blocker
  1 - 有 blocker,pipeline fail
  2 - agent 运行异常
```

## 用法

### 本地试跑

```bash
export GITLAB_TOKEN=xxx
export GITLAB_HOST=https://gitlab.corp.internal
export CI_PROJECT_ID=123
export CI_MERGE_REQUEST_IID=456
export LLM_BASE_URL=...
export LLM_API_KEY=...

cd packages/flower-code-reviewer
npm run dev -- --dry-run
```

### 集成到 GitLab CI

把 `.gitlab-ci.example.yml` 里的 job 复制到你的项目 `.gitlab-ci.yml`,
并配置以下 CI 变量(都建议设为 masked / protected):

| 变量 | 含义 |
|------|------|
| `REVIEWER_BOT_TOKEN` | GitLab bot 账号的 token,需有 MR 评论权限 |
| `LLM_BASE_URL` | LLM 网关 baseUrl |
| `LLM_API_KEY` | LLM 网关 API key |
| `SIEM_INGEST_URL` | 审计上报地址(可选;由 flower-telemetry siemSink 消费,metadata-only) |
| `FLOWER_TELEMETRY_FILE` | JSONL trace 输出路径(可选,默认 `flower-review-trace.jsonl`;配 artifacts 收集做评审质量分析) |
| `FLOWER_TELEMETRY_URL` | 观测服务 ingest 端点(可选;配置后挂载 httpSink,实时批量推送全量 trace 事件) |
| `FLOWER_TELEMETRY_TOKEN` | httpSink 推送的 Bearer token(可选;配合 `FLOWER_TELEMETRY_URL` 使用) |
| `FLOWER_TELEMETRY` | 观测总开关(可选;`0` 关闭 JSONL/console/http 采集,SIEM 审计不受影响) |
| `FLOWER_VERBOSE` | CI 日志打印开关(可选;默认开,`0` 关) |

### 构建镜像

```bash
# 在 flower 根目录
docker build -f packages/flower-code-reviewer/Dockerfile -t yourcompany/flower-code-reviewer:latest .
```

## 目录结构

```
flower-code-reviewer/
├── src/
│   ├── cli.ts             # 入口
│   ├── args.ts            # 参数解析
│   ├── extension.ts       # pi 扩展(注册 provider + telemetry + 合规 + 工具)
│   ├── telemetry-setup.ts # telemetry sink 装配(console/jsonl/http/siem 开关策略)
│   ├── run.ts             # 评审主流程(收尾写 outcome + flush trace)
│   ├── prompts.ts         # prompt 构造
│   └── skill-selector.ts  # 自动选 skill
├── skills/                # 评审清单(可独立修改、独立 PR)
│   ├── general.md
│   ├── backend.md
│   ├── frontend.md
│   └── security.md
├── Dockerfile
├── .gitlab-ci.example.yml
└── README.md
```

## TODO

- `runReview()` 完成后,拉取本次发的评论,根据 `severity=blocker` 设置 exit code
- `skill-selector` 增加更细粒度的策略(按目录、按语言)
- 增加单元测试(prompt 生成、skill 选择)
- 镜像增加多语言代码工具(rg / fd / ast-grep)
