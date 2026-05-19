# Directory Structure

> `@flower-ai/flower-tools-arms` 的目录布局。

---

## Directory Layout

```
packages/flower-tools-arms/
├── src/
│   ├── index.ts      # 4 个工具定义 + registerArmsTools + 类型 / 工具 export
│   └── mask.ts       # maskSensitive(text) 脱敏函数 + RULES 常量
├── dist/
├── package.json
└── tsconfig.json
```

---

## Module Organization

### `src/index.ts`

包含:

| 元素 | 说明 |
|------|------|
| `armsQueryLogsTool` | SLS 日志查询工具 |
| `armsQueryMetricsTool` | APM 指标查询工具 |
| `armsListAlertsTool` | 活跃告警列表工具 |
| `armsGetTraceTool` | 调用链查询工具 |
| `registerArmsTools(pi)` | 一次性注册全部工具 |
| `maskSensitive` | 从 `./mask.js` re-export |

### `src/mask.ts`

包含:

- `RULES`(module-level const):正则 + 替换字符串数组
- `maskSensitive(text)`:遍历 RULES 做替换

---

## 何时拆分

当工具数量超过 ~6 个,或单个工具内部逻辑超过 ~50 行,拆为:

```
src/
├── index.ts              # 统一 export + registerArmsTools
├── tools/
│   ├── query-logs.ts
│   ├── query-metrics.ts
│   ├── list-alerts.ts
│   └── get-trace.ts
├── client.ts             # SLS / ARMS SDK 封装
└── mask.ts               # 脱敏
```

当前规模不需要,**不要过早拆分**。

---

## Naming Conventions

- 工具变量:`<domain><Action>Tool`(`armsQueryLogsTool`)
- 工具 `name` 字段:`<domain>_<action>` snake_case(`arms_query_logs`)
- 工具 `label` 字段:中文可读名(`"ARMS 日志查询"`)
- 注册函数:`register<Domain>Tools`(`registerArmsTools`)
- 文件名:小写 kebab-case
- 环境变量:`ALICLOUD_AK` / `ALICLOUD_SK` / `SLS_REGION` 等(待真实接入时确定)

---

## Examples

- 完整 ToolDefinition 模板:`src/index.ts:23-52`(`armsQueryLogsTool`)
- 集中注册:`src/index.ts:141-147`
- 脱敏规则表驱动:`src/mask.ts:11-18`
