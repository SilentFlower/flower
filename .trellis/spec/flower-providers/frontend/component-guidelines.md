# Component Guidelines

> 公开函数签名与配置规范。

---

## Component Structure

### `registerCompanyProviders`

```typescript
export function registerCompanyProviders(
  pi: ExtensionAPI,
  options: { appSource: string },
): void {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;

  if (!baseUrl) throw new Error("LLM_BASE_URL 环境变量未配置");
  if (!apiKey) throw new Error("LLM_API_KEY 环境变量未配置");

  pi.registerProvider("company", {
    baseUrl,
    apiKey: "LLM_API_KEY",      // 注意:pi 这里期望"环境变量名",不是 apiKey 值本身
    api: "openai-completions",
    models: CUSTOM_MODELS as any,
    headers: { "X-App-Source": options.appSource },
  });
}
```

要点:

1. **fail-fast**:缺关键 env 直接 throw,不要 fallback 默认值
2. **`pi.registerProvider` 的 apiKey 字段**:传**环境变量名**,pi 内部读 env,这样凭证不进 process 内存对象(参考 pi 文档)
3. **`headers: { "X-App-Source": ... }`**:用于审计 / 计费,**必传**,值是 `code-reviewer` / `ops-bot`
4. **`models: CUSTOM_MODELS as any`**:pi 的 Model 类型严格,自定义 model 必须用 `as any` 加 `biome-ignore` 注释

### `getDefaultModelId`

```typescript
export function getDefaultModelId(appSource: string): string {
  if (appSource === "code-reviewer") {
    return "company-gpt-4";
  }
  return "company-gpt-4-mini";
}
```

要点:

1. **纯函数**,无 IO,无副作用
2. **必返回**(string),不要 `string | undefined`
3. **未知 `appSource` 返回 mini**(保守默认,代码评审用大模型,其他都用小)

---

## Props Conventions

### `options` 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `appSource` | `string` | ✅ | 标记请求来自哪个产品,审计与计费区分 |

新增字段时(例如想自定义 `headers` / `models`):

1. 先在 PRD 中讨论:为什么不能用环境变量?
2. 必填字段不要给默认值;选填字段在 caller 处明确传 `undefined`

### 环境变量

| 变量 | 必填 | 用途 |
|------|------|------|
| `LLM_BASE_URL` | ✅ | LLM 网关入口 URL |
| `LLM_API_KEY` | ✅ | LLM 网关 API key |

**注意**:`apiKey` 在 `registerProvider` 调用时传的是变量名字符串(`"LLM_API_KEY"`),不是值。pi 内部读 env。

---

## Styling Patterns

不适用。Biome 全仓配置(Tab、双引号、加分号)。

---

## Accessibility

错误信息友好性:

- `throw new Error("LLM_BASE_URL 环境变量未配置")` — 明确指出缺哪个变量
- 不要 `throw new Error("LLM 配置错误")` 这种含糊错误

---

## Common Mistakes

- ❌ 把 `LLM_API_KEY` 的值直接传 `apiKey: process.env.LLM_API_KEY!`(应该传变量名字符串)
- ❌ 缺 env 时用 `?? "default"` fallback(凭证类绝不允许 fallback)
- ❌ `registerCompanyProviders(pi)` 不传 options(`appSource` 必填,审计就靠它)
- ❌ 在函数内打印 `console.log(baseUrl, apiKey)`(凭证泄漏)
- ❌ 修改 `CUSTOM_MODELS` 时 cost 字段写真实数值(本仓库 cost 是占位 0,真实计费走网关 / 审计)
