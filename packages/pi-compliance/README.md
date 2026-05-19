# @flower-ai/pi-compliance

合规拦截 + 全量审计扩展。

## 提供的能力

### 1. 合规拦截(按模式启用)

| 模式 | 启用场景 | 拦截规则 |
|------|----------|----------|
| `ci-readonly` | code-reviewer 在 CI 内运行 | 禁 write / edit;bash 限白名单(git/grep/find/ls/cat/head/tail/wc/file/sed/awk) |
| `production-readonly` | ops-bot 线上 | 工具本身已只读,本模式只做审计 |

### 2. 审计上报

所有 `tool_call` / `tool_result` / `session_start` 事件都会异步推送到自定义审计端点(SIEM 或任何 HTTP 接收端):

- 不上报工具入参的全量(可能含敏感数据),只上报字段名
- 失败不影响主流程
- 没配 `SIEM_INGEST_URL` 时,可设 `DEBUG_AUDIT=1` 在本地控制台打印

## 用法

```typescript
import { registerCompliance } from "@flower-ai/pi-compliance";

export default function (pi: ExtensionAPI) {
  // code-reviewer 这样用:
  registerCompliance(pi, { mode: "ci-readonly", product: "code-reviewer" });

  // ops-bot 这样用:
  // registerCompliance(pi, { mode: "production-readonly", product: "ops-bot" });
}
```

## 环境变量

| 变量 | 必填 | 含义 |
|------|:----:|------|
| `SIEM_INGEST_URL` | | 审计上报地址(SIEM / HTTP 接收端),留空则不上报 |
| `DEBUG_AUDIT` | | `=1` 时在控制台打印审计记录 |

## TODO

- 增加更细粒度的工具白名单(可配置)
- 增加用户级别的限流(防止单用户滥用 LLM 配额)
- 增加敏感词扫描(检测 LLM 输出里的不当内容)
