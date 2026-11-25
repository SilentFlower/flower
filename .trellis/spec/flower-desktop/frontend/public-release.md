# Flower Desktop 开源发版规范

本规范约定 `SilentFlower/flower` 如何把一个源码提交发布为 Windows x64、Apple Silicon 和 Intel Mac 三个平台的正式版本，以及已安装的客户端如何找到对应更新。维护者打标签和配置凭据的具体步骤见[发行操作说明](../../../../apps/desktop/RELEASE.md)。

## 触发与版本

| 入口 | 版本来源 | 结果 |
| --- | --- | --- |
| 向 `main` 或 `v2` 提 PR，变动涉及 Desktop、共享运行时、根锁文件或桌面发行工作流 | 固定预演版本 `0.0.1` | 在 Actions 提供三个平台的构建制品 |
| 手工运行 `workflow_dispatch` | 输入 `version`，默认 `0.0.1` | 预演指定版本，制品保存在该次运行 |
| 向开源仓库推送 `flower-desktop-vX.Y.Z` 标签 | 从标签提取 `X.Y.Z` | 通过三端验收后发布版本页并推进稳定频道 |

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

1. 三个原生构建均通过后，`verify` 汇总六个二进制文件和三个清单，核对版本、Windows 包的布局和摘要、Mac 应用身份及分架构下载地址。
2. 正式标签的 `publish` 作业独占 `flower-desktop-stable` 并发组，使用 `contents: write`。发布器先比较固定清单和现存的 `.previous` 版本，防止迟到的旧标签使客户端降级。
3. 在版本标签对应的 Release 草稿上传九项制品及 `SHA256SUMS.txt`。九项制品的远端摘要一致后，公开版本页并将其标为最新。
4. 将三个版本化更新 ZIP 上传到固定频道并核对摘要，再上传本轮有变化的新清单。各平台逐个切换清单，切换时保留前一份为 `.previous`。首发由脚本创建固定频道草稿，制品齐备后公开。这个 Release 需要允许修改附件。
5. 三个固定清单和它们指向的三个更新包，远端摘要全部与版本页的对应文件一致，才算投放完成。版本页已经可下载时，频道仍可能处于切换中。[发布器](../../../../apps/desktop/scripts/publish-desktop.py)

## 失败与恢复

| 现场 | 处理 |
| --- | --- |
| Mac 签名凭据缺失、公证失败，或任一架构首装验收失败 | 发布作业被阻断。配置问题修正后重跑失败作业。需要改源码时，在修复后的提交上使用新版本标签。 |
| 版本页已经公开，稳定频道只切换了部分平台 | 在同一个标签的 Actions 运行中重跑失败作业。发布器从已公开的版本页取回原制品并复核，再补齐剩余频道。签名重建可能生成不同字节，因此版本页是重试依据。 |
| 单个平台在替换固定名称时失败 | 若固定名称缺失且存在备份，发布器会尝试将 `.previous` 恢复为当前清单。同标签重跑后再核对三个清单。 |
| 稳定频道已在 `0.1.6`，此时重跑 `0.1.5` | 发布器拒绝降级。若需要撤回有问题的功能，将修复或回退提交作为更高版本发布，例如 `0.1.7`。 |

## 验收

- **Windows** 从首装 ZIP 解压并启动顶层入口，核对实际窗口所属版本。用回环清单演练 `0.0.1 → 0.0.2`，验证后台下载、正常退出安装、版本指针和新版读回旧设置。[首装验收](../../../../apps/desktop/testing/verify-release-windows.ps1) · [升级验收](../../../../apps/desktop/testing/verify-windows-update.mjs)
- **两种 Mac** 分别挂载 DMG 并与 ZIP 中的应用核对架构、版本和资源，启动对应架构的应用。正式标签另验签名、公证票据和两个签名 QA 版本的原位升级，验证升级后可读回旧设置。[制品验收](../../../../apps/desktop/testing/verify-macos-release.mjs) · [升级验收](../../../../apps/desktop/testing/verify-macos-update.mjs)
- **汇总核验** 在仓库根目录执行下面两条命令。`ASSETS_DIR` 指向汇总三个平台制品后的目录，`VERSION` 填对应版本号。第二条命令只读校验本地制品。

  ```sh
  python3 -m unittest discover -s apps/desktop/testing -p 'test_desktop_release.py'
  python3 apps/desktop/scripts/publish-desktop.py "$ASSETS_DIR" "$VERSION"
  ```
