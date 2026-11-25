# Flower Desktop 开源发版规范

本规范约定 `SilentFlower/flower` 如何把一个源码提交发布为 Windows x64、Apple Silicon 和 Intel Mac 三个平台的正式版本，以及已安装的客户端如何找到对应更新。维护者打标签和配置凭据的具体步骤见[发行操作说明](../../../../apps/desktop/RELEASE.md)。

工作流的 `RELEASE_TARGET` 与源码标签一同固定。0.1.5 采用 `windows`，只推进 Windows x64 的稳定更新。免费 Mac DMG 使用手动安装渠道。`all` 表示同时投放 Windows 和两种 Mac 架构，并启用 Apple 签名和公证验收。

## 触发与版本

| 入口 | 版本来源 | 结果 |
| --- | --- | --- |
| 向 `main` 或 `v2` 提 PR，变动涉及 Desktop、共享运行时、根锁文件或桌面发行工作流 | 固定预演版本 `0.0.1` | 在 Actions 提供本轮平台的构建制品 |
| 手工运行 `workflow_dispatch` | 输入 `version`，默认 `0.0.1` | 预演指定版本，制品保存在该次运行 |
| 向开源仓库推送 `flower-desktop-vX.Y.Z` 标签 | 从标签提取 `X.Y.Z` | 通过选定平台验收后发布版本页并推进稳定频道 |

版本号的每一段为 1 到 8 位十进制数字，允许单独的 `0`。带前导零或预发布后缀的值会在构建前被拒绝。桌面标签独立于 npm Changesets。发布器按远端标签解析出的完整提交 SHA 核对本次构建。[工作流定义](../../../../.github/workflows/desktop-release.yml)

## 构建与签名

Windows x64 在 `windows-2022` 构建，Mac arm64 和 x64 分别在 `macos-15` 和 `macos-15-intel` 原生构建。三个作业从根锁文件安装依赖，构建共享运行时，并使用 Desktop 的 `config.electronVersion` 打包。

Mac 预演使用独立的 `.preview` 应用身份，客户端更新功能关闭。正式标签构建设置 `FLOWER_MAC_REQUIRE_SIGNING=1`，使用 Developer ID Application 签名并完成 Apple 公证。证书来自 `MAC_CERTIFICATE_P12` 和 `MAC_CERTIFICATE_PASSWORD`，团队和公证账号来自 `APPLE_TEAM_ID`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`。签名升级演练使用独立的 `.qa` 身份和回环地址。正式客户端使用 `com.silentflower.flower-desktop`。[签名策略](../../../../apps/desktop/scripts/macos-signing.mjs)

## 制品和客户端协议

下表文件名中的 `V` 表示纯版本号。客户端下载更新清单的固定目录为 `https://github.com/SilentFlower/flower/releases/download/flower-desktop-stable/`。Windows 0.1.4 已使用该地址，后续发版须兼容它。

| 平台 | 用户首次安装 | 客户端更新包 | 固定清单 |
| --- | --- | --- | --- |
| Windows x64 | `Flower-Desktop-V-win32-x64-portable.zip` | `Flower-Desktop-V-win32-x64.zip` | `flower-desktop-update.json` |
| Apple Silicon | `Flower-Desktop-V-darwin-arm64.dmg` | `Flower-Desktop-V-darwin-arm64.zip` | `flower-desktop-mac-arm64.json` |
| Intel Mac | `Flower-Desktop-V-darwin-x64.dmg` | `Flower-Desktop-V-darwin-x64.zip` | `flower-desktop-mac-x64.json` |

- Windows 首装 ZIP 顶层提供 `Flower Desktop.exe`、`.flower-desktop-managed` 和 `current.txt`，应用位于 `versions/V/`。更新 ZIP 直接包含该版本的载荷。清单的 `product`、`platform`、`channel` 分别为 `Flower Desktop`、`win32-x64`、`stable`。`version` 和 `download` 标识更新包，`size` 是字节数，`sha256` 是包内容的 SHA-256。[Windows 更新器](../../../../apps/desktop/workbench/desktop-update.mjs)
- Mac 的 DMG 和更新 ZIP 包含相同版本的应用。原生 Squirrel 清单用 `currentRelease` 指定版本，匹配的 `releases[].updateTo.url` 指向稳定频道下**同架构的版本化 ZIP**。[Mac 更新器与清单生成](../../../../apps/desktop/workbench/desktop-update-macos.mjs)

## 发布顺序与完成条件

1. Windows 单独发布时，`verify` 校验首装 ZIP、更新 ZIP 和 Windows 清单。`all` 模式下三个原生构建均须通过，汇总六个二进制文件和三个清单，核对版本、Windows 包的布局和摘要、Mac 应用身份及分架构下载地址。
2. 正式标签的 `publish` 作业独占 `flower-desktop-stable` 并发组，使用 `contents: write`。发布器先比较固定清单和现存的 `.previous` 版本，防止迟到的旧标签使客户端降级。
3. 在版本标签对应的 Release 草稿上传所选平台的制品及 `SHA256SUMS.txt`。各项制品的远端摘要一致后，公开版本页并将其标为最新。
4. 将本轮平台的版本化更新 ZIP 上传到固定频道并核对摘要，再上传本轮有变化的新清单。各平台逐个切换清单，切换时保留前一份为 `.previous`。首发由脚本创建固定频道草稿，制品齐备后公开。这个 Release 需要允许修改附件。
5. 本轮平台的固定清单和它们指向的更新包，远端摘要全部与版本页的对应文件一致，才算投放完成。版本页已经可下载时，频道仍可能处于切换中。[发布器](../../../../apps/desktop/scripts/publish-desktop.py)

## 失败与恢复

| 现场 | 处理 |
| --- | --- |
| 所选架构首装验收失败，或 all 模式下 Mac 签名凭据缺失、公证失败 | 发布作业被阻断。配置问题修正后重跑失败作业。需要改源码时，在修复后的提交上使用新版本标签。 |
| 版本页已经公开，稳定频道只切换了部分平台 | 在同一个标签的 Actions 运行中重跑失败作业。发布器从已公开的版本页取回原制品并复核，再补齐剩余频道。签名重建可能生成不同字节，因此版本页是重试依据。 |
| 单个平台在替换固定名称时失败 | 若固定名称缺失且存在备份，发布器会尝试将 `.previous` 恢复为当前清单。同标签重跑后再核对本轮选定的清单。 |
| 稳定频道已在 `0.1.6`，此时重跑 `0.1.5` | 发布器拒绝降级。若需要撤回有问题的功能，将修复或回退提交作为更高版本发布，例如 `0.1.7`。 |

## 验收

- **Windows** 从首装 ZIP 解压并启动顶层入口，核对实际窗口所属版本。用回环清单演练 `0.0.1 → 0.0.2`，验证后台下载、正常退出安装、版本指针和新版读回旧设置。[首装验收](../../../../apps/desktop/testing/verify-release-windows.ps1) · [升级验收](../../../../apps/desktop/testing/verify-windows-update.mjs)
- **两种 Mac** 分别挂载 DMG 并与 ZIP 中的应用核对架构、版本和资源，启动对应架构的应用。正式标签另验签名、公证票据和两个签名 QA 版本的原位升级，验证升级后可读回旧设置。[制品验收](../../../../apps/desktop/testing/verify-macos-release.mjs) · [升级验收](../../../../apps/desktop/testing/verify-macos-update.mjs)
- **汇总核验** 在仓库根目录执行下面两条命令。`ASSETS_DIR` 指向本轮平台的制品目录，`VERSION` 填对应版本号。第二条命令只读校验本地制品，`RELEASE_TARGET` 填本轮工作流的 `windows` 或 `all`。

  ```sh
  python3 -m unittest discover -s apps/desktop/testing -p 'test_desktop_release.py'
  python3 apps/desktop/scripts/publish-desktop.py "$ASSETS_DIR" "$VERSION" --target "$RELEASE_TARGET"
  ```


## 首装 EXE 和手动更新的 Mac DMG

版本 Release 发布后调用安装包工作流。历史版本使用 `flower-desktop-installers-vX.Y.Z` 补发。Windows 安装器输入为版本页的便携 ZIP 和原始 SHA-256，用户级安装后复用同一顶层启动器和更新指针。验收覆盖安装、开始菜单启动、防止旧包覆盖新指针、卸载与资料保留。两种 Mac 架构从原始源码标签分别组包、临时签名，在各自 runner 验收应用启动、终端与工作区，分发文件名带 `-manual.dmg`，应用内自动更新关闭。

补发选定的全部附件及 `INSTALLER-SHA256SUMS.txt`，保留同名已发布制品作为重试依据。发布器只更新对应版本页，原有 `SHA256SUMS.txt` 和稳定频道独立。运行方式见[安装包工作流](../../../../.github/workflows/desktop-installers.yml)。
