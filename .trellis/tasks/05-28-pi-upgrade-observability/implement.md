# 升级 pi 依赖并增强首字耗时观测

## 实施清单

- [x] 确认目标 pi 版本: `0.76.0`。
- [x] 阅读相关 spec: 根工程约束、`flower-code-reviewer` 前后端/包规范、`flower-ops-bot` 后端规范、公共工具包规范。
- [x] 更新所有 workspace 中直接声明的 pi 依赖版本范围。
- [x] 更新根 `engines.node` 到 `>=22.19.0`。
- [x] 评估并更新 Dockerfile Node 镜像标签或文档说明。
- [x] 运行 `npm install` 更新 `package-lock.json`。
- [x] 在 `packages/flower-code-reviewer/src/observability.ts` 中新增首个非空 `text_delta` 计时。
- [x] 调整 turn end 摘要日志,加入中文说明和首字相关字段。
- [x] 更新 `packages/flower-code-reviewer/src/__tests__/observability.test.ts` 覆盖新增指标。
- [x] 运行目标包测试和构建。

## 验证方式

- `npm install --ignore-scripts`
- `npm run build`
- `npm run test --workspace @flower-ai/flower-code-reviewer`
- `npm run test --workspaces --if-present`
- 如 `npm run typecheck` 仍因项目引用 + `--noEmit` 历史问题失败,记录失败原因并以 `npm run build` 作为本任务主要类型验证。

## 评审关口

- 实施前确认目标 pi 版本。
- 实施后确认工作树 diff 仅包含依赖、Node 基线、观测日志和相关测试。
- 最终说明需列出实际升级版本、Node 要求、验证命令结果。
