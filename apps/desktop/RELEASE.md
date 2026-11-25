# Flower Desktop 的公开发行

维护发布流程时，标签、三端验收、稳定频道和故障恢复遵循[桌面发版规范](../../.trellis/spec/flower-desktop/frontend/public-release.md)。

Windows x64 用户下载版本页的 `*-win32-x64-portable.zip`，完整解压到可写目录，双击顶层的 `Flower Desktop.exe`。0.1.5 仅发布 Windows x64。启用 Mac 发行时，Apple Silicon 下载 `*-darwin-arm64.dmg`，Intel Mac 下载 `*-darwin-x64.dmg`，打开后把 Flower Desktop 拖进「应用程序」。关闭磁盘映像后从「应用程序」启动，保留同一系统用户的资料目录。[GitHub Releases](https://github.com/SilentFlower/flower/releases)

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

Windows 首装 ZIP 含顶层启动器、版本指针及运行目录。稳定频道的 Windows 更新 ZIP 只含一个版本的载荷。0.1.4 客户端继续读取 `flower-desktop-stable/flower-desktop-update.json`。应用自动下载校验，用户可立即重启或安排退出安装。流水线从首装 ZIP 启动真实程序，并用两个回环版本演练旧应用后台下载、退出安装和重开资料。

Mac 的 DMG 用于首次安装。应用内由 Electron 的原生 Squirrel 更新器按架构读取 `flower-desktop-mac-arm64.json` 或 `flower-desktop-mac-x64.json`，下载同一架构且签名匹配的应用 ZIP。正式标签构建会校验签名、公证票据，另以隔离身份演练两版签名应用的真实升级。原生更新就绪后，可立即重启或在正常退出时应用。

本轮平台制品以及汇总核验全部成功后才进入发布作业。版本化更新包先上传并核对远端摘要，再逐个替换本轮平台的频道清单。Windows 单独发布时只推进 `flower-desktop-update.json`。若中途出错，在同一标签上重新运行失败作业即可。已发布版本作为重试时的制品来源；更高版本已经到达稳定频道后，较旧版本的发布会被拒绝。稳定 Release 的清单需要可编辑，仓库开启强制不可变 Release 前需先迁移固定频道地址。

npm 库继续使用仓根的 Changesets 流程。桌面应用的版本由标签传给打包程序。
