# @flower-ai/pi-tools-arms

阿里云 ARMS / SLS 工具集。**仅供 ops-bot 使用**。

## 工具清单

| 工具 | 描述 | 状态 |
|------|------|:----:|
| `arms_query_logs` | SLS 日志查询(支持 SLS 查询语句) | Stub |
| `arms_query_metrics` | APM 指标(QPS / RT / 错误率 / 慢调用) | Stub |
| `arms_list_alerts` | 列出活跃告警 | Stub |
| `arms_get_trace` | 根据 traceId 查调用链 | Stub |

## 设计原则

1. **全部只读**——绝不暴露写 / 删 / 改 API
2. **结果脱敏**——通过 `maskSensitive()` 在工具结果里就清除手机/身份证/邮箱/IP/密钥
3. **可观测**——所有调用经过 pi-compliance 上报审计

## 用法

```typescript
import { registerArmsTools } from "@flower-ai/pi-tools-arms";

export default function (pi: ExtensionAPI) {
  registerArmsTools(pi);
}
```

## 环境变量

| 变量 | 必填 | 含义 |
|------|:----:|------|
| `ALICLOUD_AK` | ✓ | AccessKey ID |
| `ALICLOUD_SK` | ✓ | AccessKey Secret |
| `ALICLOUD_REGION` | | 默认 cn-hangzhou |

## TODO

- 接入 `@alicloud/sls20201230` 或 SLS HTTP API
- 接入 ARMS OpenAPI(指标、告警、Trace)
- 增加上下文限制(超大结果集要分页 / 截断)
- 增加针对 logstore 的权限白名单
