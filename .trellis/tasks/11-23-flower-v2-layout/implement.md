# 整理步骤与验证

1. 在 `v2` 记录整理前九个包的 name、公开入口、资源、构建与测试结果。盘点版本控制内的路径引用，包括隐藏模板和 Trellis 包配置。
2. 将三个应用逐个移入 `apps/`。同步根及应用配置、内部依赖闭包、包清单链接、Docker 路径、Trellis 包发现和工作区锁文件。核实 ops-bot 构建时包含实际使用的 providers。
3. 清除两个占位工具包的注册、ops-bot 的空工具装配及提示词中的伪查询能力。将 `sanitize.ts` 和 `sanitize.test.ts` 移至 GitLab 包，由整体和行内评论工具导入同一个包内模块。删除 ARMS 和 Common 包目录及其活动引用，清理锁文件、TS 引用、reviewer 镜像的 COPY 和 Trellis 包登记。同步环境样例、README、规范和现行导航，保留历史材料。
4. 运行 `npm ci`、`npm run clean`、`npm run build`、`npm run typecheck` 和 `npm test`。根类型检查如复现既有 TS6310，单列并用清理后完整的 `tsc --build` 核验。使用 `npm query .workspace` 和 `python3 .trellis/scripts/get_context.py --mode packages` 对照七个 workspace。核对清单、锁文件、TS、Docker 和 Trellis 的实际依赖图。
5. 对七个包 dry-run 并实际打包。仓外安装 tarball 后验证 CLI、评审清单和 Observer 静态资源。通过 GitLab 包根调用整体和行内评论工具，在本地拦截出站请求并检查正文转义与普通文本保留。
6. 分别以仓库根为上下文构建三个镜像。验证 reviewer 默认入口、PATH wrapper、评审清单和最终镜像中的 GitLab、pi 依赖解析。验证 Observer 健康接口及页面资源、ops-bot 健康接口。使用本地模型和钉钉回调替身核对机器人收发、会话历史和模型请求。记录结果及后续公司 CI 路径配套。
