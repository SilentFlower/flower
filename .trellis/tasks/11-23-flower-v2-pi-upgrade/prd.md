# Flower v2 升级 pi 稳定版

## 目标

现有企业服务和计划中的共享核心统一采用 2026-11-23 查询到的 npm 稳定版 1.6.0。旧工作区基线为 0.76.0，宿主 Node 最低版本为 22.19.0。

## 交付和验收

- 七工作区中所有直接使用 pi 的包固定采用同组稳定版本，干净安装后以实际锁文件及运行时解析核验。新核心按同组版本规划。
- 在真实 pi 入口使用本地受控模型及测试替身，核验 reviewer 扩展注册、GitLab 两种评论、合规拦截、遥测、网关失败行为及退出码。钉钉机器人覆盖旧会话读回、流式消息、模型选择及已有网关协议。
- 对照七包基线复核干净安装、全仓构建、类型、测试、独立安装包和镜像实际运行层。保持本轮为本地依赖升级，Desktop 安装与公开制品发布在各自阶段处理。

## 版本证据

npm 于 2026-11-20 发布 1.6.0。此次固定核验版本以保证可复现。[pi-ai](https://registry.npmjs.org/@earendil-works/pi-ai/1.6.0) · [pi-agent-core](https://registry.npmjs.org/@earendil-works/pi-agent-core/1.6.0) · [pi-coding-agent](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.6.0)
