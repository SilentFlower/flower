# Quality Guidelines

> `flower-tools-common` 的代码质量底线。

---

## Forbidden Patterns

### ❌ 工具实现写操作

```typescript
// 错误
export const zentaoCreateBugTool = defineTool({ ... });
```

本包工具只允许只读动词:`search` / `list` / `get` / `query`。

### ❌ 跨系统耦合

```typescript
// 错误:zentao.ts 内 import dingtalk-doc.ts
import { getDingTalkAccessToken } from "./dingtalk-doc.js";
```

每个系统独立。两个系统目前共享的只有"工具定义结构"+"`@earendil-works/pi-ai` Type 库"。

### ❌ accessToken 缓存逻辑写在 `index.ts`

`accessToken` 是钉钉特有的,放 `dingtalk-doc.ts`。`index.ts` 是装配点。

### ❌ 工具实现里硬编码 baseUrl

```typescript
// 错误
const url = "https://zentao.corp.internal/api.php/v1/search";
```

`baseUrl` 必须从 env 读(`ZENTAO_BASE_URL`)。

### ❌ 工具结果未脱敏

禅道搜索 / 钉钉文档可能含人名、联系方式等。必须经 `maskSensitive` 处理。
当前 stub 实现没有调,真实接入时**必须加**(可以从 `@flower-ai/flower-tools-arms` import,但更建议拆出 `flower-tools-shared/mask` 共享包,或直接 copy 一份保持包独立)。

---

## Required Patterns

### ✅ 命名一致

工具名 `<system>_<action>`,变量 `<system><Action>Tool`,文件名 `<system>.ts`。

### ✅ 参数 description 必填

每个 schema 字段都带 `Type.String({ description: "..." })`。

### ✅ accessToken 过期前 60s 刷新

```typescript
if (_cachedToken && _cachedToken.expiresAt > now + 60_000) {
  return _cachedToken.token;
}
```

### ✅ URL 参数 `encodeURIComponent`

```typescript
const url = `${baseUrl}/search?keywords=${encodeURIComponent(params.query)}`;
```

### ✅ 凭证 fail-fast

```typescript
if (!appKey || !appSecret) throw new Error("DINGTALK_APP_KEY / APP_SECRET 未配置");
```

### ✅ 公开 API 必有 JSDoc

每个工具 / `registerCommonTools` 上方必有中文 JSDoc。

---

## Testing Requirements

- `npm run typecheck`
- `npm run check`
- `npm run build`

新增工具:

- [ ] 配置 env 后,LLM 能正常调用
- [ ] 凭证缺失时,工具返回友好错误(不是 throw)
- [ ] accessToken 过期前 60s 已经刷新

---

## Code Review Checklist

- [ ] 工具是否只读(动词 / name / 实现)
- [ ] 每个参数是否有 description
- [ ] URL 拼接是否 `encodeURIComponent`
- [ ] 网络请求是否带 `signal`
- [ ] accessToken 缓存逻辑是否正确(过期 / 失败处理)
- [ ] 凭证是否 fail-fast
- [ ] 跨系统是否独立(无 import 跨系统的 helper)
