# Hook Guidelines

> pi 扩展工厂、`pi.on()` 事件订阅、`pi.registerTool()` 的使用约定。

---

## Overview

本项目无 React hook。本目录里的"hook"指 **pi 框架提供的扩展点**:

| 通用 hook 概念 | 本项目对应 |
|------|------|
| 自定义 hook 函数 | pi 扩展工厂(`export default function(pi: ExtensionAPI)`) |
| 数据获取 hook | `pi.registerTool()` 注册的工具(`execute` 函数即"获取数据") |
| 副作用 hook | `pi.on("tool_call" / "tool_result" / "session_start", handler)` |
| Hook 命名规范 | 扩展工厂用 `register<Domain>(pi, options)` 形式 |

---

## Custom Hook Patterns

### pi 扩展工厂(等价于"自定义 hook")

```typescript
// ✅ 标准签名
export function registerHavefunProviders(
  pi: ExtensionAPI,
  options: { appSource: string },
): void {
  pi.registerProvider("havefun-anthropic", { ... });
  // ... 一次性注册 4 个 havefun-* provider
}
```

要点:

1. **首参一律是 `pi: ExtensionAPI`**,与 pi 上游约定一致
2. **options 用对象**而非位置参数,便于扩展
3. **同步注册**:在 factory 里不要 `await`(注册行为本身是同步的;真要 async,放到 `pi.on` 回调里)
4. **校验环境**:factory 内可以读 `process.env`,缺关键变量直接 `throw new Error("XXX 未配置")`,在 pi 启动前就 fail-fast

参考实现:`packages/flower-providers/src/register.ts:registerHavefunProviders`(检查 `LLM_BASE_URL` / `LLM_API_KEY`,缺就抛错;一次性注册 4 个 provider)

### 顶层扩展(等价于"组合根 hook")

`code-reviewer/src/extension.ts` 把多个 factory 串起来:

```typescript
export default function (pi: ExtensionAPI): void {
  registerHavefunProviders(pi, { appSource: "code-reviewer" });
  registerTelemetry(pi, { product: "code-reviewer", sinks: buildTelemetrySinks() });
  registerCompliance(pi, { mode: "ci-readonly", product: "code-reviewer", onBlock: /* 接 telemetry */ });
  registerCommonTools(pi);
  registerGitlabTools(pi);
}
```

**调用顺序是契约,不可换**:

| 顺序 | 注册者 | 理由 |
|------|--------|------|
| 1 | provider | 没 provider,后面所有 LLM 调用都找不到模型 |
| 2 | telemetry | 观测监听必须先于 compliance:pi 按注册顺序短路,先注册才能看到被拦截的调用意图 |
| 3 | compliance | 是后续工具调用的"门禁",必须早于业务工具;onBlock 回调接 telemetry(2026-06-10) |
| 4 | tools(common / gitlab) | 业务工具,任意顺序 |

---

## Data Fetching

### 工具(`pi.registerTool`)= "数据获取 hook"

```typescript
export const gitlabGetMrDiffTool = defineTool({
  name: "gitlab_get_mr_diff",
  label: "获取 MR diff",
  description: "拿到当前 MR 的完整变更 diff(unified format)",
  parameters: Type.Object({}),
  async execute(_id) {
    const { projectId, mrIid } = readEnv();
    const diff = await gitlabClient().getMrDiff(projectId, mrIid);
    return {
      content: [{ type: "text", text: diff }],
      details: { projectId, mrIid },
    };
  },
});
```

### 约定

1. **`name` 全局唯一**,用 `<domain>_<verb>_<noun>` 蛇形(`gitlab_post_comment`、`arms_query_logs`)
2. **`label` 是给 LLM 的可读名**,可以是中文(`"获取 MR diff"`)
3. **`description` 是给 LLM 的工具说明**,直接影响 LLM 调用决策,要写清"用来做什么 / 何时用 / 入参含义"
4. **`parameters` 用 `@earendil-works/pi-ai` 的 `Type.Object`**,不要自己写 JSON schema
5. **返回值固定形状**:`{ content: [{ type: "text", text: string }], details?: object }`
6. **副作用 = 调外部 API**:实际 HTTP 调用放在 `client.ts` 等独立模块里,工具的 `execute` 只做参数解包 + 调 client + 包装返回值

---

## Naming Conventions

| 对象 | 命名规则 | 例子 |
|------|----------|------|
| 注册函数 | `register<Domain>Tools` 或 `register<Domain>(pi, options)` | `registerGitlabTools` / `registerCompliance` |
| 工具变量(命名导出) | `<domain><Action>Tool` (camelCase) | `gitlabPostCommentTool` / `armsQueryLogsTool` |
| 工具 `name` 字段 | `<domain>_<action>` (snake_case) | `gitlab_post_comment` / `arms_query_logs` |
| 事件订阅 handler | 匿名 lambda 或私有 `function on<Event>(...)` | `pi.on("tool_call", async (event) => { ... })` |

---

## 事件订阅(`pi.on`)

```typescript
pi.on("tool_call", async (event) => {
  if (event.toolName === "write" || event.toolName === "edit") {
    return { block: true, reason: "CI 只读模式:禁止使用 write / edit 工具" };
  }
  return undefined;
});
```

约定:

1. **不修改 event 内部状态**,要拦截就 `return { block: true, reason }`,要放行就 `return undefined`
2. **handler 必须 async**,即使内部全是同步代码(API 契约)
3. **审计类 handler 用 `void sendAudit(...)`**(fire-and-forget,不要 `await` 阻塞主流程)
4. **不要在 handler 内抛错**(会污染主调用栈);失败就 `console.warn` 后继续

参考实现:`packages/flower-compliance/src/index.ts:54-72`(`registerCiReadOnlyGuards` 拦截 write / edit / bash)

---

## Common Mistakes

- ❌ 在 factory 里 `await` 异步初始化(例如 `await fetchModelList()`)—— factory 是同步契约,要异步初始化放到 `pi.on("session_start", ...)` 里
- ❌ 同一个事件注册多个相互矛盾的 handler(例如两处都给 `tool_call` 注册拦截规则,顺序又不确定);**所有合规拦截集中在 `@flower-ai/flower-compliance`**
- ❌ 工具 `description` 写"用来调 GitLab API"(LLM 看不懂"调",改成"获取 MR 的变更内容,用于评审")
- ❌ 工具 `parameters` 用 `Type.Any()`(LLM 不知道传什么);必须显式列字段
- ❌ 在 `execute` 里直接 `console.log` 大块数据(CI 日志会爆);只把简短结果放 `details`,详情走返回 `content`
