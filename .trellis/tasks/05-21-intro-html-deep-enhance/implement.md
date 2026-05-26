# implement.md · intro.html 深度增强 · 执行计划

## 0. 执行模式与 sub-agent 协议

本任务采用「**主 agent 编排 + sub-agent 并行调研 / 串行实施**」模式。

### 主 agent 自己做(不派 sub-agent)
- task.py start / finish
- git mv 与 head 微改(Part A 区域唯一修改)
- 派发 sub-agent
- 汇总 sub-agent 产物 + 风格统一打磨
- AC 自检 + commit

### Sub-agent dispatch protocol(适用所有 sub-agent)

每个 sub-agent prompt 起始固定段:

```
Active task: .trellis/tasks/05-21-intro-html-deep-enhance
你要写的内容会被 inline 到 docs/intro.html。读 prd.md / design.md 了解约束(R1-R16, AC1-AC4)。
风格:沿用 intro.html 现有学术手稿调性(serif 标题 / sans 正文 / mono 代码块 / 朱砂-墨绿-琥珀-靛青-紫罗兰 5 色调色板)。
中文为主,术语首次出现「中文(English)」。
```

每个 sub-agent 产物路径必须**写入指定文件**(research/X.md 或 docs/intro.html 的某节占位符),返回 `{file path, one-line summary}`,**不污染**主 context。

## 1. Phase A · git mv + 框架就位(主 agent 串行)

### A.1 创建 docs/ 目录 + 移文件

```bash
mkdir -p docs
git mv intro.html docs/intro.html
```

验证:

```bash
git status        # 应显示 R  intro.html -> docs/intro.html
ls docs/          # 应有 intro.html
git diff -M --stat HEAD docs/intro.html   # 应显示 rename 100%
```

### A.2 head 微改(R8 metadata + TOC 锚点)

读取 `docs/intro.html`,在 `<head>` 内紧跟 `<meta charset>` 后插入 R8 metadata 注释:

```html
<!--
================================================
本文档反映 flower commit <abbrev-sha> (<YYYY-MM-DD>) 的状态快照。
最新源码以 GitHub 主分支为准。
源码 ↔ 文档漂移采取「接受 + 声明」策略,不强制同步。
================================================
-->
```

`<abbrev-sha>` 留占位符 `__COMMIT__`,后面 final step 用 sed 替换。

TOC 锚点扩展(若 intro.html 现有 TOC):新增 Part B 各级条目;若无 TOC,**新建一个 `<nav class="toc">`** 在 `<body>` 顶部。

### A.3 视觉骨架预占位

在文件最末 `</body>` 之前插入 Part B 骨架(空 section 占位 + 视觉分界):

```html
<header class="part-divider" id="part-b">
  <small>Part B</small>
  <h2>工程手册</h2>
  <p>从愿景诗篇进入实现细节。</p>
</header>

<section id="b0-intro"><h2>B0 · 引子</h2><!-- 由主 agent 填 --></section>
<section id="b1-pi"><h2>B1 · pi 框架深度分析</h2>
  <details open><summary id="b1-1">B1.1 API 表面</summary><!-- placeholder --></details>
  <details open><summary id="b1-2">B1.2 内部运作机制</summary><!-- placeholder --></details>
  <details open><summary id="b1-3">B1.3 flower 怎么用 pi</summary><!-- placeholder --></details>
  <details open><summary id="b1-4">B1.4 设计哲学 · 与同类对比</summary><!-- placeholder --></details>
</section>
<section id="b2-packages"><h2>B2 · 7 个 package 详细职责</h2>
  <details open><summary id="b2-1">B2.1 flower-code-reviewer ★</summary><!-- S1-S12 placeholder --></details>
  <details><summary id="b2-2">B2.2 flower-providers</summary><!-- placeholder --></details>
  <details><summary id="b2-3">B2.3 flower-tools-gitlab</summary><!-- placeholder --></details>
  <details><summary id="b2-4">B2.4 flower-tools-common</summary><!-- placeholder --></details>
  <details><summary id="b2-5">B2.5 flower-tools-arms</summary><!-- placeholder --></details>
  <details><summary id="b2-6">B2.6 flower-compliance</summary><!-- placeholder --></details>
  <details><summary id="b2-7">B2.7 flower-ops-bot</summary><!-- placeholder --></details>
</section>
<section id="b3-dataflow"><h2>B3 · 跨包数据流</h2>
  <details open><summary id="b3-1">B3.1 LLM 调用链</summary><!-- placeholder --></details>
  <details open><summary id="b3-2">B3.2 tool dispatch</summary><!-- placeholder --></details>
  <details open><summary id="b3-3">B3.3 observability 旁路</summary><!-- placeholder --></details>
  <details open><summary id="b3-4">B3.4 SIEM 审计</summary><!-- placeholder --></details>
</section>
```

加 Part B 专用 CSS(part-divider / source-ref / package-card 等 class)。

### A.4 添加 grep 验证

`docs/intro.html` 自动 lint:

```bash
grep -E '<script\s+src="https://' docs/intro.html && echo "❌ R2 违规" || echo "✅ 无外部 JS"
grep -E '<link[^>]+rel="stylesheet"[^>]+href="https://' docs/intro.html && echo "❌ R2 违规" || echo "✅ 无外部 CSS"
wc -c docs/intro.html | awk '{ if ($1 > 307200) print "❌ AC1.6 超 300KB"; else print "✅ AC1.6 大小 "$1" bytes" }'
```

## 2. Phase B · 派发 4 个 research sub-agent(并行)

> 主 agent 一条消息里并发 4 个 Agent(subagent_type="trellis-research"),全部跑完再继续。

### R-1 · pi 内部机制
任务:反推 `node_modules/@earendil-works/pi-coding-agent/dist/main.js` + 读 `docs/development.md` + 读 `.d.ts`。
产出:`research/pi-internal-mechanism.md`,包括:
- turn loop 序列描述(turn_start → message_update → tool_call → tool_execution_end → 下一 turn)
- event emit 点(哪个内部函数 emit 哪个 event)
- 每个 event 的 payload 形状(从 d.ts)
- 不确定处明示 `~推测,以源码为准~`

### R-2 · pi vs 同类对比
任务:WebSearch + WebFetch 调研 cursor / cline / aider / claude-code / openai-agents-sdk。
产出:`research/pi-vs-peers.md`,5 × 5 矩阵:
- 形态(框架 vs SDK vs IDE 集成 vs CLI)
- extension 机制
- tool 集成方式(MCP / 内置 / 自定义)
- 目标场景
- 我们(flower)选 pi 的 trade-off

要求:**客观,不踩同行**;讲 trade-off,不讲谁不好。

### R-3 · 6 个 package 内部抽取
任务:读本仓库 `packages/{flower-providers,flower-tools-gitlab,flower-tools-common,flower-tools-arms,flower-compliance,flower-ops-bot}/src/`,每个 package 抽取 5 字段(R13)。
产出:`research/packages-survey.md`,6 节,每节按 design.md §3.2 schema:
- 一句话定位
- 职责
- 边界
- 对外契约(导出的 tool / API / 命令)
- 关键模块(2-4 个文件)
- 与兄弟包关系

### R-4 · 跨包数据流梳理
任务:读本仓库源码 + 配合 R-3 结果,梳理 4 个数据流的实际代码路径。
产出:`research/cross-package-dataflow.md`,4 节:
- B3.1 LLM 调用:reviewer.run → piMain → providers → pi-ai → havefun(列出每步实际文件 + 函数)
- B3.2 tool dispatch:LLM 返回 → pi dispatcher → compliance 前置拦截 → tools-gitlab REST
- B3.3 observability 旁路:event emit → observability listener → stdout(列实际 event 名 + listener 函数)
- B3.4 SIEM 审计:compliance 拦截记录 → POST `SIEM_INGEST_URL`

## 3. Phase C · 派发 implement sub-agent 写 Part B 各节(并行)

待 Phase B 4 个 research 全部完成后,**主 agent 阅读 4 个 research 文件**,然后并行派发 implement sub-agent。

> 注意:不同节有不同 sub-agent。每个 sub-agent 拿到 prd.md + design.md + 对应 research/.md 后,产出该节 HTML 片段,**直接 Edit 到 `docs/intro.html`** 对应 placeholder。

### C.1 主 agent 自己写(短 + 有强叙事性)
- B0 引子(1-2 段过渡文字)
- Part B head 视觉分界 + TOC 锚点连通验证

### C.2 Sub-agent I-B1:pi 框架 4 子节
- 读 `research/pi-internal-mechanism.md` + `research/pi-vs-peers.md`
- 读 `extension.ts` / `observability.ts`(精确源码 dump)
- 写 B1.1 / B1.2 / B1.3 / B1.4 到 `docs/intro.html`

### C.3 Sub-agent I-B2.1:reviewer 节 S1-S12
- 读 `prd.md` R12 列出的 12 子节
- 精确 dump `prompts.ts` §「工作流」7 步全文 → S5
- 精确 dump 6 个 few-shot → S12(第 1 个展开,其余 5 个 `<details>` 折叠)
- env 表对照 `flower-providers/src/env.ts` + `flower-code-reviewer/src/run.ts` 实际读取 → S8
- isLlmFailure 五级 + scanForBlockers 决策树 → S7
- S11 已知局限**校对**:已合并的 sibling(walkthrough-blocker-consistency / flower-providers-default-fallback / reviewer-trace-noise-cleanup)从 known-issues 移除
- S4 10 个源文件:每个文件简介(包括 reviewer-self-tools.ts,原 PRD 漏的)
- 每个 dump 节末加源码链接(R9)
- 写到 B2.1 `<details open>` 内,内部子节按 design.md §1.6 设折叠默认值

### C.4 Sub-agent I-B2.6:其它 6 个 package 短卡片
- 读 `research/packages-survey.md`
- 按 design.md §3.2 5 字段 schema 渲染 6 个 `<details>` 卡片
- 每个 `<summary>` 一句话定位 + 简短摘要
- 写到 B2.2-B2.7

### C.5 Sub-agent I-B3:跨包数据流 4 子节
- 读 `research/cross-package-dataflow.md`
- 每个子节绘制 ASCII art 流程图(参考 design.md §4)
- 必要时加补充说明(为什么这样设计 / 哪些 trade-off)
- 写到 B3.1-B3.4

## 4. Phase D · 主 agent 风格统一打磨

待 Phase C 所有 sub-agent 完成后,主 agent 通读 `docs/intro.html` 一遍,做:

### D.1 风格统一
- 中英文混排空格规则(中文与英文 / 数字之间留空格,与 intro.html 现有一致)
- 术语统一(piMain / Provider / Hook / Extension 大小写一致)
- 代码块语法高亮 class 一致(`<pre class="code-ts">` 等)
- `<aside class="caveat">` 标记不确定内容统一样式

### D.2 视觉打磨
- Part A → B 分界视觉(design.md §1.3 选项 a 大字标题)
- TOC 双层最终确认
- 折叠/展开默认值(R15 / design.md §1.5)逐节核对
- color token 用 intro.html 现有 CSS 变量

### D.3 head 占位符替换
最后一步,把 `__COMMIT__` 占位符替换为实际 commit hash:

```bash
SHORT_SHA=$(git rev-parse --short HEAD)
sed -i "s/__COMMIT__/${SHORT_SHA}/g" docs/intro.html
```

(或用 Edit 工具显式替换,更安全)

## 5. Phase E · AC 自检

逐 AC 核对,标记 ✓ 或 ✗:

```bash
# AC1.1 - 1.7 自动化
git diff -M HEAD~ HEAD -- docs/intro.html | head -20       # 验 rename + 追加
wc -c docs/intro.html                                       # AC1.6 ≤300KB
grep -c '<details' docs/intro.html                          # AC1.7 用 <details>
grep -cE '<script\s+src="https://' docs/intro.html          # 应为 0
grep -cE '<link[^>]+href="https://' docs/intro.html         # 应为 0
```

- AC1.1-1.8 → bash 自动化 + 浏览器人工打开
- AC2.1-2.11 → 人工阅读 + grep
- AC3.1-3.6 → 人工阅读
- AC4.1-4.8 → 人工 reader 视角试答

每个 AC 在 prd.md 对应 checkbox 打勾,失败则回到对应 Phase 补。

## 6. Phase F · finish / commit

### F.1 finish task

```bash
python3 ./.trellis/scripts/task.py finish
```

(或 `task.py archive` 视习惯)

### F.2 commit

按合理粒度拆 commit(或单 commit 也可,因都是 docs/intro.html 一个文件):

```
git add docs/intro.html .trellis/tasks/05-21-intro-html-deep-enhance/
git commit -m "[DOC] flower 文档:intro.html 深度增强(单文件工程手册)" -m "..."
```

不强制 push 远端(由 user 决定)。

## 7. Validation Commands(汇总)

```bash
# 文件大小 + 外部依赖 + 折叠数
wc -c docs/intro.html
grep -cE '<script\s+src="https://' docs/intro.html
grep -cE '<link[^>]+rel="stylesheet"[^>]+href="https://' docs/intro.html
grep -c '<details' docs/intro.html

# git rename 验证
git diff -M HEAD~ HEAD -- docs/intro.html | head -5

# 浏览器打开
xdg-open docs/intro.html 2>/dev/null || open docs/intro.html 2>/dev/null

# AC 检查 prompts 字符级一致(S5 / S12)
diff <(sed -n '/<pre class="prompts-workflow">/,/<\/pre>/p' docs/intro.html | sed 's/<[^>]*>//g') <(grep -A 100 "工作流" packages/flower-code-reviewer/src/prompts.ts)
# 实际命令视实施时具体标记调整
```

## 8. Review Gates

### Gate 1:任务启动前(本 step 是 1.4 的人工 review)
用户检查 prd.md / design.md / implement.md,确认 scope / AC / 实施策略 → 同意后 `task.py start`。

### Gate 2:Phase B 所有 research 回来后
主 agent 读 4 个 research,**汇报「research 摘要 + 是否符合 design.md schema」**,等用户 OK 再进 Phase C。

### Gate 3:Phase C 所有 sub-agent 写完后
主 agent 通读 docs/intro.html,**汇报「目前内容结构 + 已知 gap」**,等用户 OK 再进 Phase D 打磨。

### Gate 4:AC 自检全过后
主 agent **汇报「AC pass list」+ 截图 / 文件 size**,等用户 OK 再 commit。

## 9. Rollback Points

- 任何 Phase 失败,可 `git reset HEAD~` 退回 Phase 起点
- Phase B research 跑偏(比如 R-2 同类对比写得太长 / 不客观),只重派 R-2 不影响其它
- Phase C sub-agent 产出风格不一致,Phase D 打磨修
- 整体失败,`git checkout main && git branch -D doc/code-reviewer-detailed-html`(local-only,无远端影响)

## 10. Time Estimate

- Phase A:5-10 min(主 agent 自己做)
- Phase B:10-20 min(4 sub-agent 并行,等待时间)
- Phase C:30-60 min(多个 sub-agent 串行 + 并行写 HTML 内容)
- Phase D:15-30 min(主 agent 风格打磨)
- Phase E:15-30 min(AC 自检 + 修补)
- Phase F:5 min(commit)

**总计:~1.5-2.5 小时**(取决于 sub-agent 产出质量,实际可能更长)
