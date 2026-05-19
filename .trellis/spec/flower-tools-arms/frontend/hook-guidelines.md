# Hook Guidelines

> `pi.registerTool` 装配点。

---

## Overview

本包向 pi 注册工具的**唯一入口**:

```typescript
export function registerArmsTools(pi: { registerTool: (def: any) => void }): void {
  pi.registerTool(armsQueryLogsTool);
  pi.registerTool(armsQueryMetricsTool);
  pi.registerTool(armsListAlertsTool);
  pi.registerTool(armsGetTraceTool);
}
```

要点:

1. **集中注册**:不要让 caller 一个个调 `pi.registerTool(armsQueryLogsTool)`,**只暴露集中入口**
2. **顺序无关**:工具之间互不依赖
3. **参数类型** `pi: { registerTool: (def: any) => void }` 是简化(避免引 pi 的 ExtensionAPI 严格类型);带 `biome-ignore` 注释

---

## Custom Hook Patterns

### `defineTool` 是组件,不是 hook

本包工具用 `defineTool({...})` 直接定义为 module-level `const`,**不是**通过工厂函数生成的。

这样:

- 工具是**静态**的,可被 `import` 直接读
- LLM 工具清单稳定,LLM 行为可预测
- 注册顺序无副作用

### 工具单独导出 + 集中注册

```typescript
// index.ts 顶部:每个工具单独 export
export const armsQueryLogsTool = defineTool({ ... });

// index.ts 底部:统一注册函数
export function registerArmsTools(pi): void {
  pi.registerTool(armsQueryLogsTool);
  ...
}
```

这样 caller 可以:

- 只用 `registerArmsTools(pi)` 装全部(推荐)
- 或者只 import 个别工具到 `flower-ops-bot/src/tools.ts` 做 toAgentTool 转换(当前 ops-bot 用此模式)

---

## Data Fetching

工具 `execute` 内**调真实 SDK** 获取数据。

约定:

1. **客户端单例**:真实接入 SDK 时,在 module-level 用惰性单例(`getSlsClient()` / `getArmsClient()`),不要每次 `new`
2. **凭证从 env 读**:`process.env.ALICLOUD_AK` / `ALICLOUD_SK` / `ALICLOUD_REGION`(具体看 SDK 文档)
3. **必须脱敏**:`return { content: [{ type: "text", text: maskSensitive(rawResult) }] }`
4. **必须传 `signal`**:`await client.getLogs({ ..., signal })`,允许 pi 框架取消

---

## Naming Conventions

- 工具变量:`<domain><Action>Tool`,camelCase(`armsQueryLogsTool`)
- 工具 `name` 字段:`<domain>_<action>` snake_case(`arms_query_logs`)
- `<action>` 只允许 read-only 动词:`query` / `list` / `get` / `search` / `describe`
- **禁止** write-y 动词:`create` / `update` / `delete` / `mute` / `silence`

---

## Common Mistakes

- ❌ 在 `execute` 内创建 SDK client(每次工具调用都新建连接)
- ❌ 用 `Promise.all` 并行查多个 logstore(LLM 调一次工具就查一处,要查多处 LLM 会自己再调一次)
- ❌ 在 `execute` 内 fetch 不传 `signal`(无法取消,LLM 决定中止时进程会等)
- ❌ 工具新增写操作(`arms_mute_alert`)— 违反"只读"约束,只读=不可改 ARMS 状态
- ❌ 工具名 / 描述出现"创建" / "修改" / "执行"等动词(LLM 会以为可以改东西)
