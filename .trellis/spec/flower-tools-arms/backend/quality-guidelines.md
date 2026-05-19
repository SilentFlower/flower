# Quality Guidelines

> 见 `frontend/quality-guidelines.md`。本节聚焦后端实现。

---

## Backend 专项强约束

### ✅ SDK 客户端必须惰性单例

```typescript
let _slsClient: SLS20201230 | undefined;
export function getSlsClient(): SLS20201230 {
  if (_slsClient) return _slsClient;
  ...
  _slsClient = new SLS20201230(...);
  return _slsClient;
}
```

- `import` 时不连接(避免 caller 加载本包就崩)
- 首次 `execute` 时初始化
- 单例,避免连接泄漏

### ✅ 凭证 fail-fast(首次调用时)

```typescript
const ak = process.env.ALICLOUD_AK;
const sk = process.env.ALICLOUD_SK;
if (!ak || !sk) throw new Error("ALICLOUD_AK / ALICLOUD_SK 环境变量未配置");
```

### ✅ SDK 错误转 user-friendly content

```typescript
} catch (err) {
  return {
    content: [{ type: "text", text: `ARMS 日志查询失败:${err.message}` }],
    details: { error: true },
  };
}
```

不要 throw(LLM 看不见原因)。

### ✅ `signal` 传给 SDK

```typescript
await getSlsClient().getLogs({ ..., signal });
```

允许 pi 框架 / 用户取消。

### ✅ 脱敏规则 immutable

```typescript
const RULES: ReadonlyArray<{ pattern: RegExp; replace: string }> = [
  ...
];
```

`ReadonlyArray` 保证类型层不被改;module-level `const` 保证运行期不被改。

---

## Forbidden Patterns

- ❌ 在 `execute` 内 `new SLS20201230(...)`(每次重建连接)
- ❌ 在 `import` 时初始化 SDK 客户端(让 caller 一加载就崩)
- ❌ SDK 错误 throw 让 pi 框架接(应该转 content)
- ❌ 忽略 `signal`(不支持取消)
- ❌ `RULES` 改成 `let` / 数组里加 mutable 对象

---

## Testing Requirements

同 `frontend/quality-guidelines.md`。

新增脱敏规则时:

- [ ] 给该规则写测试样本(典型敏感数据 + 边界 case)
- [ ] 跑一次 `maskSensitive(sample)` 确认替换正确
- [ ] 不要破坏现有规则(grep 一遍 `maskSensitive` 调用点确认)

---

## Code Review Checklist

- [ ] SDK 客户端是否惰性单例
- [ ] `getXxxClient()` 内是否 fail-fast 校验凭证
- [ ] SDK 错误是否转 user-friendly content
- [ ] `signal` 是否传给 SDK
- [ ] 新增的脱敏规则是否覆盖了真实场景(用 sample 测过)
- [ ] 是否 console.log 了 query / 凭证 / 日志原文
- [ ] `import` 本包不应触发任何网络调用(可以 `node -e "import(...)"` 验证)
