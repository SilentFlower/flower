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
- [x] 针对 pi 0.76.0 的 shrinkwrap 重复依赖,优化 `flower-code-reviewer` Docker runtime 体积。

## 验证方式

- `npm install --ignore-scripts`
- `npm run build`
- `npm run test --workspace @flower-ai/flower-code-reviewer`
- `npm run test --workspaces --if-present`
- `docker build -f packages/flower-code-reviewer/Dockerfile -t flower-code-reviewer:pi076-runtime-slim .`
- `docker run --rm flower-code-reviewer:pi076-runtime-slim --help`
- `docker run --rm --entrypoint flower-review flower-code-reviewer:pi076-runtime-slim --help`
- `docker run --rm --entrypoint sh flower-code-reviewer:pi076-runtime-slim -lc 'cd /app/packages/flower-code-reviewer && node --input-type=module -e "...import smoke..."'`
- 如 `npm run typecheck` 仍因项目引用 + `--noEmit` 历史问题失败,记录失败原因并以 `npm run build` 作为本任务主要类型验证。

## Docker 镜像优化补充

- 根 `.dockerignore` 排除本地 `node_modules`、`dist`、`*.tsbuildinfo`、`.git`、`.trellis/workspace` 等构建无关内容,本地 build context 从约 548MB 降到约 12KB。
- Docker builder 阶段使用 `tsc --build --force`,避免 `.dockerignore` 排除 `dist` 后,TypeScript 增量状态误判导致容器内没有 `dist/cli.js`。
- runtime 阶段只复制各 workspace 的 `package.json` + `dist`,并额外复制 reviewer `skills`,不再复制源码、测试、README、tsconfig、tsbuildinfo。
- pi 0.76.0 的 `@earendil-works/pi-coding-agent` 自带 `npm-shrinkwrap.json`,会在多个 workspace 下重复安装私有 `node_modules`;runtime 阶段保留一份根级 pi 包,删除 `packages/*/node_modules/@earendil-works/pi-*` 重复副本。
- 最终验证镜像 `flower-code-reviewer:pi076-runtime-slim` 的 Docker `CONTENT SIZE` 为 80.1MB,已低于 pi 升级后观察到的 216.61MB,也略低于历史 82.8MiB。

## 评审关口

- 实施前确认目标 pi 版本。
- 实施后确认工作树 diff 仅包含依赖、Node 基线、观测日志和相关测试。
- 最终说明需列出实际升级版本、Node 要求、验证命令结果。
