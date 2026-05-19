# @flower-ai/flower-ops-bot

钉钉运维机器人 HTTP 服务。

## 工作流程

```
钉钉群 @机器人
   │ HTTP POST
   ▼
POST /dingtalk/webhook
   │
   ├─ 校验 timestamp + sign(防伪)
   ├─ 立即返回 200(避免 5s 超时)
   │
   └─ queueMicrotask 后台处理:
        │
        ├─ getOrCreateAgent(conversationId)
        │    ├─ 从 Redis 拉历史 messages
        │    └─ new Agent({ tools: ARMS + 通用, model, systemPrompt })
        │
        ├─ agent.prompt(text)
        │    └─ 流式输出 → 累积 → 节流 500ms → 推回钉钉 sessionWebhook
        │
        └─ 保存最新 messages 回 Redis
```

## 关于"自规划"能力

**ops-bot 不是简单的一问一答。** `agent.prompt(text)` 内部跑的是 pi-agent-core 的
完整 agent loop:**一次用户消息 → LLM 自主调用任意多个工具 → 基于结果继续决策 → 直到给出最终答案**。

例如用户问"prod-app 为什么慢",一次 prompt 内 LLM 可能会自主完成:

1. `arms_query_metrics`  看 RT 趋势
2. `arms_list_alerts`    看活跃告警
3. `arms_query_logs`     查具体错误日志
4. `arms_get_trace`      看慢调用链路
5. 综合分析后回复结论

全程不需要用户介入,**这就是内建的 agent 自规划能力**。
关键是工具足够细粒度,以及 system prompt 鼓励 LLM"先调查再下结论"。

## 接口

| 方法 | 路径 | 描述 |
|------|------|------|
| GET  | `/healthz`           | 健康检查 |
| POST | `/dingtalk/webhook`  | 钉钉消息回调 |

## 用法

### 本地起服务

```bash
export PORT=3000
export REDIS_URL=redis://localhost:6379
export DINGTALK_BOT_SECRET=xxx
export LLM_BASE_URL=...
export LLM_API_KEY=...
export ALICLOUD_AK=...
export ALICLOUD_SK=...

cd packages/flower-ops-bot
npm run dev
```

### 本地测试 webhook(模拟钉钉)

```bash
# 不带签名(开发模式,DINGTALK_BOT_SECRET 留空)
curl -X POST http://localhost:3000/dingtalk/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "test-conv-001",
    "senderStaffId": "user-001",
    "senderNick": "测试用户",
    "text": { "content": "查一下 prod-app 最近 1 小时的错误日志" },
    "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
    "timestamp": 1700000000000
  }'
```

### 构建镜像

```bash
# 在 flower 根目录
docker build -f packages/flower-ops-bot/Dockerfile -t yourcompany/flower-ops-bot:latest .
```

## 目录结构

```
flower-ops-bot/
├── src/
│   ├── server.ts             # HTTP 入口
│   ├── handler.ts            # 消息处理主流程
│   ├── agent-factory.ts      # Agent 实例构造
│   ├── tools.ts              # 工具装配
│   ├── prompts.ts            # 系统提示词
│   ├── session-store.ts      # Redis 会话存储
│   └── dingtalk/
│       ├── webhook.ts        # webhook 处理
│       ├── signature.ts      # 签名校验
│       └── push.ts           # 流式推送回钉钉
├── Dockerfile
└── README.md
```

## 未来规划:进阶能力

以下能力**当前版本暂不实现**,作为后续演进方向记录。每一项的复杂度、收益、依赖见下表。

### 能力 1:Plan-then-Execute 模式

让 LLM 在面对复杂诊断任务时,**先显式列出计划再执行**,边做边把 checklist 打勾。

- **价值**:过程可观测,用户能看清 bot 在干什么;避免 LLM 漏步骤
- **实现成本**:低(改 `prompts.ts` 中的 system prompt,加上"先 plan 后 do"的工作方法约束)
- **触发方式**:对"诊断 / 根因分析 / 容量评估"类问题启用;简单查询不需要

预期效果示例:

```
用户: prod-app 现在为什么慢?

Bot: 我打算按这个顺序查:
- [ ] 1. 看最近 30 分钟的 RT / 错误率指标
- [ ] 2. 看是否有活跃告警
- [ ] 3. 查慢调用日志,定位慢点
- [ ] 4. 拉典型 traceId 看链路

[逐项执行,完成后改 [✓]]

Bot: 根因是 ...
```

### 能力 2:Diagnostic Sub-Agent(子 agent 派发)

对复杂任务,主 agent 派发到**专门的子 agent**,子 agent 用更大的模型 + 更长的思考预算
+ 专项 system prompt。

- **价值**:成本与质量平衡(简单查询走 mini 模型,复杂诊断走大模型);上下文隔离避免污染主对话
- **实现成本**:中(新增 `dispatch_diagnostic_agent` 工具,内部 `new Agent({...})` 跑子任务)
- **参考**:pi-mono 仓库的 `examples/extensions/subagent` 扩展示例

子 agent 类型示例:
- `diagnostic-agent`     —— 故障根因分析
- `capacity-agent`       —— 容量评估
- `cost-agent`           —— 资源成本分析

### 能力 3:主动触发(告警驱动)

监听 ARMS / 内部告警 webhook,**告警发生时自动启动诊断**,把结论推送到对应钉钉群。

- **价值**:从"被动问答" → "主动 SRE 助手",真正减少人工介入
- **实现成本**:中(新增 `src/triggers/alert-webhook.ts`,告警转换为 agent 输入)
- **依赖**:ARMS 告警支持配置 webhook 回调地址;需要从告警载荷里取出目标群 ID

架构变化:

```
现有:钉钉消息 → /dingtalk/webhook → agent
新增:ARMS 告警 → /triggers/alert    → agent → 钉钉主动推送
```

### 能力 4:定时巡检(cron)

定期让 agent **自主巡检关键应用**,生成日报或健康度报告。

- **价值**:把"人工每天看一眼监控"自动化
- **实现成本**:低(用 node-cron 触发,跑一次 agent 即可)
- **运维注意**:每次巡检都是一次 LLM 调用,要控制频率与配额

### 能力 5:用户订阅式 Watcher

用户说"盯住 prod-app,RT 超过 200ms 告诉我",bot **后台持续监控**,触发条件后主动通知。

- **价值**:把临时关注从用户脑子里移到 bot
- **实现成本**:高(需要持久化订阅、独立调度循环、去重、过期管理)
- **建议**:等前 4 项稳定后再考虑

### 能力 6:持久化执行计划(可恢复任务)

长任务(如"全链路压测后给出报告")**中途崩了能从断点恢复**,而不是从头跑。

- **价值**:长任务可靠性
- **实现成本**:高(需要把 plan 存到 Redis / DB,worker 启动时检查未完成任务)
- **建议**:有真实长任务需求后再做,否则是过度设计

### 演进优先级

| 优先级 | 能力 | 实施成本 | 何时做 |
|:-----:|------|:--------:|--------|
| P0 | Plan-then-Execute | 低 | 第一版上线观察 1-2 周后立即加 |
| P1 | Diagnostic Sub-Agent | 中 | 用户开始问复杂问题、单次 LLM 调用质量不够时 |
| P2 | 告警驱动主动触发 | 中 | 业务方提出"告警了自动分析"的需求时 |
| P3 | 定时巡检 | 低 | 跟告警驱动一起做(共用基础设施) |
| P4 | 用户订阅 Watcher | 高 | 有真实需求且前序能力稳定后 |
| P5 | 持久化执行计划 | 高 | 有真实长任务需求时 |

## TODO(当前版本)

- `handler.ts` 中事件流的字段解析需要根据 pi-agent-core 实际 API 对齐
- `tools.ts` 的工具转换层需要根据 pi-agent-core 的 AgentTool 类型校准
- 增加用户级 LLM 配额(防止滥用)
- 增加敏感词扫描(LLM 输出)
- 增加灰度名单(只有特定用户能用)
- 接入 IAM / 权限系统,根据用户 staffId 查权限组
