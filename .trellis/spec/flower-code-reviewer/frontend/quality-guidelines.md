# Quality Guidelines

> `flower-code-reviewer` 的代码质量底线。

---

## Overview

整体走全仓 Biome 风格 + TS strict,本节列**该包特有的强约束**。

参考:
- 全仓代码风格:`biome.json`
- TS 严格度:`tsconfig.base.json`(`strict: true`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`)

---

## Forbidden Patterns

### ❌ 在 stdout 写"评审报告"

```typescript
// 严格禁止
console.log("评审发现以下问题: ...");
```

CI 日志没人看,且违反 `prompts.ts` 中"所有意见必须通过工具发表"的硬约束。
真要 debug 输出,前缀必须是 `[code-reviewer]` 且仅用于诊断信息。

### ❌ 直接 `fetch` GitLab API

```typescript
// 错误
await fetch(`https://gitlab.com/api/v4/.../notes`, ...);
```

必须经过 `@flower-ai/flower-tools-gitlab` 的工具入口,这样:
- compliance 拦截能生效(CI 只读模式下可统一拦写操作)
- 审计能完整记录工具调用
- LLM 能感知"评论已发"

### ❌ 绕过 compliance 注册顺序

```typescript
// 错误:工具先于 compliance 注册,后续注册的 tool_call hook 拦截不到先注册的工具
registerGitlabTools(pi);
registerCompliance(pi, { mode: "ci-readonly", product: "code-reviewer" });
```

必须 **provider → telemetry → compliance → tools**(telemetry 先于 compliance:
pi 按注册顺序短路,否则被拦截的调用意图进不了 trace)。

### ❌ 在 prompt 里软化硬约束

```typescript
// 错误
return `... 请尽量通过工具发评论,如果不方便也可以直接输出文字。`;
```

硬约束就是硬约束(severity 三档、必须工具调用、不重复评论),改 prompt 时不能加"如果不方便""可选"等口子。

### ❌ skill 文件路径硬编码绝对路径

```typescript
// 错误
readFileSync("/app/skills/general.md", "utf-8");
```

必须通过 `getSkillsDir()`(基于 `import.meta.url` 计算),容器里 / 本地 dev 都能跑。

---

## Required Patterns

### ✅ 顶层 catch-all 必须在 `cli.ts` 而非 `run.ts`

```typescript
// cli.ts
main().catch((err) => {
  console.error("[code-reviewer] 运行失败:", err);
  process.exit(2);
});
```

`runReview` 只抛业务错误,不自己处理日志和退出码。

### ✅ 退出码语义

- `0` 评审完成,无 blocker
- `1` 至少一条 blocker(让 pipeline fail)
- `2` 程序错误(参数错、缺环境、pi 启动失败)

任何新增退出码 → 同时更新 `args.ts:CliArgs` 类型注释 + `--help` 文字。

### ✅ 公开 API 必有 JSDoc

每个 `export function` / `export interface` 都要有中文 JSDoc(`@param` / `@returns`),
参考 `src/args.ts:22-32`、`src/run.ts:26`。

### ✅ Biome 风格

- Tab 缩进(`indentStyle: "tab"`、`indentWidth: 1`)
- 双引号、加分号、trailing comma
- 行宽 120
- 本地相对 import 后缀 **必须** 是 `.js`(ESM 要求)

---

## Testing Requirements

当前仓库**未配置单元测试**(`package.json` 中 `test` 是 workspace-wide 占位)。

新增任何**纯函数**(无 IO、无 pi 上下文)时,鼓励同步加 vitest 测试,
但**没有测试**也不阻塞合入。
有 IO 的函数(如 `runReview` / `pickSkill`)的测试需要 mock GitLab + pi,优先级低。

最低验证标准:

- [ ] `npm run typecheck` 通过
- [ ] `npm run check`(Biome)无 error
- [ ] `npm run build` 通过
- [ ] 至少手工跑过一次 `flower-review --dry-run --mr-iid <N>`(若有目标 MR)

---

## Code Review Checklist

代码评审(无论人评还是 sub-agent 评)关注:

- [ ] 注册顺序:`provider → compliance → tools`
- [ ] 入口分层:`cli.ts` 只做 argv → runReview → exit
- [ ] prompt 的硬约束是否被软化
- [ ] 是否在 stdout 输出评审意见(应通过工具)
- [ ] 是否漏掉中文 JSDoc
- [ ] 是否硬编码路径 / 凭证
- [ ] 退出码语义是否与 `args.ts` / `--help` 一致
- [ ] 新工具的 `name`(snake_case)是否唯一、`description` 是否足够 LLM 决策
