# 现有目录与内容整理设计

在当前 `v2` 工作区执行三次机械路径迁移。目标路径见 [PRD](prd.md)。包目录名与 npm 包名独立，保留 `@flower-ai/flower-*`、`flower-review` 和 `flower-ops-bot` 等消费入口。应用内部维持原有源码、测试及资源组织。本阶段不会创建空的 Desktop 或运行时目录。

根工作区从 `apps/*` 和 `packages/*` 发现三个应用与四个共享包。更新锁文件链接、根与包内 TS references、清单中的路径、Trellis 的包注册及现行规范的有效引用。Git 日志、归档任务和注明基线的历史材料按原日期解释。三个 Dockerfile 按新构建上下文复制依赖和启动资源，检查 reviewer 的依赖解析及 PATH wrapper、Observer 静态资源、ops-bot 引用的 providers，以及 `.dockerignore` 对新位置的覆盖。

移除两个占位搜索与 ARMS 工具。将 `sanitizeQuickActions` 和原单测迁入 GitLab 包，整体和行内评论工具用同一个包内模块转义正文。调用方继续从 GitLab 的包根入口使用评论工具。删除 `flower-tools-arms` 和 `flower-tools-common` 的目录、活动配置与依赖。reviewer 镜像的 Flower 库依赖是 GitLab、providers、compliance 和 telemetry。

ops-bot 以会话 ID 恢复历史，使用配置模型生成回复。webhook、签名、会话推送和存储链路继续使用原入口。移除工具转换与装配，镜像的 Flower 共享依赖只保留 providers。提示词以消息与历史为依据，在需要时请用户提供已脱敏信息。

根 README 放置现行能力、目录、开发命令和应用链接，具体运行参数归属各包 README。依照实际能力更新当前简介。保留 `docs/intro.html` 注明日期的设计和源码样例。

公司 CI 定义取自公司分支。后续将布局同步到公司集成线时，对应调整路径筛选、镜像构建的 SUB_DIR 和 Observer 部署清单路径。验收和回退按目录迁移变更与现有应用版本对照。
