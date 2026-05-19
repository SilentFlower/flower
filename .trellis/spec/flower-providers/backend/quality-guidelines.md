# Quality Guidelines

> 见 `frontend/quality-guidelines.md`(本包共用一套)。

---

## Backend 专项强约束

### ✅ fail-fast 优于 fallback

凭证 / URL 缺失,立刻 throw,绝不"用默认值带病运行"。

### ✅ 凭证零打印

任何形式的凭证日志(包括长度、前缀、掩码后)都禁止。

### ✅ `CUSTOM_MODELS` 是配置而非数据

通过代码 PR 修改,**不**通过环境变量 / 远端配置中心动态注入。
理由:模型字段(`contextWindow` / `maxTokens` / `input` 模态)直接影响调用安全,需要 review。

---

## Forbidden Patterns

- ❌ 在 `registerCompanyProviders` 内 fetch 远端配置(违反"启动期只读 env"约定)
- ❌ 用 `setTimeout` 延迟注册(注册必须同步、立即完成)
- ❌ 在 `getDefaultModelId` 加状态(策略函数必须纯)
- ❌ 在 `CUSTOM_MODELS` 元素加 `provider` 字段并自己拼接(`provider` 由 `pi.registerProvider("company", ...)` 第一参传入,模型不重复带)

---

## Testing Requirements

同 `frontend/quality-guidelines.md`。

---

## Code Review Checklist

- [ ] 是否任何路径上 `console.log` apiKey(grep 一遍 src)
- [ ] 是否启动期 fail-fast(缺 env 立刻 throw)
- [ ] 新增模型 `contextWindow` / `maxTokens` 是否按真实能力填
- [ ] `as any` 是否带 `biome-ignore` 注释
- [ ] `appSource` 是否通过 header 透传
