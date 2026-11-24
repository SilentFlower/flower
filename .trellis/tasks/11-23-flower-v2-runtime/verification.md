# Flower v2 共享 pi 运行时本地验收

2026-11-23，`v2` 工作区，HEAD `58141e90`，本地包含已验收的七工作区布局和 pi 1.6.0 升级。验证环境为 Linux、Node.js `22.23.4` 和 npm `10.9.9`。这一里程碑验收时，新增的 ESM 包 `@flower-ai/agent-runtime` 为私有。npm 和 TS 项目图包含三个应用与五个共享包。桌面验证入口由 Node `fork()` 启动。企业 Node 验证入口使用受控服务主体，桌面验证子进程使用受控员工主体。模型、文件和存储均使用本地夹具。 [布局验收](../11-23-flower-v2-layout/verification.md) · [pi 升级验收](../11-23-flower-v2-pi-upgrade/verification.md) · [后续公开分发决定](../11-23-flower-v2/design.md#53-业务接入与发布)

## 同一产物与真实 pi 工具链

| 握手证据 | 结果 |
| --- | --- |
| npm 包与 SDK 版本 | `@flower-ai/agent-runtime@0.1.0`、`pi-agent-core@1.6.0`、`pi-ai@1.6.0` |
| 两端实际解析路径 | `/root/project/flower/packages/agent-runtime/dist/index.js` |
| 两端入口 SHA-256 | `7499312d9757ef09d6ca671ed55c7ee83d617273778d4e268bbbb0ebe9fb60f1` |
| 独立进程与协议 | 企业 Node PID `150359`，桌面 Node 子进程 PID `150751`，IPC 协议 `1` |
| IPC 边界 | 错误协议版本和请求携带的主体覆盖字段均被拒。正常关闭返回确认，子进程退出码为 `0`。 |

两端显式提交同一输入 `读取 src/a.ts`。每端受控模型调用两次，真实 pi `Agent` 执行一次 `gitlab_get_file_content` 的本地只读适配。第二轮模型收到 pi 产生的 `toolResult`，再流式输出相同的第 1–2 行。两端均收到 `queued → started → tool_started → tool_result → text_delta → text_delta → terminal(succeeded)`。测试核对会话、请求、运行 ID 和连续序号。 [企业验证入口](../../../packages/agent-runtime/test/fixtures/enterprise.mjs) · [桌面子进程](../../../apps/desktop/verification/runtime-child.mjs) · [双宿主测试](../../../packages/agent-runtime/test/dual-host.test.ts)

## 排队、取消与授权

两端分别运行下表四个用例。保持 A 的文件读流打开时，B、C 都已入队并收到位置 `1`、`2`。

| 场景 | 两端实测 |
| --- | --- |
| 正常放行 | A、B、C 依序完成。每项终态先于下一项开始。 |
| 按 `runId` 取消 A | 依序观察到正在取消、读流关闭、A 的取消终态，随后 B、C 依序完成。A 已提交的部分文本仍可查询。 |
| 按 `requestId` 取消 B | B 直接以取消结束，C 升到第一等待位，A 后执行 C。 |
| 按 `requestId` 取消 C | C 直接以取消结束，B 仍在第一等待位，A 后执行 B。 |

额外用例覆盖模型等待期间收到中止信号，以及真实 `agent_end` 监听器延迟结束时队首继续等待。撤去会话授权后，排队请求在启动前复核并以 `denied` 结束。恢复授权后可继续显式提交。

首条成功保存的请求将工作区 ID 写入会话快照。同主体同会话从工作区 A 改授 B 时，运行中的取消、排队取消、查询和提交均返回 `denied`。队首再次核验绑定，在 B 授权下以 `denied` 结束，启动事件和模型调用均为零。从同一文件存储重新创建运行时后，四个入口仍返回 `denied`，拒绝期间存储原样保留。B 可另开会话，受控模型只收到 B 的上下文。恢复 A 授权后可回读 A 的原记录。

早期快照通过全部请求一致的工作区 ID 恢复会话绑定，当前授权匹配后才原子补写。旧记录内出现混合工作区时，查询和续问返回存储错误，原数据保留，模型和工具调用均为零。

同一运行时的服务主体与员工主体用相同的 `sessionId` 并发读取相同相对路径。两路分别获得各自的文件内容、模型缓存键、可用工具、事件和历史。实测跨主体查询与取消被拒，指向其他工作区的符号链接与未授权工具调用也被拒。会话记录和 IPC 事件中模型凭据标记出现次数为零。

## 持久化与重启

- 临时文件存储按宿主、主体和会话分区，文件写入后同步并原子替换。注入首次保存失败时，入队事件和模型调用均为零，随后提交可以重试。阻塞终态保存时可回读到 `running`，释放提交后才收到终态。每个分区由一个活动运行时写入。
- 企业入口重新创建后回读原主体的完整历史，恢复时模型与工具计数均为零。只有显式续问才调用模型，并带入上一个完整回合。
- 在桌面子进程运行一项且排队一项时发送 `SIGKILL`。父进程收到对应退出信号。新 PID 从同一存储恢复两个 `interrupted` 状态、已持久化的部分输出、两个已完成回合、交付物引用，以及 `confirmed` 与 `needs-verification` 外部操作记录。显式续问沿用先前完整历史和事件序号。
- 重启前以显式工具调用将外部操作替身计数增至 `1`，重启后的历史读取期间模型、工具和外部操作调用均为 `0`。显式续问只触发一次新读取，外部操作调用仍为 `0`。

## 命令结果

| 命令 | 结果 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 通过，干净安装 293 个依赖。 |
| `npm run clean`、`npm run build`、`npm run build --workspace @flower-ai/agent-runtime` | 通过，根 TS 构建纳入新包，Observer 构建复制静态资源。 |
| `npm run typecheck` | 通过。本次在干净构建后执行，历史 company 分支日志记录的 `TS6310` 在该基线未复现。 |
| `npm run test --workspace @flower-ai/agent-runtime -- test/dual-host.test.ts --reporter=verbose` | 18 项通过。 |
| reviewer 的 `extension.test.ts`、GitLab 工具的 `safe-read.test.ts` | 分别 13 项和 15 项通过。 |
| `npm test` | 38 个测试文件，692 项通过。 |
| 限定目录 Biome、Node 语法检查、`git diff --check` | 通过。应用与共享包的全量 Biome 扫描仅报告 Observer 的既有 `apps/observer/src/routes/pages.ts` 格式问题，与前置验收一致。 |

工作区绑定修复的本机日志保存在 `/tmp/flower-runtime-workspace-binding.Bb3AKU/`，其中 `dual-host.log` 记录上述握手，`full-test.log` 记录全仓回归。安装日志位于 `/tmp/flower-runtime-npm-ci.log`。reviewer、GitLab 的定向日志和全量 Biome 对照位于 `/tmp/flower-runtime-verify.1qkuP9/`。

本阶段验证企业 Node 入口与桌面 Node 子进程。真实企业应用接入、company CI、Windows Electron 安装版、员工双登录及撤权和实际模型访问由后续集成验收。 [父设计第 5.3 节](../11-23-flower-v2/design.md#53-业务接入与发布)
