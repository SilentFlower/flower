# Error Handling

> SDK 错误处理。

---

## Overview

工具 `execute` 的错误处理两类:

1. **SDK 错误**(网络 / 鉴权 / 限流):转 user-friendly content 返回,**不 throw**
2. **凭证缺失**:在 `getClient()` 首次调用时 throw,**fail-fast**

---

## Error Types

不定义自定义错误类。SDK 抛什么就接什么。

---

## Error Handling Patterns

### SDK 调用:catch + 返回错误内容

```typescript
async execute(_id, params, signal) {
  try {
    const result = await getSlsClient().getLogs({ ..., signal });
    return {
      content: [{ type: "text", text: maskSensitive(format(result)) }],
      details: { total: result.count },
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `ARMS 日志查询失败:${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      details: { error: true },
    };
  }
}
```

为什么不 throw?

- pi 框架收到 throw 会把它当系统错误,LLM 看不到具体原因
- 转 `content` 后 LLM 能告诉用户"我刚才查日志失败了,原因是 ...",更友好
- 仍然通过 `details: { error: true }` 让 pi 框架 / 审计感知到这是失败路径

### 凭证缺失:fail-fast

```typescript
function getSlsClient(): SLS20201230 {
  if (_slsClient) return _slsClient;
  const ak = process.env.ALICLOUD_AK;
  const sk = process.env.ALICLOUD_SK;
  if (!ak || !sk) throw new Error("ALICLOUD_AK / ALICLOUD_SK 环境变量未配置");
  _slsClient = new SLS20201230(ak, sk);
  return _slsClient;
}
```

约定:

- 首次工具调用时 throw,**不**在 `import` 时 throw(否则 `code-reviewer` import 本包就崩,虽然它不该用)
- 错误信息明确变量名

### 取消信号

```typescript
await getSlsClient().getLogs({ ..., signal });
```

`signal` 来自 pi 框架,LLM 中止 / 用户超时都会触发。SDK 不接受 signal 时,用 `AbortSignal` + `Promise.race` 包一层。

---

## API Error Responses

不适用。

---

## Common Mistakes

- ❌ SDK 错误直接 throw(LLM 不知道发生了什么,用户看到的是"工具调用失败"模糊提示)
- ❌ catch 后 `console.error(err)` 后 throw(双重打印 + 仍然丢用户体验)
- ❌ 在 `import` 时检查凭证 `if (!process.env.AK) throw ...`(让加载本包就崩,违反惰性原则)
- ❌ 忽略 `signal` 参数(LLM 取消时,工具仍在跑)
- ❌ SDK 错误信息直接放进 `content`(可能含凭证残片 / 内部 URL;先 `maskSensitive` 或者只用 `err.message`,不要 `err.stack`)
