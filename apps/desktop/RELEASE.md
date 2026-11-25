# Flower Desktop 的公开发行

维护发布流程时，标签、三端验收、稳定频道和故障恢复遵循[桌面发版规范](../../.trellis/spec/flower-desktop/frontend/public-release.md)。

Windows x64 首次安装可下载 `*-win32-x64-setup.exe`，安装向导支持自选空文件夹或已有的 Flower Desktop 安装目录，默认勾选创建桌面快捷方式。也可从开始菜单启动。便携用户可下载 `*-win32-x64-portable.zip`，完整解压后双击顶层的 `Flower Desktop.exe`。两种安装方式使用同一个 Windows 稳定更新频道。

Windows 从 0.1.6 起，点窗口右上角的 × 会将工作台收到系统托盘。后台任务继续执行。单击通知区域里的 Flower 图标可以恢复窗口，右键选择「退出 Flower」可以结束程序。已安排在退出时安装的更新会在这一步应用。

macOS 免费分发版提供 `*-darwin-arm64-manual.dmg`（Apple Silicon）和 `*-darwin-x64-manual.dmg`（Intel）。打开 DMG 后把应用拖入“应用程序”。此版使用临时签名，首次打开可能提示无法验证开发者；确认下载来源后可按 Apple 的单应用打开流程操作。升级时退出旧版，用同架构新版 DMG 替换应用。启用 Developer ID 正式签名渠道的版本另提供原生自动更新。[GitHub Releases](https://github.com/SilentFlower/flower/releases) · [Apple 打开说明](https://support.apple.com/zh-cn/102445)

## 构建预演

提交针对开源 `v2` 或 `main` 的 Desktop 或共享核心 PR 后，GitHub Actions 按该提交工作流的 `RELEASE_TARGET` 选择平台。`windows` 只构建 Windows x64，`all` 另构建两种原生 Mac 架构。工作流进入默认分支后，还可在 Actions 的「Flower Desktop 发行」页面用 Run workflow 填写预演版本。成功后在该次运行的 Artifacts 获取本轮平台的制品。Mac 预演具有独立应用身份，正式更新使用 Developer ID 签名的应用。

## 发布一个版本

1. 将要发布的 Desktop、共享核心和工作流组成一个已推送的开源提交。版本号采用递增的三段数字。核对准备发布的 SHA，与 PR/预演验收的内容一致。
2. 仅当 `RELEASE_TARGET=all` 时，在 **SilentFlower/flower** 的 Settings → Secrets and variables → Actions 配置下表五个仓库 Secrets，供正式 Mac 组包使用。保管好证书和私钥；它们用于后续版本的签名验证。Windows 作业使用 GitHub 自带的运行令牌。
3. 在目标提交打上 `flower-desktop-vX.Y.Z` 标签，然后推送该标签。下面的版本号仅作示例。

   ```sh
   git tag -a flower-desktop-v0.1.5 <已核实的提交SHA> -m "Flower Desktop 0.1.5"
   git push origin refs/tags/flower-desktop-v0.1.5
   ```

4. 在 Actions 核对本轮选定的平台均通过后，工作流发布对应标签的版本页，附上首装包、更新 ZIP 和 `SHA256SUMS.txt`。首次发布会另外建立固定的 `flower-desktop-stable` Release。版本页的更新 ZIP 可恢复单个版本的稳定频道投放。

| Secret | 用途 |
| --- | --- |
| `MAC_CERTIFICATE_P12` | Developer ID Application 证书及私钥导出的 PKCS#12，内容为 Base64 |
| `MAC_CERTIFICATE_PASSWORD` | 解锁该 PKCS#12 |
| `APPLE_TEAM_ID` | Developer ID 所属团队的十位 ID |
| `APPLE_ID` | Apple 公证账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 公证账号的应用专用密码 |

## 更新与重试

Windows 版本的更新说明可写在 `apps/desktop/release-notes/X.Y.Z.txt`。发行作业将对应版本的文字放入稳定清单，旧客户端可在「应用更新」中阅读。

Windows 首装 ZIP 含顶层启动器、版本指针及运行目录。稳定频道的 Windows 更新 ZIP 只含一个版本的载荷。0.1.4 客户端继续读取 `flower-desktop-stable/flower-desktop-update.json`。应用自动下载校验，用户可立即重启或安排退出安装。流水线从首装 ZIP 启动真实程序，并用两个回环版本演练旧应用后台下载、退出安装和重开资料。

Mac 的 DMG 用于首次安装。应用内由 Electron 的原生 Squirrel 更新器按架构读取 `flower-desktop-mac-arm64.json` 或 `flower-desktop-mac-x64.json`，下载同一架构且签名匹配的应用 ZIP。正式标签构建会校验签名、公证票据，另以隔离身份演练两版签名应用的真实升级。原生更新就绪后，可立即重启或在正常退出时应用。

本轮平台制品以及汇总核验全部成功后才进入发布作业。版本化更新包先上传并核对远端摘要，再逐个替换本轮平台的频道清单。Windows 单独发布时只推进 `flower-desktop-update.json`。若中途出错，在同一标签上重新运行失败作业即可。已发布版本作为重试时的制品来源；更高版本已经到达稳定频道后，较旧版本的发布会被拒绝。稳定 Release 的清单需要可编辑，仓库开启强制不可变 Release 前需先迁移固定频道地址。

## 补发首装包

版本页公开后，安装包工作流会从该版本的便携 ZIP 制作 Windows EXE，从原始源码标签构建两种免费 Mac DMG。已开启正式 Mac 更新的版本只补 Windows EXE。对历史版本可推送 `flower-desktop-installers-vX.Y.Z` 补发，首装包摘要另列于 `INSTALLER-SHA256SUMS.txt`。现有版本标签及更新清单继续使用原有内容。只修订 Windows 安装界面时使用 `flower-desktop-setup-vX.Y.Z-rN`：版本页将主下载链接指向通过验收的 `setup-rN.exe`，并附独立 `.sha256` 文件。

npm 库继续使用仓根的 Changesets 流程。桌面应用的版本由标签传给打包程序。
