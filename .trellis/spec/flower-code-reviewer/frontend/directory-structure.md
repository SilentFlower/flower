# Directory Structure

> `@flower-ai/flower-code-reviewer` 的目录布局与文件职责。

---

## Overview

`code-reviewer` 是一次性 CLI:CI pipeline 触发后,跑完发评论就退出。
代码组织围绕 "解析参数 → 选 skill → 跑 pi → 发评论" 这条主流程展开。

---

## Directory Layout

```
apps/code-reviewer/
├── src/
│   ├── cli.ts              # 可执行入口,只做参数解析 + 顶层 try/catch
│   ├── args.ts             # CliArgs 类型 + parseArgs(argv)
│   ├── run.ts              # 评审主流程、MR 上下文、prompt 和结果判定
│   ├── review-execution.ts # 共享运行、SDK 会话和软超时
│   ├── project-trust.ts    # SDK 资源预加载时的用户信任决定
│   ├── extension.ts        # pi 扩展工厂:注册 provider/compliance/tools
│   ├── prompts.ts          # 评审 prompt 模板(读 skill 文件后拼接)
│   └── skill-selector.ts   # 按文件类型自动选 skill 的策略
├── skills/                 # 评审清单(skill 文件,运行时 readFileSync)
│   ├── general.md
│   ├── backend.md
│   ├── frontend.md
│   └── security.md
├── dist/                   # tsc 构建产物(git ignore)
├── Dockerfile              # 容器构建,基础镜像 node:22
├── package.json
├── tsconfig.json
└── README.md
```

---

## Module Organization

### 入口层(对外可见)

- `cli.ts`:**只**负责把 `process.argv` 喂进 `parseArgs`,把结果交给 `runReview`,然后 `process.exit(result.exitCode)`。**不写业务逻辑**。
- `args.ts`:**纯函数 + 类型定义**,不读 fs / network / env,只解析数组。`--help` 直接 `process.exit(0)`。

### 主流程

- `run.ts` 编排评审。解析输入后提交共享运行，等待终态，扫描评论并决定退出码。GitLab 调用复用 `@flower-ai/flower-tools-gitlab`。
- `extension.ts` 注册 pi 扩展，顺序为 provider、telemetry、compliance、试跑写入门禁、GitLab、自审与评审 trace。

### 辅助

- `prompts.ts`:**prompt 模板**。读 skill 文件 + 拼装 → 返回字符串。强约束(severity 三档、必须用工具发评论)写死在模板里。
- `skill-selector.ts`:**纯策略**。优先匹配安全模式,其次按文件后缀比例选 backend / frontend / general。

### 资产

- `skills/*.md`:**评审清单**。`prompts.ts` 通过 `readFileSync` 读取。新增 skill = 新增 markdown + 在 `args.ts` 的帮助文档里登记。

---

## Naming Conventions

- **文件名**:`kebab-case.ts`(`skill-selector.ts`)
- **导出函数**:`camelCase`(`parseArgs`、`runReview`、`pickSkill`)
- **导出类型**:`PascalCase`(`CliArgs`、`ReviewResult`、`BuildPromptInput`)
- **环境变量**:全大写下划线(`CI_PROJECT_ID`、`LLM_API_KEY`)
- **GitLab CI 注入变量**:沿用 GitLab 官方命名(`CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID`),不要重命名
- **skill 文件**:小写,与 `pickSkill()` 返回值一致(`general` / `backend` / `frontend` / `security`)

---

## Examples

- 一个干净的入口分层样例:`src/cli.ts:14-24`(只做 parse + run + exit + 顶层 catch)
- pi 扩展工厂的注册顺序:`src/extension.ts:19-24`
- prompt 中"必须用工具"的硬约束:`src/prompts.ts:33-58`

---

## 反模式

- ❌ 在 `cli.ts` 里写 try/catch 又自己处理业务异常(顶层只该捕获并打日志退出)
- ❌ 在 `run.ts` 里直接 `fetch` GitLab API,绕过工具(评审意见必须经过 `gitlab_post_*` 工具,以便 compliance 拦截 + 审计)
- 工具在 `extension.ts` 同步注册，SDK 会话在加载扩展后绑定生命周期。
