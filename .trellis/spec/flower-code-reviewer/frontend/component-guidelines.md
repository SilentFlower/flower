# Component Guidelines

> 入口模块的拆分、签名约定与"组件级"等价物。

---

## Overview

本项目无 UI 组件。本目录里的"component"指 **入口模块 / 顶层导出单元**:
`cli.ts`、`run.ts`、`extension.ts`、`prompts.ts`、`skill-selector.ts` 这一层。

它们的共同特征:

- 被外部直接调用(CLI 用户 / pi 框架 / 其他模块)
- 有明确的入参出参契约
- 必须包含 JSDoc(全部公开 API 都必须有中文 Javadoc 风格注释)

---

## Component Structure

### 标准入口模块结构

```typescript
/**
 * 一句话概述模块用途。
 *
 * 设计要点:
 * 1. ...
 * 2. ...
 */

import { ... } from "node:fs";          // node: 内置在前
import { ... } from "@earendil-works/..."; // 上游 pi 包次之
import { ... } from "@flower-ai/...";    // 项目内共享层
import { ... } from "./local.js";        // 本包内相对路径,**.js 后缀必须保留**

/**
 * 导出类型放最前,便于阅读
 */
export interface CliArgs { ... }

/**
 * 主导出函数
 *
 * @param argv - process.argv.slice(2) 之后的数组
 * @returns 解析后的参数对象
 */
export function parseArgs(argv: string[]): CliArgs { ... }

// 私有 helper 放最后
function printHelp(): void { ... }
```

### 关键点

- **ESM**:`"type": "module"`,本地相对 import 必须带 `.js`(即使源码是 `.ts`)
- **导出顺序**:类型 → 主函数 → helper
- **JSDoc 必填**:每个 `export function` / `export interface` / `export class` 都要有中文 JSDoc
- **`@param` / `@returns`**:复杂参数必写;入参就一个原始类型可以省略 `@param`,但 `@returns` 仍建议保留

---

## Props Conventions

入口模块的"props"等价物是**函数参数**。约定:

### 1. 参数对象优先

```typescript
// ❌ 位置参数多于 2 个
export function runReview(mrIid: number, skill: string, dryRun: boolean): Promise<ReviewResult>

// ✅ 单个 input 对象
export function runReview(args: CliArgs): Promise<ReviewResult>
```

### 2. Optional 用 `T | undefined`,不用 `?`(参数级)

项目 `tsconfig` 里 `exactOptionalPropertyTypes: false`,但仍建议显式写 `T | undefined`,避免类型推断分叉。

### 3. 不要把 `process.env` / `console` 当隐式入参

```typescript
// ❌ run.ts 直接读环境变量,测试无法注入
function runReview(args) {
  const mrIid = process.env.CI_MERGE_REQUEST_IID;
}

// ✅ 在 args.ts 解析,run.ts 只接收解析后的值
//    `runReview(args: CliArgs)` 内部只通过 args 拿配置
```

例外:**CI 注入的标准 GitLab 变量**(`CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID`)可以在最贴近使用处读,因为这些是 CI 契约,不会在测试外部出现。

---

## Styling Patterns

不适用(无 UI)。代码风格统一走 `biome.json`:Tab 缩进、双引号、加分号、trailing comma。

---

## Accessibility

CLI 的"可访问性"=**对人类操作员友好**:

- `--help` 必须列出所有参数、环境变量、典型用法(参考 `src/args.ts:56-74`)
- 错误信息要给**原因 + 下一步**,例如:
  ```
  ❌ "未指定 MR IID,且 CI_MERGE_REQUEST_IID 环境变量也没有"
  ✅(更好) "未指定 MR IID。请通过 --mr-iid <N> 或 CI_MERGE_REQUEST_IID 环境变量传入"
  ```
- 日志前缀统一 `[code-reviewer]`,便于 CI 日志检索
- 退出码语义固定:
  - `0` 评审完成,无 blocker
  - `1` 有 blocker(让 pipeline fail)
  - `2` 程序异常(参数错、环境缺等)

---

## Common Mistakes

- ❌ 把 `pi.on("tool_call", ...)` 注册写在 `runReview` 里(每次调用重复注册,事件会被触发多次);必须放在 `extension.ts` 的 factory 函数里,框架保证只调用一次
- ❌ 在 `prompts.ts` 里把 prompt 拼成模板字符串后再 `.replace(...)`(易写错);用 ${} 直接插值即可
- ❌ 修改 `skill-selector.ts` 的策略时,忘了更新 `args.ts` 中 `--help` 文档里列出的 skill 名称
- ❌ 在 `extension.ts` 里改变注册顺序(provider → compliance → tools 的顺序是契约,改了运行时会找不到 model 或 compliance 拦截不生效)
