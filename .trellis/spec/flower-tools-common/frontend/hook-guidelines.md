# Hook Guidelines

> `registerCommonTools(pi)` 装配 + 跨系统通用模式。

---

## Overview

```typescript
export function registerCommonTools(pi: { registerTool: (def: any) => void }): void {
  pi.registerTool(zentaoSearchTool);
  pi.registerTool(dingtalkDocSearchTool);
}
```

要点:

1. 集中入口,不让 caller 一个个注册
2. 顺序无关
3. 跨产品(code-reviewer / ops-bot)都装

---

## Custom Hook Patterns

### `defineTool` 静态定义

与 `flower-tools-arms` 同,工具是 module-level `const`,不是工厂函数生成。

### 跨系统通用模式:鉴权 + token 缓存

钉钉文档需要"换 accessToken"流程:

```typescript
// 伪代码,真实实现见 dingtalk-doc.ts
let _cachedToken: { token: string; expiresAt: number } | undefined;

async function getDingTalkAccessToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiresAt > now + 60_000) {
    return _cachedToken.token;
  }
  const appKey = process.env.DINGTALK_APP_KEY;
  const appSecret = process.env.DINGTALK_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error("DINGTALK_APP_KEY / APP_SECRET 未配置");
  }
  const resp = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    body: JSON.stringify({ appKey, appSecret }),
    headers: { "Content-Type": "application/json" },
  });
  const { accessToken, expireIn } = await resp.json();
  _cachedToken = {
    token: accessToken,
    expiresAt: now + expireIn * 1000,
  };
  return accessToken;
}
```

约定:

1. **module-level `let _cachedToken`** 是允许的 mutable state(网络资源,合理的复用)
2. **过期前 60 秒就刷新**(`_cachedToken.expiresAt > now + 60_000`),避免 token 在调用过程中失效
3. **凭证缺失 throw**,在首次 `execute` 调用时报错(惰性)
4. **失败不缓存**:抛错前 `_cachedToken = undefined`,下次重新尝试

### 禅道版本判断

禅道 v17+ 用 Token,旧版本 session 流。约定:

```typescript
const useToken = process.env.ZENTAO_TOKEN != null;
// 或者通过 ZENTAO_VERSION env 显式控制
```

不要在工具内部猜测版本,通过 env 显式控制。

---

## Data Fetching

### 禅道:REST API

```typescript
// 伪代码
const url = `${baseUrl}/api.php/v1/search?keywords=${encodeURIComponent(params.query)}`;
const resp = await fetch(url, {
  headers: { Authorization: `Bearer ${process.env.ZENTAO_TOKEN}` },
  signal,
});
```

约定:

- URL 参数用 `encodeURIComponent`
- 必传 `signal`
- 必有超时(`AbortSignal.timeout(10_000)` + `AbortSignal.any([signal, timeoutSignal])`)

### 钉钉文档:换 token 再调

```typescript
const accessToken = await getDingTalkAccessToken();
const resp = await fetch(`https://api.dingtalk.com/v1.0/...`, {
  headers: { "x-acs-dingtalk-access-token": accessToken },
  signal,
});
```

---

## Naming Conventions

- 工具:见 directory-structure.md
- 内部 helper:`get<System><Action>`(`getDingTalkAccessToken`)
- 缓存变量:下划线前缀(`_cachedToken`)
- token 字段:沿用各系统 API 字段名(`accessToken` / `expireIn`),不要重命名

---

## Common Mistakes

- ❌ 每次 `execute` 都重新换 accessToken(钉钉限流,且增加延迟)
- ❌ 缓存到 expireIn 才刷新(token 在用的过程中过期会失败;留 60s 余量)
- ❌ 把 accessToken 写到 `details` 字段(会被 SIEM 上报)
- ❌ 禅道 API 失败 throw 让 LLM 不知道(转 content,告诉 LLM 失败原因)
- ❌ 在 token 缓存内做 retry(失败就抛,让 LLM 决定重试 / 换工具)
