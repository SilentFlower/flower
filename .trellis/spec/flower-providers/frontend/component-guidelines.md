# Component Guidelines

> 公开函数签名与配置规范。

---

## Component Structure

### `registerHavefunProviders`

```typescript
export function registerHavefunProviders(
  pi: ExtensionAPI,
  options: { appSource: string },
): void {
  if (!options.appSource || options.appSource.trim() === "") {
    throw new Error("registerHavefunProviders:options.appSource 必填(非空字符串)");
  }
  const baseUrl = getLLMBaseUrl();          // fail-fast
  const apiKeyEnvName = getLLMApiKeyEnvName(); // 返回字面量 "LLM_API_KEY",同时校验 env 存在
  const mergedModels = getMergedModels();    // BUILTIN_MODELS + LLM_EXTRA_MODELS_JSON

  for (const providerName of ALLOWED_PROVIDER_NAMES) {
    const api = PROVIDER_TO_API[providerName];
    // 关键:按 nativeApi 严格匹配,每个 model 只命中 1 个 provider(PRD ADR-6)
    const filteredModels = mergedModels.filter((m) => m.nativeApi === api);

    pi.registerProvider(providerName, {
      baseUrl,
      apiKey: apiKeyEnvName, // 字面量 "LLM_API_KEY" — pi 自己从 env resolve
      api,
      models: filteredModels.map(toProviderModelConfig),
      headers: { "X-App-Source": options.appSource },
    });
  }
}
```

要点:

1. **fail-fast**:缺关键 env / `appSource` 为空字符串直接 throw,不要 fallback 默认值
2. **`pi.registerProvider` 的 apiKey 字段**:传**环境变量名字符串**(`"LLM_API_KEY"`),pi 内部读 env,凭证不进 process 内存对象
3. **`headers: { "X-App-Source": ... }`**:用于审计 / 计费,**必传**,值是 `code-reviewer` / `ops-bot`
4. **一次性注册 4 个 provider**:`havefun-openai` / `havefun-openai-responses` / `havefun-anthropic` / `havefun-gemini`,模型按 `nativeApi` 严格归属

### `getDefaultModel`

```typescript
export function getDefaultModel(): { provider: ProviderName; modelId: string } {
  const provider = getLLMProvider();   // 读 LLM_PROVIDER,fail-fast 校验 ∈ 4 名
  const modelId = getLLMModel();       // 读 LLM_MODEL,fail-fast 非空
  const models = getMergedModels();
  const model = models.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`LLM_MODEL "${modelId}" 不在合并模型清单中。可选模型 id:[...]`);
  }
  if (model.nativeApi !== PROVIDER_TO_API[provider]) {
    throw new Error(`LLM_MODEL "${modelId}" 的原生协议与 LLM_PROVIDER 不一致`);
  }
  return { provider, modelId };
}
```

要点:

1. **无参**:模型选择是部署单元自己的事,每个进程(code-reviewer 容器 / ops-bot 容器)配自己的 `LLM_PROVIDER` + `LLM_MODEL`
2. **必返回**(`{provider, modelId}`),fail-fast 而不是退化到默认
3. **不接受任何 fallback**:任一 env 缺失 / 非法 / 协议不匹配 → 立即抛中文错误

### `buildHavefunModel`

```typescript
export function buildHavefunModel(
  provider: ProviderName,
  modelId: string,
): Model<Api> {
  // 校验 provider + modelId + 协议匹配
  const expectedApi = PROVIDER_TO_API[provider];
  const model = getMergedModels().find((m) => m.id === modelId);
  if (!model) throw new Error("...");
  if (model.nativeApi !== expectedApi) throw new Error("...");

  const baseUrl = getLLMBaseUrl();
  return {
    id: model.id,
    name: model.name,
    api: model.nativeApi,
    provider,
    baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  } as unknown as Model<Api>;
}
```

要点:

1. 返回 `pi-ai` 的 `Model<Api>`,可直接传给 `pi-agent-core` 的 `new Agent({ initialState: { model } })`
2. 同样校验 provider/modelId/协议匹配,fail-fast
3. 用 `as unknown as Model<Api>` 桥接 — pi-ai 的 `Model<TApi>` 对 `compat` 字段有 TApi 泛型约束,运行时拼装时不能精确推导

---

## Props Conventions

### `registerHavefunProviders` 的 `options` 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `appSource` | `string` | ✅ | 标记请求来自哪个产品,**仅写入 `X-App-Source` header**,不参与模型选择 |

新增字段时(例如想自定义 `headers` / `models`):

1. 先在 PRD 中讨论:为什么不能用环境变量?
2. 必填字段不要给默认值;选填字段在 caller 处明确传 `undefined`

### 环境变量

| 变量 | 必填 | 用途 |
|------|------|------|
| `LLM_BASE_URL` | ✅ | LLM 网关入口 URL |
| `LLM_API_KEY` | ✅ | LLM 网关 API key |
| `LLM_PROVIDER` | ✅ | 默认 provider(4 个 `havefun-*` 之一) |
| `LLM_MODEL` | ✅ | 默认模型 id(必须在合并清单中且协议匹配) |
| `LLM_EXTRA_MODELS_JSON` |   | (可选)JSON 数组,注入额外模型 |

**注意**:`apiKey` 在 `registerProvider` 调用时传的是变量名字符串(`"LLM_API_KEY"`),不是值。pi 内部读 env。

---

## Styling Patterns

不适用。Biome 全仓配置(Tab、双引号、加分号)。

---

## Accessibility

错误信息友好性:

- `throw new Error("LLM_BASE_URL 未配置")` — 明确指出缺哪个变量
- `throw new Error("LLM_PROVIDER 非法值 \"x\":合法值:havefun-openai / havefun-anthropic / ...")` — 列出合法集
- 不要 `throw new Error("LLM 配置错误")` 这种含糊错误

---

## Common Mistakes

- ❌ 把 `LLM_API_KEY` 的值直接传 `apiKey: process.env.LLM_API_KEY!`(应该传字面量字符串 `"LLM_API_KEY"`)
- ❌ 缺 env 时用 `?? "default"` fallback(凭证类绝不允许 fallback)
- ❌ `registerHavefunProviders(pi)` 不传 options(`appSource` 必填,审计就靠它)
- ❌ 在函数内打印 `console.log(baseUrl, apiKey)`(凭证泄漏)
- ❌ 修改 `BUILTIN_MODELS` 时 cost 字段写真实数值(本仓库 cost 是占位 0,真实计费走计费系统)
- ❌ 给 `getDefaultModel` 加 `appSource` 参数(已下线;`appSource` 仅是 header 标签)
