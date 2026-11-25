# Windows 实机验收脚本

## Scenario: 用 Playwright `_electron` 在 Windows 上验收候选包

### 1. Scope / Trigger

- 触发：改动涉及原生窗口、通知、右键菜单、关窗、窗口几何、剪贴板或需要真实 Electron 的交互。
- 脚本位于 `apps/desktop/testing/verify-*-windows.mjs`，只在 `win32` 上运行，参数形如 `<正式 EXE> <新证据目录> <Playwright 目录> [...]`。

### 2. Signatures

```bash
# WSL 中打包（npm ci --os=win32），Electron zip 与 SHASUMS256.txt 须为官方 45.3.2
npm run package:windows -w @flower-ai/flower-desktop -- <electron.zip> <SHASUMS256.txt> <D:\…\candidate>
```

```bat
:: run.cmd —— 带空格的 EXE 路径写在批处理里，避免多层转义把参数拆开
node D:\…\testing\verify-xxx-windows.mjs "D:\…\candidate\Flower Desktop.exe" D:\…\%1 D:\…\automation D:\…\orders.xlsx
```

```bash
# 在私有 Win32 桌面运行，不在用户当前屏幕弹窗；运行器脚本要用绝对路径调用
cmd.exe /c "python D:\…\flower-ui-private-desktop.py D:\…\run.log cmd /c D:\…\run.cmd evidence-N"
```

### 3. Contracts

- 观察流式任务时优先通过界面或 Host 的历史入口等待终态。必须并发读取 Windows 会话 JSON 时，使用包含 `FileShare.Delete` 的 Windows 读句柄。WSL 直接打开挂载盘上的文件可使 Windows 的原子替换返回 `EPERM`。
- `writeJson` 在 Windows 替换同目录临时文件遇到 `EBUSY`、`EACCES`、`EPERM` 时，对同一份已刷盘的内容有限重试。持续占用须保留原快照，清理临时文件，并报告保存失败。用 `testing/storage-windows.test.mjs` 覆盖短暂和持续占用；流式场景须核对完整正文、界面终态及重启回读。
- 主进程替身在 `boot()` 里用 `app.evaluate` 安装：`dialog.showOpenDialog` 返回测试目录、`dialog.showMessageBox` 按 `answers` 队列应答并记录、`shell.showItemInFolder` 只记录、`Notification.prototype.show` 记录并监听 `show`/`failed`、`BrowserWindow.prototype.flashFrame` 记录、`Menu.buildFromTemplate` 返回只记录模板并可按标签点击的替身。应用代码从 `"electron"` 导入的是同一对象，替换静态方法或原型即可生效。
- 图片剪贴板验收使用独立 Window Station。Electron 45.3.2 主进程用 `clipboard.write([new ClipboardItem({ "image/png": blob })])` 写入，按 `clipboard.read()` 返回条目的 `types` 及 `getType()` 读回。系统读写保留原始方法，测试直接回读实际 PNG。系统文本读写等待 `readText()`、`writeText()` 的 Promise。
- 自动更新验收用 `package:windows --version <版本> --qa-source <回环清单>` 和 `release:windows` 生成两个完整版本。每个安装场景使用独立的受管理目录和资料目录。Playwright 可连接 `install/versions/<版本>/Flower Desktop.exe`，恢复启动从 `install/Flower Desktop.exe` 进入。检查 `current.txt`、真实新进程的路径和版本，以及原会话正文。配置正式包时省略 `--qa-source`。
- 验收退出时更新须先模拟用户取消关闭，核对旧进程和启动指针。真正退出后验证已切换指针，随后手动双击根入口打开新版。验收立即重启须检查进行中任务门禁、旧进程实际结束、独立助手启动新版和原资料恢复。
- 所有 `page.evaluate`/`app.evaluate` 读取都包一层超时（脚本用 20 秒）；`until()` 轮询有上限。
- 收尾顺序：`catch` 中先 `console.error` 失败原因并设 `process.exitCode`；`finally` 中关闭应用时先把关窗确认答案设为「仍然关闭」，`app.close()` 加超时，超时后 `app.process().kill()`；看门狗在收尾完成后才清除。
- `timeout` 命令在 WSL 侧只能结束 `cmd.exe` 互操作进程，Windows 上的 node 与 Electron 会继续运行；清理时按命令行确认属于本次证据目录后，只按根进程 PID `taskkill /T /F`，不要按进程名或时间范围批量结束（用户自己的 Flower Desktop 也在运行）。

### 4. Validation & Error Matrix

| 现象 | 原因 | 处理 |
|---|---|---|
| 参数整体错位、`Cannot find module 'playwright'` 指向证据目录 | EXE 路径中的空格在 `cmd /c` + python 转发时被拆开 | 用批处理文件传参 |
| `CreateProcessW` 报 WinError 123 | 运行器以相对路径启动，工作目录为空 | 用绝对路径调用运行器 |
| 日志停在某一步、看门狗没触发 | 出错后 `finally` 先清看门狗，`app.close()` 被关窗确认挡住 | 按第 3 节收尾顺序 |
| 私有桌面里 `minimize()` 后 `isFocused()` 仍为 true | 非输入桌面没有真实前台切换 | 在主进程替换 `BrowserWindow.prototype.isFocused` 模拟后台，并在验收记录中注明「模拟」 |
| 打开侧栏后窗口不外扩 | 侧栏已被前面的路径预览打开，再点开关是关闭 | 先确认 `#workspace-panel` 隐藏再打开 |
| `verify-panel-layout-windows.mjs` 第 15 步「重启后左侧展开」`composerWidth` 前后不等；`verify-markdown-windows.mjs` 的 HTML 比对多出 `data-path-pending` | 时序竞态：重启后会话历史尚在读取时 `data-home="false"`，读完空会话翻为首页版式，两次快照落在翻转两侧；Markdown 快照早于回复路径核对完成 | 同一候选包重跑一次；仍失败时在快照里加记 `data-home` 与 `.composition` 内边距判断是否跨版式，并用改动前候选包跑基线，不要据此改布局 |
| 本机没有官方 Electron zip，`package:windows` 无法运行 | 打包脚本要校验官方 zip 的 SHA-256 | 验收时可按打包脚本的同一步骤组装（`npm ci --os=win32`、组装 `workbench` 与 `agent-runtime`、`@electron/asar` 打包），Electron 运行时复制自已验收候选包并核对 `version` 为 45.3.2；在 `verification.md` 写明来源与 ASAR 哈希。正式发版仍用 `package:windows` |
| 脚本在早期断言失败，后续步骤全部未执行 | 产品文案或默认值变化后脚本断言过期；也可能是改动前就存在的漂移 | 逐处修正后重跑直到退出码为 0；判断是否为既有漂移时，用 `git show HEAD:<脚本>` 的旧版本对改动前的候选包跑一次基线，同样失败即为既有漂移 |

### 5. Good / Base / Bad Cases

- Good：私有桌面运行，`第一档验收.json` 记录每项结论，截图与本次 ASAR SHA-256 写入任务 `verification.md`。
- Base：Linux 侧用浏览器夹具（静态托管 `workbench/index.html` 并注入 `window.flower` 替身）检查纯渲染层交互，再到 Windows 补原生部分。
- Bad：在用户桌面直接运行，最小化或关窗影响用户正在使用的窗口；失败后残留进程。

### 6. Tests Required

- 每个验收脚本结束时写出结果 JSON，并在任务 `verification.md` 中逐条对应验收标准。
- 模拟的部分（如后台焦点）在结果文案中标明「模拟」。

### 7. Wrong vs Correct

#### Wrong

```js
} finally {
	globalThis.clearTimeout(watchdog);
	await app?.close(); // 仍有任务时被关窗确认挡住，进程挂起，错误也没打印
}
```

#### Correct

```js
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	if (app) await shutdown(); // 预设「仍然关闭」，close 加超时，超时 kill
	await fixture.close();
	globalThis.clearTimeout(watchdog);
}
```

## 公开发行的安装与升级验收

Windows 首装运行 `verify-release-windows.ps1 -Version <版本> -Assets <制品目录>`。再用 `node apps/desktop/testing/verify-tray-windows.mjs <受管理的安装目录>` 验证实际运行文件和启动器的品牌图标、关窗后的任务完成、恢复窗口、取消退出和真正退出。在隔离桌面使用真实 Electron 托盘并以程序方式触发左键和菜单回调。

升级运行 `node apps/desktop/testing/verify-windows-update.mjs <旧版安装目录> <新版更新目录> <回环清单URL>`。Windows 的 `TEMP` 可含 8.3 用户名，工作台向启动器传入资料目录的真实绝对路径。验收先安排更新并关闭窗口，确认仍使用原版，再显式退出并等待切换版本，最后回读资料。完整的三端验收和稳定频道规则见[开源发版规范](./public-release.md)。
