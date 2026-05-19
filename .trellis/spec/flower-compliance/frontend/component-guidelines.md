# Component Guidelines

> `registerCompliance` 与 helper 函数的签名约定。

---

## Overview

本包"公开组件"等于 **入口函数 + 类型导出**。

---

## Component Structure

### 主入口

```typescript
export type ComplianceMode = "ci-readonly" | "production-readonly";

export function registerCompliance(
  pi: ExtensionAPI,
  options: { mode: ComplianceMode; product: string },
): void {
  const { mode, product } = options;

  if (mode === "ci-readonly") {
    registerCiReadOnlyGuards(pi);
  }
  registerAudit(pi, product);
}
```

要点:

1. **首参 `pi: ExtensionAPI`**(pi 上游契约)
2. **次参 options 对象**,字段:`mode`(必填)、`product`(必填,审计字段)
3. **同步函数,返回 `void`**(`pi.on` 注册本身就是同步)
4. **顶部解构 options**,后续不再 `options.mode` 读

### Helper 拆分

- `registerCiReadOnlyGuards(pi)`:只装"CI 拦截规则"
- `registerAudit(pi, product)`:只装"审计上报"

两者完全独立,可以分别测试 / 灰度。

---

## Props Conventions

`options` 的字段约定:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | `ComplianceMode` | ✅ | 决定是否注册拦截规则 |
| `product` | `string` | ✅ | 审计字段中的产品名(`"code-reviewer"` / `"ops-bot"`) |

新增字段时:

1. 必须先在 `ComplianceMode` / options 类型中显式声明
2. 默认值放在解构里(`const { mode, product, foo = "bar" } = options;`)
3. 在 `index.md` 的"包定位"小节同步更新

---

## Styling Patterns

不适用。Biome 全仓配置(Tab、双引号、加分号、trailing comma)。

---

## Accessibility

不适用(无 UI、无 CLI)。

替代关注点:**错误信息友好性**。

- `throw new Error("XXX 未配置")` 必须带具体环境变量名
- `console.warn("[audit] 上报失败:", err)` 必须有 `[audit]` 前缀,便于日志过滤

---

## Common Mistakes

- ❌ 在 `registerCompliance` 里写 `await`(注册逻辑必须同步;真要异步初始化,放到 `pi.on("session_start", ...)`)
- ❌ 把 `mode` / `product` 当全局 module-level `let` 缓存(同一进程 / 测试中可能多次调用)
- ❌ 把审计字段写死(应该让 caller 通过 `product` 传入)
- ❌ 在 `registerCiReadOnlyGuards` 里直接抛 `Error` 而非 `return { block: true, reason }`(抛 Error 会让 pi 整个调用栈失败)
