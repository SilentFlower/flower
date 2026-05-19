# Quality Guidelines

> 见 `frontend/quality-guidelines.md`(本包共用一套)。

---

## Backend 专项强约束

### ✅ fail-fast 优于 fallback

凭证 / URL / `LLM_PROVIDER` / `LLM_MODEL` 缺失或非法,立刻 throw,绝不"用默认值带病运行"。

### ✅ 凭证零打印

任何形式的凭证日志(包括长度、前缀、掩码后)都禁止。错误信息中也**不准**嵌入 apiKey 任何片段。

### ✅ `BUILTIN_MODELS` 是配置而非数据

通过代码 PR 修改,**不**通过远端配置中心动态注入。
运维侧的"加新模型"通过 `LLM_EXTRA_MODELS_JSON` env 注入(每条 entry 必须含 `id` + `nativeApi`,启动期 fail-fast 校验)。
理由:模型字段(`contextWindow` / `maxTokens` / `nativeApi` / `input` 模态)直接影响调用安全,需要 review。

---

## Forbidden Patterns

- ❌ 在 `registerHavefunProviders` 内 fetch 远端配置(违反"启动期只读 env"约定)
- ❌ 用 `setTimeout` 延迟注册(注册必须同步、立即完成)
- ❌ 在 `getDefaultModel` 加状态(策略函数必须纯)
- ❌ 在 `BUILTIN_MODELS` 元素加 `provider` 字段并自己拼接(`provider` 由 `pi.registerProvider(providerName, ...)` 第一参传入,本包按 `nativeApi` 自动匹配,模型不重复带 provider)
- ❌ 把同一模型注册到多个 provider(本包设计是单一原生协议归属;若需跨协议,通过 `LLM_EXTRA_MODELS_JSON` 显式指定不同 `nativeApi` 的副本)

---

## Testing Requirements

同 `frontend/quality-guidelines.md`。

- `npm run build` / `npm run typecheck` / `npm run check`
- `npm run test -w @flower-ai/flower-providers`(vitest)

---

## Code Review Checklist

- [ ] 是否任何路径上 `console.log` apiKey(grep 一遍 src)
- [ ] 是否启动期 fail-fast(缺 env 立刻 throw)
- [ ] 新增模型 `nativeApi` 是否 ∈ 4 个合法 pi-ai Api 值
- [ ] 新增模型 `contextWindow` / `maxTokens` 是否按真实能力填
- [ ] `buildHavefunModel` 是否仍只用 `as unknown as Model<Api>`(不用 `as any`)
- [ ] `appSource` 是否通过 header 透传 + **不**参与模型选择
