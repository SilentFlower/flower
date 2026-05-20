# Research: PR 评论 Bot 视觉风格 + GitLab 兼容模板

- **Query**: 调研 coderabbitai / Roo-Code PR 6326 / GitLab 行内评论格式,产出可落地的 markdown 模板
- **Scope**: external + 落到 `flower-code-reviewer/prompts.ts` 内部可用
- **Date**: 2026-05-20
- **Target consumer**: `packages/flower-code-reviewer/src/prompts.ts`(直接复制到 prompt 里给 LLM)

---

## 1. 关键发现汇总(给主 agent 看的 TL;DR)

| 主题 | 结论 | 关键证据 |
|---|---|---|
| GitLab 支持 ` ```suggestion ` 块 | ✅ 支持,语法 `` ```suggestion:-0+0 `` (行数偏移可选),GitHub 不带行号偏移 | docs.gitlab.com `/user/project/merge_requests/reviews/suggestions/` |
| GitLab `<details><summary>` 折叠 | ✅ 标准 HTML 受支持 (`details`/`summary`/`abbr`/`span` 在 allowlist) | docs.gitlab.com `/user/markdown/#collapsible-section` |
| GitLab `> [!note]` / `[!tip]` / `[!warning]` 等 alert | ✅ GitLab 17.10+ 支持 GitHub 风格 alert 块 | docs.gitlab.com `/user/markdown/#alerts` (类型: note/tip/important/caution/warning) |
| GitLab quick action(`/approve` `/wip` `/label`) | ✅ 支持,但 **MR 评论里 `/approve` 会真的批准 MR**,bot **不应主动用** | docs.gitlab.com `/user/project/quick_actions/` |
| GitLab `:emoji:` shortcode | ✅ 支持(`:warning:` `:bug:` 等),也支持自定义 emoji | docs.gitlab.com `/user/markdown/#emoji` |
| GitLab `~"label"` `%milestone` `#123` 引用 | ✅ 支持,bot 评论里可以加 `~"priority::high"` 这类 scoped label 链接 | docs.gitlab.com `/user/markdown/#gitlab-specific-references` |
| GitHub `> [!IMPORTANT]` 在 GitLab 渲染 | ✅ GitLab 17.10+ 兼容,旧版本只会渲染成普通 blockquote(降级安全) | docs.gitlab.com `/user/markdown/#alerts` |
| CodeRabbit 行内评论 4 段式 | severity 标签行 → 标题 → 解释 → suggestion + AI prompt(折叠) | coderabbit-pr-review PR 102 inline comment |
| CodeRabbit walkthrough 整体评论 | `📝 Walkthrough` 折叠 → 变更分层表 → estimated effort → 🐰 poem(可选) | coderabbit-pr-review PR 102 issue comment |

**对 prompts.ts 的硬约束建议** —— 见 §5。

---

## 2. CodeRabbit 实测样本(coderabbitai/coderabbit-pr-review#102)

### 2.1 整体 MR 评论(walkthrough)结构

```
<!-- This is an auto-generated comment: summarize by coderabbit.ai -->
<!-- walkthrough_start -->

<details>
<summary>📝 Walkthrough</summary>

## Walkthrough

<2-3 句变更总览,自然语言>

## Changes

**<分类标题,如 "Tool Configuration">**

| Layer / File(s) | Summary |
|---|---|
| **Tool Configuration** <br> `.coderabbit.yml`, `.tflint.hcl` | <每行一句话总结> |
| **Core Infrastructure** <br> `main.tf` | <…> |

## Estimated code review effort

🎯 3 (Moderate) | ⏱️ ~20 minutes

## Poem

> 🐰 *<可选的押韵小诗>*

</details>

<!-- walkthrough_end -->
```

**注意**:
- 全包在 `<details>` 里,默认折叠,**默认不刷屏**
- `Changes` 表用 **加粗主题 + 文件清单 + 横向表格**,扫读非常快
- HTML comment `<!-- walkthrough_start -->` 用来做幂等去重(更新评论而不是追加)

### 2.2 行内 actionable 评论结构(4 段)

```
_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**<问题一句话标题>。**

<解释段落,1-3 句,说明 why>

<details>
<summary>Suggested fix</summary>

```diff
- old_line
+ new_line
```
</details>

<!-- suggestion_start -->

<details>
<summary>📝 Committable suggestion</summary>

> ‼️ **IMPORTANT**
> Carefully review the code before committing. <safety reminder>

```suggestion
output "primary_eip" {
  value = length(aws_eip.Web) > 0 ? aws_eip.Web[0].public_ip : null
}
```

</details>

<!-- suggestion_end -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
<给后续修复 agent 的精确指令>
```

</details>

<!-- This is an auto-generated comment by CodeRabbit -->
```

**4 段分别是**:
1. **斜体 severity 标签行** —— `_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_`(三段:类型 | 严重度 | 难度)
2. **加粗一句话标题** —— 终结于句号
3. **解释段落** —— 1-3 句,讲 why 不讲 what(what 已经在 diff 里了)
4. **可折叠区** —— Suggested fix(diff 块) + Committable suggestion(`suggestion` 代码块,GitHub/GitLab 都支持点 "Apply") + AI prompt(给后续 auto-fix bot 用)

**关键技巧**:
- 第一行 severity 用斜体 + emoji,**不占垂直空间但视觉锚点强**
- 解释段落短到一屏内能看完
- 任何"长内容"(fix code / agent prompt)都进 `<details>`,默认折叠避免噪声
- HTML comment fingerprint(`<!-- fingerprinting:phantom:poseidon:ocelot -->`)用来 dedupe

---

## 3. Roo-Code PR #6326 评论格式参考

PR 自身是 bot(roomote-v0)创建,review 由 **ellipsis-dev[bot]** 发,极简风格:

### 3.1 PR description(bot 生成,带 Ellipsis 总结块)

```markdown
This PR adds support for ...

## Changes
- Added X
- Updated Y

## Testing
- Added tests ...

## Context
<why this change>

----

> [!IMPORTANT]
> <一句话总览>
>
>   - **Behavior**:
>     - <bullet>
>   - **Functions**:
>     - <bullet>
>   - **Testing**:
>     - <bullet>
>
> <sup>This description was created by [Ellipsis](...)</sup>
```

**亮点**:用 `> [!IMPORTANT]` alert 块包重点摘要,GitHub / GitLab 17.10+ 都渲染成醒目的卡片,旧版降级成 blockquote(优雅降级)。

### 3.2 Ellipsis 行内评论(极简,1 行)

```markdown
MAX_DEPTH is used in resolveSymlinkPath before it's declared. Consider moving "const MAX_DEPTH = 5" above its usage to avoid potential TDZ issues.
```

—— **没有 emoji, 没有 severity, 没有折叠**, 适合"low-noise / 高信号"场景。

### 3.3 Bot 间对话格式(自动回复主人 @mention)

```markdown
Hi @mrubens, thanks for the suggestion! I see ...

1. **Extracted a reusable `resolveSymlinkPath` function** that ...
2. **Removed the duplicate ...** 
3. **Updated `loadAgentRulesFile`** to ...

All tests are passing locally. CI checks are currently running.
```

✅ 成功状态用 `✅ **Fixed!**` 加粗 + emoji 起头,非常醒目。

---

## 4. GitLab 兼容性矩阵(实测,docs 引用)

| Markdown 特性 | GitHub | GitLab | 备注 |
|---|---|---|---|
| ` ```suggestion ` 单行替换 | ✅ | ✅ | GitLab 语法 `` ```suggestion:-0+0 `` 可指定行偏移 |
| ` ```suggestion ` 多行(up to 200 行) | ✅ | ✅ GitLab 17.7+ | GitLab 用 `:-2+2` 表示上下扩展 |
| `<details><summary>` 折叠 | ✅ | ✅ | 受 `SanitizationFilter` allowlist 明确包含 |
| ` ```diff ` 代码块(高亮 +/-) | ✅ | ✅ | 通用 |
| `> [!note]` `[!tip]` `[!important]` `[!warning]` `[!caution]` | ✅ | ✅ GitLab 17.10+ | 老 GitLab 降级成 blockquote |
| `:emoji:` shortcode | ✅ | ✅ | `:warning:` `:bug:` `:rocket:` `:white_check_mark:` 等 |
| `<kbd>` `<sub>` `<sup>` | ✅ | ✅ | 在 allowlist |
| 表格 | ✅ | ✅ | GitLab 支持 `<br>` 换行单元格,`task list in table`(GitLab 18.9+) |
| Mermaid 图 | ✅ | ✅ | GitLab 支持 v10 |
| `~"label"` `%milestone` `#123` GitLab 专属引用 | ❌ | ✅ | bot 可用来链接到 issue / label |
| 内嵌 diff(`{+ add +}` `[- del -]`) | ❌ | ✅ | GitLab 专属,慎用(不通用) |
| 表情反应(`/award :thumbsup:`) | ❌ | ✅ | bot 不应主动用 |
| `/approve` `/wip` `/close` 等 quick action | ❌ | ✅ | **bot 评论里禁用**(会真的执行) |

### 4.1 Quick Actions:bot 必须避开的"地雷"

GitLab quick action 在评论里**一旦发送就会真的执行**。bot 评论里如果不小心包含 `/approve`、`/wip`、`/close`、`/assign @someone` 等,会真的影响 MR 状态。

**Code-reviewer prompt 必须禁止 LLM 生成以 `/` 开头的整行,或对所有 `/` 做转义** —— 见 §5 R3。

---

## 5. 给 `flower-code-reviewer/prompts.ts` 的硬约束建议

将以下规则添加到 `buildPrompt` 的 "严格要求" 段:

```text
## 评论 markdown 样式(强制)

1. **行内评论(gitlab_post_line_comment)**必须按 4 段式:
   - 第 1 行:`[severity:<level>] <emoji> <一句话问题标题>`
     - level ∈ {blocker, major, minor},分别对应 emoji 🔴 / 🟠 / 🔵
     - 例:`[severity:blocker] 🔴 硬编码 secret 泄漏风险`
   - 第 2-4 行:解释段落,1-3 句,讲 why(diff 已经在 GitLab UI 显示了 what)
   - 折叠区 1(可选):`<details><summary>修复建议</summary>` 包 ` ```suggestion ` 块
   - 折叠区 2(可选):`<details><summary>推理过程</summary>` 包 reasoning,默认折叠避免刷屏

2. **整体评论(gitlab_post_comment)**用 walkthrough 结构,**整个 body 包在 `<details>` 里默认折叠**:
   - `## 概要`(2-3 句变更总览)
   - `## 文件变更`(表格:文件路径 | 一句话总结 | 关注等级)
   - `## 行动建议`(任务列表,如有 blocker)
   - 不要生成 emoji 诗

3. **「无问题」轻量评论**:只发一条整体评论,正文 ≤ 3 行,不折叠:
   ```
   :white_check_mark: 已审,未发现需要修改的问题。
   <一句话补充,如关注的点或值得肯定的实现>
   ```

4. **GitLab quick action 禁令**:绝对不要生成以 `/` 开头的整行(如 `/approve` `/close` `/assign`),
   GitLab 会把它当 quick action 真的执行。如果评论中需要展示路径,用反引号包(`` `/path/to/file` ``)。

5. **emoji 用 GLFM 兼容的 shortcode**(`:warning:` 而不是原生 ⚠️),便于 GitLab 自定义 emoji 渲染。
   例外:severity 行的 🔴/🟠/🔵 用 unicode 直接写(GitLab/GitHub 都直接渲染)。

6. **`[severity:<level>] ` 前缀必须严格保留**,run.ts 的 `scanForBlockers` 函数依赖这个前缀做 blocker 扫描。
   只对真问题打 blocker(参考现有规则)。
```

---

## 6. 落地模板(可直接拷进 prompt 或文档示范)

### 6.1 MR 整体评论模板

```markdown
<details>
<summary>:robot: <b>代码评审报告</b> (flower-code-reviewer)</summary>

## 概要

本次 MR 在 `internal/auth/` 下新增了签名验证流程,涉及 1 个新文件与 2 个文件改动。整体实现思路合理,但发现 **1 个安全 blocker** 与 **2 个 minor 建议**,详见下方行内评论。

## 文件变更

| 文件 | 一句话总结 | 关注等级 |
|---|---|---|
| `internal/auth/sign_verify.go` | 新增签名验证主流程 | :red_circle: blocker |
| `internal/auth/sign_verify_test.go` | 单测覆盖 happy path | :large_blue_circle: minor |
| `cmd/server/main.go` | 注册 sign verify middleware | :large_blue_circle: minor |

## 行动建议

- [ ] 必须修复:`sign_verify.go:42` 硬编码 secret,改用环境变量
- [ ] 建议补充:`sign_verify_test.go` 缺 invalid signature 的负向 case
- [ ] 可选优化:`main.go` middleware 注册顺序建议提前到 auth 之后、业务 handler 之前

</details>
```

**渲染效果**:GitLab UI 上是一个折叠卡片,标题 "🤖 **代码评审报告** (flower-code-reviewer)" 醒目可点开。

### 6.2 行内评论模板(带 severity:blocker)

```markdown
[severity:blocker] 🔴 **硬编码 secret 存在凭据泄漏风险**

`hmacSecret` 变量直接以字符串字面量出现在源码中。一旦本仓库被 fork 或者代码被 leak,凭据将立刻失效需要轮转,且 git 历史也会永久包含该值。

公司合规要求所有密钥必须来自环境变量或 secret manager。

<details>
<summary>修复建议(可点 Apply suggestion 直接落地)</summary>

```suggestion
hmacSecret := os.Getenv("SIGN_VERIFY_HMAC_SECRET")
if hmacSecret == "" {
    return nil, fmt.Errorf("SIGN_VERIFY_HMAC_SECRET env var is required")
}
```

</details>

<details>
<summary>:bulb: 为什么判定为 blocker</summary>

参照《应用安全编码规范 v3.2》§4.1:**任何长度 ≥ 16 字节的字符串字面量若被用于 hmac/aes/rsa key,必须 block**。本例 `"sk_live_aB3xQ..."` 命中此规则。

若此为测试 fixture,请加 `// nolint:secrets // test fixture` 显式豁免。

</details>
```

### 6.3 行内评论模板(severity:major,无修复 suggestion)

```markdown
[severity:major] 🟠 **签名校验失败时未记录审计日志**

当 `hmac.Equal` 返回 false 时,函数直接返回 `false, nil`,没有任何日志输出。安全事件追溯将无法定位攻击源。

参考 `internal/audit/logger.go` 中已有的 `AuditLog(ctx, "sign_verify_failed", ...)` 模式补充审计日志即可。
```

### 6.4 行内评论模板(severity:minor,带 reasoning 折叠)

```markdown
[severity:minor] 🔵 **常量 `MaxSignatureAge` 建议提到包级**

当前 `MaxSignatureAge = 5 * time.Minute` 内联在函数体里,如果未来需要按环境调优(测试 vs 生产),改起来需要改函数签名。

<details>
<summary>:bulb: 推理过程</summary>

- 这是个边缘建议,不影响功能正确性
- 但参考本仓库 `internal/config/` 下其他时间常量(如 `JwtExpiry` `RefreshTokenTtl`)都已经包级公开 + 通过 `viper.GetDuration` 注入
- 保持一致性会降低后续维护心智负担

不强制改,留作 follow-up 即可。

</details>
```

### 6.5 「无问题」轻量评论模板

```markdown
:white_check_mark: 已审 `internal/auth/sign_verify.go`,未发现需修复的问题。

签名校验流程清晰、负向 case 覆盖到位,可以合并。
```

—— 仅 2 行 + 1 空行,GitLab UI 上不超过半屏,避免视觉噪声。

### 6.6 全 blocker 拦截整体评论模板(N3 配套)

当出现 ≥ 1 个 blocker 时,整体评论顶部加这个 alert 块(GitLab 17.10+ 渲染为红色警示卡片):

```markdown
> [!caution]
> 本次评审发现 **{count} 个 blocker 级问题**,CI 将以非零退出码 fail。修复后请重新 push 触发自动重审。
>
> Blocker 列表:
> - `internal/auth/sign_verify.go:42` — 硬编码 secret
> - `internal/db/migrations/002.sql:7` — 缺索引导致全表扫描
```

---

## 7. Severity emoji 与 label 对照表

| level | emoji(unicode) | emoji(GLFM shortcode) | 触发 CI fail | 使用场景 |
|---|---|---|---|---|
| `blocker` | 🔴 | `:red_circle:` | ✅ | 安全漏洞 / 数据丢失 / 合规硬性违反 |
| `major` | 🟠 | `:large_orange_circle:` | ❌(留作 review) | 明显逻辑缺陷 / 性能问题 / 缺关键日志 |
| `minor` | 🔵 | `:large_blue_circle:` | ❌ | 命名 / 风格 / 可选优化建议 |

**注意**:run.ts 的 `scanForBlockers` 正则匹配 **`[severity:blocker]` 字面量**,不是看 emoji,所以 emoji 可灵活替换,前缀必须保留。

---

## 8. 外部参考(External References)

- [GitLab Flavored Markdown (GLFM)](https://docs.gitlab.com/user/markdown/) — 完整 markdown 特性列表
- [GitLab Suggest Changes](https://docs.gitlab.com/user/project/merge_requests/reviews/suggestions/) — `suggestion` 块语法及多行用法
- [GitLab Alerts](https://docs.gitlab.com/user/markdown/#alerts) — `> [!note]` 等 callout 块(17.10+)
- [GitLab Collapsible Section](https://docs.gitlab.com/user/markdown/#collapsible-section) — `<details>` 折叠用法
- [GitLab Quick Actions](https://docs.gitlab.com/user/project/quick_actions/) — `/approve` `/wip` 等危险命令清单
- [GitHub Alerts](https://docs.github.com/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts) — 跨平台兼容性参考
- [coderabbitai/coderabbit-pr-review PR #102](https://github.com/coderabbitai/coderabbit-pr-review/pull/102) — Walkthrough + inline comment 实测样本
- [RooCodeInc/Roo-Code PR #6326](https://github.com/RooCodeInc/Roo-Code/pull/6326) — Ellipsis bot 极简行内 / PR description alert 用法

---

## 9. 相关内部 spec / 代码引用

- `packages/flower-code-reviewer/src/prompts.ts:33-59` — 当前 prompt 硬约束位置,本次新增的 markdown 样式约束应插入 L48 "## 严格要求" 之后
- `packages/flower-code-reviewer/src/run.ts` — `scanForBlockers` 纯函数(上一任务遗产),依赖 `[severity:blocker]` 字面量
- `packages/flower-tools-gitlab/src/index.ts:62-101` — `gitlab_post_comment` / `gitlab_post_line_comment` 工具签名,body 参数已经标 "Markdown",无需改工具,只改 prompt 即可生效
- `.trellis/spec/flower-tools-gitlab/backend/index.md` — 9 条约定(上一任务沉淀),新增 markdown 样式约束建议沉淀到 `flower-code-reviewer/frontend/index.md`(或新建 `comment-style.md`)

---

## 10. Caveats / 未覆盖项

- 未实测 xhgjdev 内部 GitLab 的具体版本号(decides 是否支持 `> [!caution]` alert 块,17.10+ 才有)
  → **建议在 N2 实施前**让用户去 `http://gitlab.xhgjdev.com/help` 看一眼版本号
  → 若 < 17.10,把 §6.6 的 `> [!caution]` 模板降级成 `> :rotating_light: **拦截**` 形式
- CodeRabbit 的 fingerprint 去重机制(`<!-- fingerprinting:phantom:poseidon:ocelot -->`)本任务**不引入**,因为现有 `gitlab_get_previous_review` 已经做了类似去重(看 bot 历史评论 body)
- CodeRabbit 的 "🤖 Prompt for AI Agents" 折叠块给后续 auto-fix bot 用 —— 与 **sibling 任务 `05-20-code-reviewer-auto-fix-bot`** 强相关,本任务可暂不实施,后续配合 N5 时再加
- 未覆盖:CodeRabbit 的 "Resolve thread" 交互 hint —— GitLab 上对应 "Resolve discussion" 按钮,bot **不需要**主动在评论里写 hint 文案,因为 GitLab UI 自带
