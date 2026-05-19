# Quality Guidelines

> `flower-providers` 的代码质量底线。

---

## Forbidden Patterns

### ❌ 凭证写死

```typescript
// 错误
pi.registerProvider("havefun-anthropic", {
  apiKey: "sk-xxxxx",
  baseUrl: "https://internal.corp.com/v1",
});
```

必须从 `process.env` 读,且 `apiKey` 传**变量名字符串**(`"LLM_API_KEY"`,pi 内部读 env)。

### ❌ 缺凭证时 fallback

```typescript
// 错误
const baseUrl = process.env.LLM_BASE_URL ?? "https://default.example.com/v1";
```

凭证缺失必须 fail-fast,绝不允许"用默认值跑下去"。

### ❌ 打印凭证

```typescript
// 错误
console.log("[providers]", baseUrl, apiKey);
```

`baseUrl` 不算敏感,但 `apiKey` 绝不能进日志。错误信息中也**严禁**回显 `LLM_API_KEY` 任何片段。

### ❌ `console.log` 注册过程

本包是初始化阶段,日志噪音不必要。**只在错误路径打**(throw 已经够了,无需再 console)。

### ❌ 在 `getDefaultModel` 里发起网络请求

```typescript
// 错误:函数应该是纯函数
export function getDefaultModel() {
  return await fetchPreferredModel();  // ❌
}
```

策略类函数必须纯,选错模型由调用方负责(改 `LLM_PROVIDER` / `LLM_MODEL`)。

### ❌ 给 `getDefaultModel` 加业务参数

```typescript
// 错误:把 appSource 当作模型选择输入(已下线的反模式)
export function getDefaultModel(appSource: string) { ... }
```

模型选择是部署单元(每个容器 / 进程)自己的事,通过 env 配置;`appSource` 仅用于审计 header。

---

## Required Patterns

### ✅ fail-fast 环境检查

```typescript
const baseUrl = process.env.LLM_BASE_URL;
if (!baseUrl || baseUrl.trim() === "") {
  throw new Error("LLM_BASE_URL 未配置:请在环境变量中设置 LLM 网关的 baseUrl");
}
```

错误信息必须明确变量名 + 给出修复指引;非法值要列出合法集。

### ✅ `appSource` 通过 header 传

```typescript
headers: { "X-App-Source": options.appSource }
```

LLM 网关 / 审计系统据此区分产品。`appSource` **不**参与模型选择。

### ✅ `BUILTIN_MODELS` 是 readonly 数组

```typescript
export const BUILTIN_MODELS: readonly BuiltinModelEntry[] = [
  { id: "claude-opus-4-7", nativeApi: "anthropic-messages", /* ... */ },
  // ...
];
```

### ✅ `buildHavefunModel` 的 `as unknown as Model<Api>`

```typescript
return result as unknown as Model<Api>;
```

pi-ai 的 `Model<TApi>` 有泛型约束(`compat` 字段),运行时拼装无法精确推导,需要 cast。
**唯一允许的 cast 位置**,不是 `as any`,而是 `as unknown as Model<Api>`(双重 assertion 提示这是有意为之)。

### ✅ 公开 API 必有 JSDoc

`registerHavefunProviders` / `getDefaultModel` / `buildHavefunModel` / `ProviderName` 都必须有**中文 JSDoc**,
内容覆盖:用途、参数、返回值、抛错条件、示例。

---

## Testing Requirements

- `npm run build`(monorepo 根)
- `npm run typecheck`
- `npm run check`(biome)
- `npm run test -w @flower-ai/flower-providers`(vitest)

**单元测试覆盖**:

- `env.test.ts` — fail-fast 矩阵(每个 env 缺失 / 非法场景)
- `catalog.test.ts` — `BUILTIN_MODELS` 数据完整性(8 条 + 每条 `nativeApi` 合法)
- `runtime.test.ts` — `getDefaultModel` 合法/非法组合 + `buildHavefunModel` 字段对照
- `register.test.ts` — 4 次 `registerProvider` 调用 + 模型数 / 协议正确

**手工验证**:

```bash
# 缺 env 应该 fail-fast
unset LLM_BASE_URL LLM_API_KEY LLM_PROVIDER LLM_MODEL
node -e "import('./packages/flower-providers/dist/index.js').then(m => { try { m.getDefaultModel(); } catch(e) { console.log(e.message); } })"
```

确认错误信息明确。

---

## Code Review Checklist

- [ ] 是否存在硬编码凭证
- [ ] 是否对缺失 env fallback
- [ ] `appSource` 是否通过 header 透传 + **不**参与模型选择
- [ ] `buildHavefunModel` 返回值 cast 是否 `as unknown as Model<Api>`(不是 `as any`)
- [ ] `input` 是否 `readonly ("text" | "image")[]`
- [ ] `cost` 是否 0(真实计费应该走计费系统)
- [ ] 是否打印了 apiKey(任何片段都不允许)
- [ ] 新模型 `nativeApi` 是否 ∈ 4 个合法 pi-ai Api 值
- [ ] 新模型 `contextWindow` / `maxTokens` 是否按真实模型能力填
