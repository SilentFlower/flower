# Flower

> AI Agent 套件。基于 [pi-mono](https://github.com/earendil-works/pi-mono) 构建,
> 包含两个产品:**GitLab Code Review Agent** 与 **钉钉运维机器人**。

## 目录

- [项目目标](#项目目标)
- [核心设计原则](#核心设计原则)
- [整体架构](#整体架构)
- [产品 1:GitLab Code Review Agent](#产品-1gitlab-code-review-agent)
- [产品 2:钉钉运维机器人](#产品-2钉钉运维机器人)
- [共享层](#共享层)
- [仓库结构](#仓库结构)
- [开发环境](#开发环境)
- [必须提前想清楚的几个问题](#必须提前想清楚的几个问题)
- [实施路线图](#实施路线图)

---

## 项目目标

本项目实现两个不同形态的 AI Agent:

### Agent 1:嵌入 GitLab Pipeline 的代码评审

- 由 CI/CD 触发,每次 MR / commit 自动跑
- 拉取项目代码,分析本次提交的变更
- 按可配置的编码规范(skill 文件)给出评审意见
- 把意见以行内 / 整体评论的形式发回 MR

### Agent 2:嵌入钉钉的运维助手

- 用户在钉钉群 @机器人发消息
- 实时调用阿里云 ARMS / SLS 查日志、看监控、查告警
- 多轮对话,记住上下文
- 流式回复给用户

---

## 核心设计原则

### 1. 同根不同枝

两个产品**共享 70% 的底层能力**(LLM provider、工具、合规、审计),
但**生命周期、入口、会话模型完全不同**,所以独立部署、独立进程。

| 维度 | code-reviewer | ops-bot |
|------|---------------|---------|
| 生命周期 | 一次性(几分钟) | 长驻服务(7×24) |
| 触发方式 | CI pipeline 事件 | webhook(钉钉消息) |
| 会话模型 | 无状态 | 有状态(按会话隔离) |
| 并发 | 单实例 | 多用户并发 |
| 输出渠道 | GitLab MR 评论 | 钉钉流式回复 |
| 环境 | 容器内、临时 | 长驻服务器 / K8s |

### 2. pi-mono 提供洋葱核心

```
┌────────────────────────────────────────────────────────────┐
│  Flower (本仓库)                                            │
│  ┌──────────────────────────┐  ┌────────────────────────┐  │
│  │ code-reviewer            │  │ ops-bot                │  │
│  │   套 pi-coding-agent     │  │   直接用 pi-agent-core │  │
│  └────────────┬─────────────┘  └────────────┬───────────┘  │
│               │                              │              │
│               └──────────┬───────────────────┘              │
│                          ▼                                  │
│           共享层(provider、tools、compliance)             │
└──────────────────────────┬─────────────────────────────────┘
                           │ 依赖 npm 包
                           ▼
        @earendil-works/pi-coding-agent  (上游)
        @earendil-works/pi-agent-core    (上游)
        @earendil-works/pi-ai            (上游)
```

### 3. 配置驱动,不 fork 上游

- LLM 接入通过 `pi.registerProvider()` 完成,**不改 pi 源码**
- 工具通过 `pi.registerTool()` 添加
- 行为通过事件订阅(`pi.on()`)修改
- 必要时用 npm `overrides` 做"热插拔",fork 单个包重定向

---

## 整体架构

### 数据流(code-reviewer)

```
GitLab CI Pipeline
       │ (.gitlab-ci.yml 中 review job)
       ▼
docker run yourcompany/code-reviewer:latest --mr-iid $CI_MERGE_REQUEST_IID
       │
       ▼
[code-reviewer 容器内]
  1. clone 项目 / 切到目标 commit
  2. 启动 pi -p "..."(print 模式)
  3. pi 自带工具读代码(read / grep / find)
  4. 调用 gitlab_post_comment 工具发评论
  5. 进程退出,job 完成
       │
       ▼
GitLab MR 上出现评论
```

### 数据流(ops-bot)

```
钉钉群(@机器人)
       │ webhook
       ▼
[ops-bot HTTP server]
  receive { conversationId, userId, text }
       │
       ▼
SessionStore.getOrCreate(conversationId)  ← Redis
       │
       ▼
Agent.prompt(text)        ← pi-agent-core Agent 实例
       │
       │ stream events
       ▼
通过钉钉流式回复 API 推送回去
       ▲
       │ 工具调用
       │
       ├──► arms_query_logs
       ├──► arms_query_metrics
       ├──► arms_list_alerts
       └──► arms_get_trace
```

---

## 产品 1:GitLab Code Review Agent

### 为什么选 pi-coding-agent

它已经具备:
- `read` / `grep` / `find` / `bash` 工具——LLM 想看哪个文件直接看
- `print` 模式(`pi -p "..."`)——天生匹配 CI/CD 的 run-and-exit 形态
- skill 系统(`/skill:code-review-checklist`)——评审清单可以做成可复用资产
- 完整的合规拦截(可以禁用 write/edit,限制 bash 白名单)

### 关键设计点

#### a. 只读模式

CI 里的 agent **不能改代码**。在 `pi-compliance` 里注册全局拦截器:

```typescript
pi.on("tool_call", async (event) => {
  if (event.toolName === "write" || event.toolName === "edit") {
    return { block: true, reason: "CI mode: read-only" };
  }
  if (event.toolName === "bash") {
    const cmd = event.input.command;
    if (!/^(git|grep|find|ls|cat|head|tail|wc|file)\b/.test(cmd.trim())) {
      return { block: true, reason: `CI mode: ${cmd.split(' ')[0]} not allowed` };
    }
  }
});
```

#### b. Skill 文件存评审标准

```
packages/code-reviewer/skills/
├── general-review.md       # 通用清单
├── backend-review.md       # 后端(并发、数据库、安全)
├── frontend-review.md      # 前端(性能、可访问性)
└── security-review.md      # 安全专项
```

入口脚本根据变更文件类型自动选 skill。

#### c. GitLab 工具集

- `gitlab_get_mr_diff` — 拿本次 MR 的 diff
- `gitlab_get_mr_files` — 拿被修改的文件列表
- `gitlab_post_comment` — 发整体评论
- `gitlab_post_line_comment` — 发行内评论(支持 severity)
- `gitlab_get_previous_review` — 避免重复评论

#### d. 输出策略

不要让 LLM 在 stdout 写"评审报告"——CI 日志没人看。
**Prompt 强制要求**:所有意见必须通过 `gitlab_post_comment` 工具发表。

#### e. Pipeline 失败策略

最后扫描所有评论,如果有 `severity === "blocker"` 的,exit code 设 1,让 pipeline fail。
其他情况 exit code 0,只是警告。

---

## 产品 2:钉钉运维机器人

### 为什么不用 pi-coding-agent

`pi-coding-agent` 假设:
- 一个用户、一个进程、一个 TTY
- 会话存 jsonl 文件
- 默认工具是 bash / read / edit

钉钉 bot 需要:
- 一个进程服务多用户、多群
- 会话存 Redis,支持横向扩展
- 工具只有 ARMS 查询,没有文件操作

所以**直接用 `pi-agent-core` 的 `Agent` 类**自己做 HTTP server + 会话管理。

### 关键设计点

#### a. 会话隔离 + Redis 持久化

每个钉钉 conversationId 对应一个独立的 Agent 实例,messages 持久化到 Redis(24h 过期)。

#### b. 流式回复钉钉

钉钉同步 webhook 有 5 秒超时,运维查询常常 > 5 秒。
**必须用钉钉的"流式 stream API"**(企业内部应用 sessionWebhook 机制)。

```typescript
agent.on("message_update", (event) => {
  accumulator += event.delta.text ?? "";
  throttle(() => pushToDingTalk(sessionWebhook, accumulator));  // 500ms 节流
});
```

#### c. ARMS 工具集

- `arms_query_logs` — SLS 日志查询(支持 SLS 查询语句)
- `arms_query_metrics` — APM 指标(QPS / RT / 错误率 / 慢调用)
- `arms_list_alerts` — 列出活跃告警
- `arms_get_trace` — 查 traceId 的调用链
- `arms_get_topology` — 服务拓扑

#### d. 权限边界

钉钉 bot 面向**全员**,必须按 DingTalk userId 鉴权:

```typescript
pi.on("tool_call", async (event, ctx) => {
  const user = await getUser(event.context.conversationId);
  if (event.toolName.startsWith("arms_") && !user.canQueryArms) {
    return { block: true, reason: "您没有 ARMS 查询权限" };
  }
});
```

#### e. 数据脱敏

ARMS 日志里可能有 PII(手机、身份证、邮箱)。**在工具结果里就脱敏**,
不要让 LLM 看到原始敏感数据(它可能复述到回复里)。

---

## 共享层

### packages/pi-providers

自定义 LLM 入口。两个产品都通过这里把 LLM provider(自部署网关 / 企业 AI Gateway / 任意 OpenAI 兼容服务)接入。

```typescript
pi.registerProvider("company", {
  baseUrl: "https://ai-gateway.corp.internal/v1",
  apiKey: "COMPANY_AI_TOKEN",
  api: "openai-completions",
  models: [/* 允许使用的模型清单 */],
  headers: { "X-App-Source": process.env.APP_NAME },
});
```

### packages/pi-tools-common

跨产品通用的工具:Jira、Wiki、内部文档检索等。

### packages/pi-tools-arms

阿里云 ARMS / SLS 工具集。**仅 ops-bot 使用**(code-reviewer 不该看监控)。

### packages/pi-tools-gitlab

GitLab API 工具集。**仅 code-reviewer 使用**。
> 注:ops-bot 不应该有写 GitLab 的能力,职责隔离。

### packages/pi-compliance

审计 + 合规扩展。两个产品都加载,但开启不同模式:

- code-reviewer:`mode: "ci-readonly"`
- ops-bot:`mode: "production-readonly"`

---

## 仓库结构

```
flower/
├── README.md                            # 你正在看的文件
├── package.json                         # npm workspaces 根
├── tsconfig.base.json                   # 共用 TS 配置
├── tsconfig.json                        # project references 入口
├── biome.json                           # 代码风格
├── .env.example                         # 环境变量模板
│
└── packages/
    ├── pi-providers/                    # 共享:LLM provider 注册
    ├── pi-tools-common/                 # 共享:通用工具
    ├── pi-tools-arms/                   # 共享:ARMS 工具(给 ops-bot)
    ├── pi-tools-gitlab/                 # 共享:GitLab 工具(给 code-reviewer)
    ├── pi-compliance/                   # 共享:合规 + 审计扩展
    │
    ├── code-reviewer/                   # 产品 1
    │   ├── src/
    │   │   ├── cli.ts                   # 入口
    │   │   ├── extension.ts             # pi 扩展(注册工具/合规)
    │   │   ├── triggers/                # CI 触发逻辑
    │   │   └── prompts/                 # 评审 prompt
    │   ├── skills/                      # 评审清单(skill 文件)
    │   └── Dockerfile                   # 容器构建
    │
    └── ops-bot/                         # 产品 2
        ├── src/
        │   ├── server.ts                # HTTP 入口
        │   ├── dingtalk/                # 钉钉 webhook / 签名 / 推送
        │   ├── agent-factory.ts         # Agent 实例构造
        │   ├── session-store.ts         # Redis 会话存储
        │   └── auth.ts                  # 钉钉用户 → 权限
        └── Dockerfile
```

---

## 开发环境

### 前置

- Node.js ≥ 22
- npm ≥ 10
- (开发 ops-bot) 本地 Redis

### 启动

```bash
# 1. 安装依赖
npm install

# 2. 准备环境变量
cp .env.example .env
# 然后编辑 .env 填上 LLM token、GitLab token 等

# 3. 类型检查
npm run typecheck

# 4. 构建所有包
npm run build

# 5. 代码风格检查
npm run check
```

### 开发某个具体产品

```bash
# code-reviewer 本地试跑
cd packages/code-reviewer
npm run dev -- --mr-iid 123

# ops-bot 本地起服务
cd packages/ops-bot
npm run dev
# 访问 http://localhost:3000/dingtalk/webhook
```

---

## 必须提前想清楚的几个问题

| 问题 | 当前思路 |
|------|----------|
| **谁付钱?** | LLM 调用花钱。code-reviewer 每个 MR 一次,可控;ops-bot 全员用,**必须做配额** |
| **谁负责?** | bot 给出错误的运维建议导致事故,谁担责?**关键操作必须"建议但不执行"**,所有 ARMS 工具都是读 |
| **数据合规?** | 日志 / 代码可能涉密。**LLM 调用建议走自部署 / 私有网关,而不是公网 LLM API** |
| **可观测?** | 两个产品自己也要被监控:每天处理多少 MR / 回答多少问题 / 错误率 / 延迟 |
| **回退方案?** | LLM 挂了 / 超时 / 限流时:code-reviewer pipeline 继续(警告但不 fail);ops-bot 友好降级("AI 不可用,请直接查 ARMS 控制台") |

---

## 实施路线图

### 第 1 周:基础设施(本仓库当前阶段)
- [x] 搭 monorepo 骨架
- [ ] `pi-providers` 接通目标 LLM 网关
- [ ] `pi-compliance` 接通审计

### 第 2 周:`code-reviewer` MVP
- [ ] GitLab 工具集(get_diff / post_comment)
- [ ] 1 个 skill(general-review)
- [ ] 测试项目 CI 接入,**手动**触发跑通

### 第 3 周:`code-reviewer` 上生产
- [ ] MR 自动触发
- [ ] 添加 backend / frontend / security skill
- [ ] 评审质量回归(挑 20 个历史 MR 对比)

### 第 4-5 周:`ops-bot` MVP
- [ ] 钉钉 webhook 接入(测试群)
- [ ] ARMS 日志 / 指标工具
- [ ] Redis 会话存储
- [ ] 流式回复

### 第 6-7 周:`ops-bot` 安全 + 上线
- [ ] 鉴权边界
- [ ] 数据脱敏
- [ ] 配额控制
- [ ] 灰度到一个业务团队

### 后续:`ops-bot` 进阶能力(未排期)

> 这些能力当前版本**暂不实现**,作为后续演进方向。详细方案见
> [packages/ops-bot/README.md](packages/ops-bot/README.md#未来规划进阶能力)。

- [ ] **Plan-then-Execute**:复杂任务先列计划再执行(改 prompt 即可,P0)
- [ ] **Diagnostic Sub-Agent**:复杂诊断派给专项子 agent,小模型搞不定时升级到大模型
- [ ] **告警驱动主动触发**:ARMS 告警自动启动诊断,主动推送结论
- [ ] **定时巡检(cron)**:每天自动巡检关键应用
- [ ] **用户订阅 Watcher**:"盯住某指标超阈值就通知"
- [ ] **持久化执行计划**:长任务中断可恢复

> 说明:**当前 ops-bot 已经具备"自规划"能力** —— 一次用户消息内,LLM 可以
> 自主调用任意多个工具,基于结果迭代决策直到给出最终答案。这是 pi-agent-core
> agentLoop 的内建行为。上述进阶能力是在这个底座之上的扩展。

---

## License

[MIT](./LICENSE) © silentflower
