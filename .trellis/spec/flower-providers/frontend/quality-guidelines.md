# Quality Guidelines

> `flower-providers` 的代码质量底线。

---

## Forbidden Patterns

### ❌ 凭证写死

```typescript
// 错误
pi.registerProvider("company", {
  apiKey: "sk-xxxxx",
  baseUrl: "https://internal.corp.com/v1",
});
```

必须从 `process.env` 读,且 `apiKey` 传**变量名字符串**(pi 内部读 env)。

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

`baseUrl` 不算敏感,但 `apiKey` 绝不能进日志。

### ❌ `console.log` 注册过程

本包是初始化阶段,日志噪音不必要。**只在错误路径打**(throw 已经够了,无需再 console)。

### ❌ 在 `getDefaultModelId` 里发起网络请求

```typescript
// 错误:函数应该是纯函数
export function getDefaultModelId(appSource: string): string {
  return await fetchPreferredModel(appSource);  // ❌
}
```

策略类函数必须纯,选错模型由调用方负责。

---

## Required Patterns

### ✅ fail-fast 环境检查

```typescript
const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
if (!baseUrl) throw new Error("LLM_BASE_URL 环境变量未配置");
if (!apiKey) throw new Error("LLM_API_KEY 环境变量未配置");
```

错误信息必须明确变量名。

### ✅ `appSource` 通过 header 传

```typescript
headers: { "X-App-Source": options.appSource }
```

LLM 网关 / 审计系统据此区分产品。

### ✅ `CUSTOM_MODELS` 使用 `as const` + `as any`

```typescript
{
  input: ["text", "image"] as const,
  ...
}
const models = CUSTOM_MODELS as any;  // pi Model 类型严格,自定义 model 需要 cast
```

每处 `as any` 必须有 `biome-ignore` 注释说明原因(参考 `src/index.ts:63`)。

### ✅ 公开 API 必有 JSDoc

`registerCompanyProviders` / `getDefaultModelId` / `CUSTOM_MODELS` 都必须有中文 JSDoc。

---

## Testing Requirements

- `npm run typecheck`
- `npm run check`
- `npm run build`

**手工验证**:

```bash
# 缺 env 应该 fail-fast
node -e "require('./packages/flower-providers/dist/index.js')...try { fn(); } catch(e) { console.log(e.message); }"
```

确认错误信息明确。

---

## Code Review Checklist

- [ ] 是否存在硬编码凭证
- [ ] 是否对缺失 env fallback
- [ ] `appSource` 是否通过 header 透传
- [ ] `models` 是否 `as any`(且带 biome-ignore)
- [ ] `input` 是否 `as const`
- [ ] `cost` 是否 0(真实计费应该走网关)
- [ ] 是否打印了 apiKey
- [ ] 新模型 `contextWindow` / `maxTokens` 是否按真实模型能力填
