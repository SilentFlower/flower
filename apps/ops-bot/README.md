# @flower-ai/flower-ops-bot

钉钉运维机器人 HTTP 服务。应用目录为 `apps/ops-bot`，安装后的命令是 `flower-ops-bot`。

机器人接收钉钉消息，根据用户提供的信息与会话历史给出排查建议，并通过钉钉会话回调流式回复。需要额外数据时，机器人会请用户提供已脱敏的日志或指标。

## 工作流程

1. `POST /dingtalk/webhook` 接收消息。配置机器人密钥后，校验请求的 `timestamp` 和 `sign`。
2. HTTP 先应答，后台按 `conversationId` 恢复历史并调用已配置的模型。
3. 通过钉钉的 `sessionWebhook` 推送累积的回复文本，每轮结束后保存会话。配置 `REDIS_URL` 时使用 Redis，未配置时使用进程内存。

## 本地运行

先在仓库根目录执行 `npm ci` 和 `npm run build`。模型配置见仓库的 [环境变量样例](../../.env.example)。

```bash
npm run dev --workspace @flower-ai/flower-ops-bot
curl -fsS http://localhost:3000/healthz
```

默认监听端口为 `3000`，可通过 `PORT` 修改。钉钉回调地址为 `POST /dingtalk/webhook`，签名密钥使用 `DINGTALK_BOT_SECRET`。

## 构建镜像

从仓库根目录运行。

```bash
docker build -f apps/ops-bot/Dockerfile -t flower-ops-bot:local .
```

## 源码入口

| 路径 | 职责 |
| --- | --- |
| `src/server.ts` | HTTP 服务入口和健康检查 |
| `src/dingtalk/` | webhook、签名校验和会话推送 |
| `src/handler.ts` | 模型事件订阅、累积回复与会话保存 |
| `src/agent-factory.ts` | 选择模型、恢复会话并创建 Agent |
| `src/session-store.ts` | Redis 与进程内会话存储 |
| `src/prompts.ts` | 运维助手的系统提示词 |

## 后续规划

进一步的诊断步骤展示、告警响应和定时巡检属于后续设想。历史方案见 [架构手册](../../docs/intro.html)。
