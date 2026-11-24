# 共享 pi 运行时实施清单

目标是在目录与内容整理完成后，取得父设计第 5.2 节的 Node 双宿主证据。以整理后的应用路径作为实现和验收基线。下文标明现有命令与待新增的包目录、脚本和测试入口。 [前置布局任务](../11-23-flower-v2-layout/prd.md) · [子任务设计](design.md) · [父设计第 5.2 节](../11-23-flower-v2/design.md#52-共享核心双宿主验证) · [运行时 PRD](prd.md)

## 实施顺序

1. **确认布局后的基线**。以当前 `v2` 工作区和[目录整理验收记录](../11-23-flower-v2-layout/verification.md)的七个包为基线，分别记录 HEAD 和本地布局状态，以及 Node、npm 和 pi 的版本。核对 `apps/code-reviewer`、`apps/ops-bot` 和 `apps/observer` 的工作区及 TS 入口。用 `apps/code-reviewer/src/__tests__/extension.test.ts` 和 tools-gitlab 的行窗测试固定 `gitlab_get_file_content` 的只读输入与输出。`src/a.ts` 是临时评审工作区内的样例相对路径。GitLab、模型网关及员工授权使用受控夹具。
2. **接入工作区包**。在 `packages/agent-runtime/` 增加 ESM `package.json`、`tsconfig.json` 和 `src/index.ts`。利用布局整理后的 `packages/*` 发现包，更新根 TS reference 和 lockfile，并以 `apps/*` 中的新应用路径运行回归。沿用前置升级验收的 `1.6.0` 并固定两个运行时 pi 依赖。公开入口至少覆盖提交、两种取消、查询和宿主依赖注入。测试放在 `test/`，构建输入限定 `src/`。
3. **接入真实 pi 和两宿主**。在 `packages/agent-runtime/test/fixtures/` 提供共用受控模型、两个主体、事件和文件存储夹具。企业测试直接从已构建包导入。`apps/desktop/verification/runtime-child.mjs` 同样导入包，作为 `fork()` 的真实子进程入口。由 `packages/agent-runtime/test/dual-host.test.ts` 驱动两端测试，校验 IPC 握手、独立 PID、构建指纹和版本。在测试结束、退出或超时时回收子进程及临时数据。
4. **实现并验证串行、取消和恢复**。记录队列与运行的归属。等待上一运行实际结束后再复核并提升队首。读文件工具用 `node:fs.createReadStream()` 传入中止信号，以确定性闸点在实际读到首块数据后等待测试指令。收到取消后确保工具退出和文件关闭，避免依赖大文件或固定睡眠制造时序。恢复从本次测试的临时存储重新加载，验证模型与外部写入调用数。
5. **复核并交接证据**。先构建，再跑双宿主用例、工作区回归与类型检查。记录两边的构建指纹、解析版本、可核对的事件顺序、退出/重启结果和测试摘要。若 1.6.0 出现兼容问题，用最小用例定位并核对适配方式。真实业务入口、company 分支 CI 和 Windows 安装版进入后续集成。

## 验证矩阵

| 用例 | 操作与通过条件 |
| --- | --- |
| 同产物、真实工具 | 两宿主记录匹配的包版本、入口路径及构建指纹，桌面 PID 与父进程不同。受控模型发出只读工具调用，由 pi 真正执行。第二轮读取工具结果后流式回答。验证文本增量、工具开始、带内容的工具结果和一次终态，核对序号与归属。 |
| 同会话 A、B、C | A 读取首块数据后停在闸点，提交 B、C，观察位置 1、2。正常放行时依次执行 A、B、C。每次用新会话验证一条取消分支。取消 A 用 `runId`，等待 A 停止和最终事件后执行 B、C。取消 B 用 `requestId`，A 结束后执行升为队首的 C。取消 C 用 `requestId`，A 结束后执行仍在队首的 B。验证权限在启动前再次读取，失效项可见地结束。 |
| 运行中取消与再次请求 | 收到工具开始及首块读取的夹具通知后发取消。观察正在取消、读流关闭、pi 空闲、取消终态及下一请求开始的顺序。取消后能完成下一次正常工具读取。额外让一个 `agent_end` 监听器暂缓完成，证明队首在真正空闲前保持等待。 |
| 双主体隔离 | 服务主体和员工主体同时使用相同 `sessionId` 及相对路径。用不同标记及文件内容检查各自模型上下文、可用工具、结果和事件。让同一进程内的两个主体尝试相互查询或取消，验证拒绝。由各自合法身份继续操作，结果按归属交付。 |
| 恢复与外部写入 | 完成一个回合后，重建企业运行时并重启真实桌面子进程，沿用同一临时存储。在恢复后显式提交后续输入，让受控模型核对已提交历史。另以受控等待项、运行项及写入记录验证中断展示和记录读取，恢复阶段模型、工具和外部写入计数均为零。换主体读取相同会话 ID 得不到另一主体的记录。 |
| IPC 退出 | 验证协议版本核对及正常关闭。在 A 运行和 B 排队时终止子进程。父进程报告中断并回收旧进程。新子进程读取已有存储，A、B 都显示中断，已完成会话仍可恢复。 |

## 命令与证据边界

现有根命令和工作区脚本在整理后的布局运行。reviewer 按 npm 包名选中 `apps/code-reviewer/package.json` 的脚本。根测试前先构建，以便解析工作区的 `dist` 导出。根 `npm run check` 调用 Biome 的写入模式，核对本阶段时可用同一已安装工具限定检查目标。 [根脚本](../../../package.json) · [GitLab 工具测试脚本](../../../packages/flower-tools-gitlab/package.json) · [Biome 配置](../../../biome.json)

```bash
node --version
npm --version
npm ci
npm run build
npm run typecheck
npm run test --workspace @flower-ai/flower-code-reviewer -- src/__tests__/extension.test.ts
npm run test --workspace @flower-ai/flower-tools-gitlab -- src/__tests__/safe-read.test.ts
npm test
```

**`npm run typecheck` 验证说明**。历史 `company` 分支的 `.trellis/workspace/silentflower/journal-1.md` 第 742 行记录了 `tsc --build --noEmit` 报 `TS6310` 并污染增量构建缓存的情况。以布局整理完成时对七个工作区执行的干净安装和构建记录为基线，按相同顺序记录它与运行时待验版本的退出码和诊断。若重现同一缺陷，单列 `typecheck` 失败结果。确认根 TS references 包含 `packages/agent-runtime` 后，用现有根脚本依次执行 `npm run clean` 和 `npm run build`，以干净的 `tsc --build` 结果核验类型。失败运行留下的增量缓存不得计作通过证据。

下列命令以新工作区文件及脚本已落地为前提。新增包脚本 `build` 用 `tsc --build tsconfig.json`，`test` 用 Vitest `vitest run`。先更新锁文件，再执行干净安装与构建，随后运行双宿主测试和限定目录的检查。

```bash
npm install --package-lock-only
npm ci
npm run build --workspace @flower-ai/agent-runtime
npm ls --workspace @flower-ai/agent-runtime @earendil-works/pi-agent-core @earendil-works/pi-ai --all
npm run test --workspace @flower-ai/agent-runtime -- test/dual-host.test.ts
npm exec -- biome check packages/agent-runtime apps/desktop/verification
```

本阶段的交付证据来自 Node 企业入口和真实 Node 子进程。Windows 安装版单独记录实际 Electron 进程启动、员工双登录、取消与撤权、企业模型调用、交付物和重启恢复。 [父设计业务接入与发布](../11-23-flower-v2/design.md#53-业务接入与发布)
