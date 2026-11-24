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

- 主进程替身在 `boot()` 里用 `app.evaluate` 安装：`dialog.showOpenDialog` 返回测试目录、`dialog.showMessageBox` 按 `answers` 队列应答并记录、`shell.showItemInFolder` 只记录、`Notification.prototype.show` 记录并监听 `show`/`failed`、`BrowserWindow.prototype.flashFrame` 记录、`Menu.buildFromTemplate` 返回只记录模板并可按标签点击的替身。应用代码从 `"electron"` 导入的是同一对象，替换静态方法或原型即可生效。
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
