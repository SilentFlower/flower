# Flower v2 现有项目目录与内容整理

## 目标

开发者打开仓库后能从目录区分可运行的应用和共享库，按 README 找到各应用当前能力、启动命令和验证方法。

## 交付与验收

- [ ] 三个现有应用分别位于 `apps/code-reviewer`、`apps/ops-bot`、`apps/observer`。四个共享包位于 `packages/`，应用资产、测试和 Dockerfile 随应用归位。
- [ ] 删除 `flower-tools-arms` 与 `flower-tools-common` 整包。清除占位工具、注册入口、示例和应用装配。reviewer 保留真实评审工具。ops-bot 保留钉钉收发、流式回复与会话历史。
- [ ] 将 `sanitizeQuickActions` 及原单测移入 `packages/flower-tools-gitlab`。整体和行内评论工具共用包内实现，保留转义行为和工具调用入口。
- [ ] 根 README 给出准确的工作区地图、应用入口和本地开发命令。机器人现行文档与提示词按实际能力编写。日期明确的历史证据保留。
- [ ] npm 与 Trellis 均发现七个工作区包，npm 锁文件、TypeScript 和 Docker 均已清除已删除包的引用。保留的包名与 CLI 命令继续工作。干净安装、构建、类型检查和回归可复核。仓外可用评审清单与 Observer 资源，GitLab 两个评论工具的出站正文通过转义验证。
- [ ] 在本地核对三个镜像的构建与入口。公司分支专属 CI 记录需要配套切换的路径，正式发布另行安排。

共享 pi 核心、新 Desktop 和登录功能在整理完成后进入各自任务。本轮聚焦现有应用、共享库、文档和构建路径。
