# Directory Structure

> `@flower-ai/flower-providers` 的目录布局。

---

## Directory Layout

```
packages/flower-providers/
├── src/
│   └── index.ts      # 唯一公开入口:registerCompanyProviders + getDefaultModelId + CUSTOM_MODELS
├── dist/
├── package.json
└── tsconfig.json
```

**本包只有 1 个文件**。

---

## Module Organization

`src/index.ts` 包含:

| 元素 | 类型 | 是否导出 |
|------|------|---------|
| `CUSTOM_MODELS` | module-level const | ❌(内部) |
| `registerCompanyProviders(pi, options)` | 函数 | ✅ |
| `getDefaultModelId(appSource)` | 函数 | ✅ |

---

## 何时需要拆文件

当下"单文件"够用。下列情况发生时再拆:

- 模型清单超过 ~50 行 → 拆 `models.ts`
- 引入多个 provider(非单一 `company`) → 拆 `providers/<name>.ts`
- 出现 model 选择策略的复杂规则(基于 token 用量 / 时段 / 用户) → 拆 `selector.ts`

---

## Naming Conventions

- 公开函数:`register<Domain>Providers`(`registerCompanyProviders`)
- 私有常量:全大写下划线(`CUSTOM_MODELS`)
- 模型 id:lowercase 加横杠(`company-gpt-4` / `company-gpt-4-mini`),贴近 OpenAI 命名习惯
- 环境变量:`LLM_BASE_URL` / `LLM_API_KEY`(通用,所有产品都用同一组凭证)

---

## Examples

- 干净的 provider 注册:`src/index.ts:45-69`
- 简单的模型选择策略:`src/index.ts:77-82`
